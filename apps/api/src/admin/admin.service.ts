import { Injectable, NotFoundException, Logger } from "@nestjs/common";
import { eq, desc, like, and, gte, lte } from "drizzle-orm";
import { DatabaseService, schema } from "../database/database.service";

/**
 * AdminService — bisnis logika untuk panel admin.
 * Semua query selalu include filter tenant_id untuk isolasi data.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(private db: DatabaseService) {}

  // ---- Tenants ----
  async getAllTenants() {
    const rows = await this.db.db
      .select()
      .from(schema.tenants)
      .orderBy(desc(schema.tenants.createdAt));

    return rows.map((t) => this.formatTenant(t));
  }

  async getTenant(id: string) {
    const tenant = await this.db.db.query.tenants.findFirst({
      where: eq(schema.tenants.id, id),
    });

    if (!tenant) throw new NotFoundException(`Tenant ${id} tidak ditemukan`);
    return this.formatTenant(tenant);
  }

  async updateTenant(id: string, data: { status?: string; plan?: string; email?: string }) {
    const existing = await this.db.db.query.tenants.findFirst({
      where: eq(schema.tenants.id, id),
    });
    if (!existing) throw new NotFoundException(`Tenant ${id} tidak ditemukan`);

    const updates: Record<string, any> = {};
    if (data.status) updates.status = data.status;
    if (data.plan) updates.plan = data.plan;
    if (data.email) updates.email = data.email;

    const [updated] = await this.db.db
      .update(schema.tenants)
      .set(updates)
      .where(eq(schema.tenants.id, id))
      .returning();

    // Audit log
    await this.db.db.insert(schema.auditLog).values({
      tenantId: id,
      aktor: "admin",
      aksi: "Update tenant",
      target: `${id} — ${JSON.stringify(updates)}`,
    });

    return this.formatTenant(updated);
  }

  async searchTenants(q: string) {
    if (!q) return this.getAllTenants();
    const pattern = `%${q}%`;
    const rows = await this.db.db
      .select()
      .from(schema.tenants)
      .where(like(schema.tenants.nama, pattern))
      .orderBy(desc(schema.tenants.createdAt));

    return rows.map((t) => this.formatTenant(t));
  }

  async createLicense(data: { tenantId?: string; plan: string; kuotaChat?: number; berakhir: string }) {
    const cleanTenantId =
      data.tenantId && data.tenantId !== "unassigned" && data.tenantId !== "none" && data.tenantId.trim() !== ""
        ? data.tenantId.trim()
        : null;

    let tenantNama = "Belum Diklaim (Siap Pakai)";
    if (cleanTenantId) {
      try {
        const tenant = await this.db.db.query.tenants.findFirst({
          where: eq(schema.tenants.id, cleanTenantId),
        });
        if (tenant) tenantNama = tenant.nama;
      } catch {
        tenantNama = "Belum Diklaim (Siap Pakai)";
      }
    }

    const kode = generateLicenseCode();
    const [row] = await this.db.db
      .insert(schema.licenses)
      .values({
        kode,
        tenantId: cleanTenantId,
        plan: data.plan as any,
        status: "nonaktif",
        berakhir: new Date(data.berakhir),
        kuotaChat: Number(data.kuotaChat) || 999999,
      })
      .returning();

    await this.db.db.insert(schema.auditLog).values({
      tenantId: cleanTenantId,
      aktor: "admin",
      aksi: "Buat kode lisensi",
      target: `${kode} (${data.plan}, Exp: ${data.berakhir})`,
    });
    return this.formatLicense({ ...row, tenantNama });
  }

  async revokeLicense(id: string) {
    const license = await this.db.db.query.licenses.findFirst({
      where: eq(schema.licenses.id, id),
    });
    if (!license) throw new NotFoundException(`License ${id} tidak ditemukan`);
    const [row] = await this.db.db
      .update(schema.licenses)
      .set({ status: "revoked" })
      .where(eq(schema.licenses.id, id))
      .returning();
    await this.db.db.insert(schema.auditLog).values({
      tenantId: row.tenantId,
      aktor: "admin",
      aksi: "Cabut lisensi",
      target: row.kode,
    });
    return this.formatLicense(row);
  }

  async deleteLicense(id: string) {
    const license = await this.db.db.query.licenses.findFirst({
      where: eq(schema.licenses.id, id),
    });
    if (!license) throw new NotFoundException(`License ${id} tidak ditemukan`);
    await this.db.db
      .delete(schema.licenses)
      .where(eq(schema.licenses.id, id));
    await this.db.db.insert(schema.auditLog).values({
      tenantId: license.tenantId,
      aktor: "admin",
      aksi: "Hapus lisensi",
      target: license.kode,
    });
    return { ok: true };
  }

  async getAllLicenses(tenantId?: string) {
    const conditions: any[] = [];
    if (tenantId) conditions.push(eq(schema.licenses.tenantId, tenantId));

    const rows = await this.db.db
      .select({
        id: schema.licenses.id,
        kode: schema.licenses.kode,
        tenantId: schema.licenses.tenantId,
        tenantNama: schema.tenants.nama,
        plan: schema.licenses.plan,
        status: schema.licenses.status,
        dibuat: schema.licenses.dibuat,
        berakhir: schema.licenses.berakhir,
        kuotaChat: schema.licenses.kuotaChat,
      })
      .from(schema.licenses)
      .leftJoin(schema.tenants, eq(schema.licenses.tenantId, schema.tenants.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.licenses.createdAt));

    return rows.map((l) =>
      this.formatLicense({
        ...l,
        tenantNama: l.tenantNama ?? (l.status === "aktif" ? "Pengguna Aktif" : "Belum Diklaim (Siap Pakai)"),
      }),
    );
  }

  async getLicense(id: string) {
    const license = await this.db.db.query.licenses.findFirst({
      where: eq(schema.licenses.id, id),
      with: { tenants: true },
    });
    if (!license) throw new NotFoundException(`License ${id} tidak ditemukan`);
    return this.formatLicense(license);
  }

  async getLicenseStatus(id: string) {
    const license = await this.db.db.query.licenses.findFirst({
      where: eq(schema.licenses.id, id),
    });
    if (!license) throw new NotFoundException(`License ${id} tidak ditemukan`);
    return { status: license.status };
  }

  // ---- Audit ----
  async getAuditLog(limit?: number, tenantId?: string) {
    const conditions: any[] = [];
    if (tenantId) conditions.push(eq(schema.auditLog.tenantId, tenantId));

    const rows = await this.db.db
      .select()
      .from(schema.auditLog)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.auditLog.waktu))
      .limit(limit || 100);

    return rows.map((a) => ({
      id: a.id,
      aktor: a.aktor,
      aksi: a.aksi,
      target: a.target,
      waktu: a.waktu.toISOString(),
      tenantId: a.tenantId,
    }));
  }

  // ---- Formatters (DB → frontend shape) ----
  private formatTenant(t: any) {
    return {
      id: t.id,
      nama: t.nama,
      industri: t.industri,
      plan: t.plan,
      email: t.email,
      bergabung: t.bergabung.toISOString().split("T")[0],
      status: t.status,
      nomorWa: t.nomorWa,
      chatBulanIni: t.chatBulanIni,
      kuotaChat: t.kuotaChat,
      tokenBulanIni: t.tokenBulanIni,
      lisensiBerakhir: t.lisensiBerakhir?.toISOString().split("T")[0] ?? "",
    };
  }

  private formatLicense(l: any) {    return {
      id: l.id,
      kode: l.kode,
      tenantId: l.tenantId,
      tenantNama: l.tenantNama ?? l.tenants?.nama ?? "",
      plan: l.plan,
      status: l.status,
      dibuat: l.dibuat.toISOString().split("T")[0],
      berakhir: l.berakhir.toISOString().split("T")[0],
      kuotaChat: l.kuotaChat,
    };
  }
}

/** Kode lisensi: XXXX-0000-2027-XXXX (huruf besar + angka, tanpa karakter ambigu). */
function generateLicenseCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const seg = (n: number) =>
    Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${seg(4)}-${seg(4)}-${new Date().getFullYear() + 1}-${seg(4)}`;
}
