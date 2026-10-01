import { Injectable, Logger } from "@nestjs/common";
import { eq, desc, and } from "drizzle-orm";
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

    // Jika tidak ada lisensi di database, kembalikan array kosong.
    // Lisensi hanya bisa aktif melalui kode resmi dari Admin.
    if (rows.length === 0) return [];

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

    // Lisensi hanya sah dan aktif jika ada record resmi di tabel licenses (dibuat oleh Admin).
    // Tanpa kode lisensi resmi dari Admin, status akun tetap "belum_aktif".
    const activeLicense = await this.db.db.query.licenses.findFirst({
      where: and(
        eq(schema.licenses.tenantId, tenant.id),
        eq(schema.licenses.status, "aktif"),
      ),
      orderBy: desc(schema.licenses.berakhir),
    });

    if (!activeLicense) {
      // Cek apakah ada riwayat lisensi yang revoked / expired
      const lastLicense = await this.db.db.query.licenses.findFirst({
        where: eq(schema.licenses.tenantId, tenant.id),
        orderBy: desc(schema.licenses.createdAt),
      });

      if (lastLicense) {
        const isPast = lastLicense.berakhir.getTime() < Date.now();
        return {
          plan: lastLicense.plan,
          status: lastLicense.status === "revoked" ? "revoked" : (isPast ? "expired" : "belum_aktif"),
          totalChatDibalas: tenant.chatBulanIni ?? 0,
          chatBulanIni: tenant.chatBulanIni ?? 0,
          lisensiBerakhir: lastLicense.berakhir.toISOString(),
          isActive: false,
          kode: lastLicense.kode,
        };
      }

      // User sama sekali belum memiliki lisensi resmi dari Admin
      return {
        plan: "Starter",
        status: "belum_aktif",
        totalChatDibalas: tenant.chatBulanIni ?? 0,
        chatBulanIni: tenant.chatBulanIni ?? 0,
        lisensiBerakhir: null,
        isActive: false,
        kode: null,
      };
    }

    const isExpired = activeLicense.berakhir.getTime() < Date.now();
    const isActive = !isExpired && tenant.status === "aktif";

    return {
      plan: activeLicense.plan,
      status: isActive ? "aktif" : "expired",
      totalChatDibalas: tenant.chatBulanIni ?? 0,
      chatBulanIni: tenant.chatBulanIni ?? 0,
      lisensiBerakhir: activeLicense.berakhir.toISOString(),
      isActive,
      kode: activeLicense.kode,
    };
  }
}

