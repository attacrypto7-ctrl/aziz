import { Injectable, NotFoundException, BadRequestException, Logger } from "@nestjs/common";
import { eq, and } from "drizzle-orm";
import { ConfigService } from "@nestjs/config";
import { DatabaseService, schema } from "../database/database.service";
import { QueueService } from "../queue/queue.service";

/**
 * WhatsappService — CRUD nomor WA tenant + jembatan ke wa-gateway.
 * Aturan bisnis: 1 Akun (Tenant) hanya memiliki 1 nomor WhatsApp.
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private db: DatabaseService,
    private queueService: QueueService,
    private configService: ConfigService,
  ) {}

  async list(tenantId: string) {
    const validId = await this.resolveTenantId(tenantId);
    const rows = await this.db.db
      .select()
      .from(schema.waNumbers)
      .where(eq(schema.waNumbers.tenantId, validId));
    return rows.map((w) => this.format(w));
  }

  /**
   * Mengambil nomor WhatsApp tenant atau membuat slot nomor utama jika belum ada (1 Akun = 1 Nomor).
   */
  async getOrCreatePrimary(tenantId: string, label = "Nomor WhatsApp CS") {
    const validId = await this.resolveTenantId(tenantId);
    const existing = await this.db.db.query.waNumbers.findFirst({
      where: eq(schema.waNumbers.tenantId, validId),
    });
    if (existing) return this.format(existing);

    const [row] = await this.db.db
      .insert(schema.waNumbers)
      .values({
        tenantId: validId,
        label,
        nomor: "Belum terhubung",
        status: "terputus",
      })
      .returning();

    try {
      await this.db.db.insert(schema.auditLog).values({
        tenantId: validId,
        aktor: "tenant",
        aksi: "Inisialisasi nomor WA",
        target: label,
      });
    } catch {}
    return this.format(row);
  }

  async create(tenantId: string, dto: { label?: string; nomor?: string }) {
    const validId = await this.resolveTenantId(tenantId);
    const existing = await this.db.db.query.waNumbers.findFirst({
      where: eq(schema.waNumbers.tenantId, validId),
    });

    if (existing) {
      throw new BadRequestException(
        "Satu akun hanya dapat menghubungkan 1 nomor WhatsApp. Silakan putuskan atau hapus nomor yang ada jika ingin mengganti.",
      );
    }

    const label = dto.label?.trim() || "Nomor WhatsApp CS";
    const nomor = dto.nomor?.trim() || "Belum terhubung";

    const [row] = await this.db.db
      .insert(schema.waNumbers)
      .values({ tenantId: validId, label, nomor, status: "terputus" })
      .returning();
    try {
      await this.db.db.insert(schema.auditLog).values({
        tenantId: validId,
        aktor: "tenant",
        aksi: "Tambah nomor WA",
        target: nomor,
      });
    } catch {}
    return this.format(row);
  }

  async remove(tenantId: string, id: string) {
    const validId = await this.resolveTenantId(tenantId);
    const existing = await this.findOwned(validId, id);
    // Minta wa-gateway logout sesi juga (best-effort)
    await this.callGateway(`/wa/${id}/logout`, "POST").catch(() => undefined);
    await this.db.db.delete(schema.waNumbers).where(eq(schema.waNumbers.id, id));
    return { success: true, id: existing.id };
  }

  /** Minta QR pairing ke wa-gateway untuk ditampilkan di dashboard. */
  async getQr(tenantId: string, id?: string) {
    const validId = await this.resolveTenantId(tenantId);
    let waNumberId = id;
    if (!waNumberId) {
      const primary = await this.getOrCreatePrimary(validId);
      waNumberId = primary.id;
    } else {
      await this.findOwned(validId, waNumberId);
    }

    const data = await this.callGateway(`/wa/${waNumberId}/qr`, "GET");
    if (!data) {
      return {
        qr: null,
        status: "gateway_offline",
        waNumberId,
        message: "Service gateway WhatsApp (port 3002) belum aktif.",
      };
    }
    return {
      ...data,
      waNumberId,
    };
  }

  async disconnect(tenantId: string, id: string) {
    const validId = await this.resolveTenantId(tenantId);
    const [row] = await this.db.db
      .update(schema.waNumbers)
      .set({ status: "terputus" })
      .where(and(eq(schema.waNumbers.id, id), eq(schema.waNumbers.tenantId, validId)))
      .returning();
    if (!row) throw new NotFoundException("Nomor tidak ditemukan");
    await this.callGateway(`/wa/${id}/logout`, "POST").catch(() => undefined);
    return this.format(row);
  }

  async toggleAuto(tenantId: string, id: string, dto: { autoChat?: boolean; autoIklan?: boolean }) {
    const validId = await this.resolveTenantId(tenantId);
    const [row] = await this.db.db
      .update(schema.waNumbers)
      .set({ ...(dto.autoChat !== undefined ? { autoChat: dto.autoChat } : {}), ...(dto.autoIklan !== undefined ? { autoIklan: dto.autoIklan } : {}) })
      .where(and(eq(schema.waNumbers.id, id), eq(schema.waNumbers.tenantId, validId)))
      .returning();
    if (!row) throw new NotFoundException("Nomor tidak ditemukan");
    return this.format(row);
  }

  private async resolveTenantId(tenantId: string): Promise<string> {
    try {
      const tenant = await this.db.db.query.tenants.findFirst({
        where: eq(schema.tenants.id, tenantId),
      });
      if (tenant) return tenant.id;
      const fallback = await this.db.db.query.tenants.findFirst();
      if (fallback) return fallback.id;
    } catch {}
    return tenantId;
  }

  private async findOwned(tenantId: string, id: string) {
    const validId = await this.resolveTenantId(tenantId);
    const row = await this.db.db.query.waNumbers.findFirst({
      where: and(eq(schema.waNumbers.id, id), eq(schema.waNumbers.tenantId, validId)),
    });
    if (!row) throw new NotFoundException("Nomor tidak ditemukan");
    return row;
  }

  private async callGateway(path: string, method: string) {
    const base = this.configService.get<string>("internalApiUrl") ?? "";
    const gatewayBase = (process.env.WA_GATEWAY_URL || this.configService.get<string>("waGatewayUrl") || base.replace(":3000", ":3002")).replace(/\/api$/, "");
    const secret = this.configService.get<string>("internalSecret") || process.env.INTERNAL_SECRET || "balasin-internal-secret-auth-key-2026";
    try {
      const res = await fetch(`${gatewayBase}${path}`, {
        method,
        headers: { "x-internal-secret": secret },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.logger.warn(`wa-gateway error (${res.status}): ${text || res.statusText}`);
        return null;
      }
      return await res.json();
    } catch (err: any) {
      this.logger.warn(`[wa-gateway] Gateway offline pada ${gatewayBase} (${err?.message || err})`);
      return null;
    }
  }

  private format(w: any) {
    return {
      id: w.id,
      tenantId: w.tenantId,
      label: w.label,
      nomor: w.nomor,
      status: w.status,
      terakhirAktif: w.terakhirAktif?.toISOString() ?? "",
      autoChat: w.autoChat,
      autoIklan: w.autoIklan,
    };
  }
}
