import { Injectable, Logger } from "@nestjs/common";
import { eq, desc } from "drizzle-orm";
import { DatabaseService, schema } from "../database/database.service";
import { AuthService } from "../auth/auth.service";

/** LicenseService — sisi tenant: lihat lisensi sendiri + aktivasi kode. */
@Injectable()
export class LicenseService {
  private readonly logger = new Logger(LicenseService.name);

  constructor(
    private db: DatabaseService,
    private authService: AuthService,
  ) {}

  private async resolveTenant(tenantId?: string, email?: string) {
    if (tenantId) {
      try {
        const tenant = await this.db.db.query.tenants.findFirst({
          where: eq(schema.tenants.id, tenantId),
        });
        if (tenant) return tenant;
      } catch {}
    }
    if (email) {
      try {
        const tenant = await this.db.db.query.tenants.findFirst({
          where: eq(schema.tenants.email, email),
        });
        if (tenant) return tenant;
      } catch {}
    }
    try {
      return (await this.db.db.query.tenants.findFirst()) ?? null;
    } catch {
      return null;
    }
  }

  async myLicenses(tenantId: string, email?: string) {
    const tenant = await this.resolveTenant(tenantId, email);
    if (!tenant) return [];

    const rows = await this.db.db
      .select()
      .from(schema.licenses)
      .where(eq(schema.licenses.tenantId, tenant.id))
      .orderBy(desc(schema.licenses.createdAt));

    if (rows.length === 0 && tenant.lisensiBerakhir) {
      const isExpired = tenant.lisensiBerakhir.getTime() < Date.now();
      return [
        {
          id: `lic-tenant-${tenant.id}`,
          kode: "LISENSI-AKTIF",
          tenantId: tenant.id,
          tenantNama: tenant.nama,
          plan: tenant.plan,
          status: isExpired ? "expired" : (tenant.status === "aktif" ? "aktif" : "nonaktif"),
          dibuat: tenant.createdAt ? tenant.createdAt.toISOString().split("T")[0] : new Date().toISOString().split("T")[0],
          berakhir: tenant.lisensiBerakhir.toISOString().split("T")[0],
          kuotaChat: tenant.kuotaChat ?? 999999,
        },
      ];
    }

    return rows.map((l) => ({
      id: l.id,
      kode: l.kode,
      tenantId: l.tenantId,
      tenantNama: tenant.nama,
      plan: l.plan,
      status: l.status,
      dibuat: l.dibuat.toISOString().split("T")[0],
      berakhir: l.berakhir.toISOString().split("T")[0],
      kuotaChat: l.kuotaChat,
    }));
  }

  async activate(tenantId: string, kode: string, email?: string) {
    const ok = await this.authService.activateLicense(tenantId, kode, email);
    return { success: ok };
  }

  async status(tenantId: string, email?: string) {
    const tenant = await this.resolveTenant(tenantId, email);
    if (!tenant) {
      return {
        plan: "Starter",
        status: "belum_aktif",
        totalChatDibalas: 0,
        chatBulanIni: 0,
        lisensiBerakhir: null,
        isActive: false,
        kode: null,
      };
    }

    const isExpired = !tenant.lisensiBerakhir || tenant.lisensiBerakhir.getTime() < Date.now();
    const isActive = tenant.status === "aktif" && !isExpired;
    const lastLicense = await this.db.db.query.licenses.findFirst({
      where: eq(schema.licenses.tenantId, tenant.id),
      orderBy: desc(schema.licenses.createdAt),
    });

    return {
      plan: tenant.plan,
      status: isActive ? "aktif" : (tenant.lisensiBerakhir ? "expired" : "belum_aktif"),
      totalChatDibalas: tenant.chatBulanIni ?? 0,
      chatBulanIni: tenant.chatBulanIni ?? 0,
      lisensiBerakhir: tenant.lisensiBerakhir?.toISOString() ?? null,
      isActive,
      kode: lastLicense?.kode ?? null,
    };
  }
}

