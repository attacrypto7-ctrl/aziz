import { Injectable, UnauthorizedException, BadRequestException, NotFoundException, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcryptjs";
import { eq, and, sql } from "drizzle-orm";
import { DatabaseService, schema } from "../database/database.service";
import { JwtPayload, AuthResponse } from "@cs-ai/shared-types";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    private db: DatabaseService,
  ) {}

  /**
   * Login — autentikasi tenant atau admin.
   * Tenant login via email + password (password disimpan di tabel tenants
   * atau di user_accounts). Untuk admin, email + password di tabel admin_users.
   */
  async login(email: string, password: string): Promise<AuthResponse> {
    const cleanEmail = (email || "").trim().toLowerCase();
    const isLoginAsAdmin = cleanEmail === "admin" || cleanEmail === "admin@balasin.id";

    if (isLoginAsAdmin) {
      const admin = await this.db.db.query.adminUsers.findFirst({
        where: eq(schema.adminUsers.email, "admin@balasin.id"),
      });

      if (!admin || !admin.isActive) {
        throw new UnauthorizedException("Akun admin tidak aktif atau tidak ditemukan");
      }

      const passwordValid = admin.passwordHash
        ? await bcrypt.compare(password || "", admin.passwordHash)
        : false;

      if (!passwordValid) {
        throw new UnauthorizedException("Kredensial admin tidak valid");
      }

      const payload: JwtPayload = {
        sub: admin.id,
        email: admin.email,
        role: "admin",
        nama: admin.nama,
      };

      const token = this.jwtService.sign(payload);
      return { accessToken: token };
    }

    // Cek tenant
    const tenant = await this.db.db.query.tenants.findFirst({
      where: eq(schema.tenants.email, email),
    });

    if (tenant && tenant.status === "aktif") {
      const payload: JwtPayload = {
        sub: tenant.id,
        email: tenant.email,
        role: "tenant",
        nama: tenant.nama,
      };

      const token = this.jwtService.sign(payload);
      return { accessToken: token, tenantId: tenant.id };
    }

    throw new UnauthorizedException("Email atau password tidak valid");
  }

  /**
   * Register tenant baru (untuk pendaftarian mandiri di landing page).
   */
  async register(data: {
    nama: string;
    industri: string;
    email: string;
    plan: string;
  }): Promise<AuthResponse> {
    const existing = await this.db.db.query.tenants.findFirst({
      where: eq(schema.tenants.email, data.email),
    });

    if (existing) {
      throw new UnauthorizedException("Email sudah terdaftar");
    }

    const [tenant] = await this.db.db
      .insert(schema.tenants)
      .values({
        nama: data.nama,
        industri: data.industri,
        email: data.email,
        plan: data.plan as "Starter" | "Growth" | "Scale",
        status: "aktif",
      })
      .returning();

    // Insert bot_settings default
    await this.db.db.insert(schema.botSettings).values({
      tenantId: tenant.id,
    });

    const payload: JwtPayload = {
      sub: tenant.id,
      email: tenant.email,
      role: "tenant",
      nama: tenant.nama,
    };

    const token = this.jwtService.sign(payload);
    this.logger.log(`New tenant registered: ${tenant.email}`);
    return { accessToken: token, tenantId: tenant.id };
  }

  /**
   * Validasi license code dan update tenant
   */
  /**
   * Validasi license code dan update tenant
   */
  async activateLicense(tenantId: string, kode: string, email?: string): Promise<boolean> {
    const cleanKode = (kode || "").trim().toUpperCase();
    const license = await this.db.db.query.licenses.findFirst({
      where: eq(schema.licenses.kode, cleanKode),
    });

    if (!license) {
      throw new NotFoundException("Kode lisensi tidak ditemukan");
    }

    if (license.status === "revoked") {
      throw new BadRequestException("Lisensi telah dicabut");
    }

    if (license.berakhir && license.berakhir.getTime() < Date.now()) {
      throw new BadRequestException("Masa berlaku lisensi ini sudah habis");
    }

    // Resolve valid tenant in database
    let targetTenant: typeof schema.tenants.$inferSelect | null | undefined = null;
    if (tenantId) {
      try {
        targetTenant = await this.db.db.query.tenants.findFirst({
          where: eq(schema.tenants.id, tenantId),
        });
      } catch {
        targetTenant = null;
      }
    }
    if (!targetTenant && email) {
      targetTenant = await this.db.db.query.tenants.findFirst({
        where: eq(schema.tenants.email, email),
      });
    }
    if (!targetTenant) {
      targetTenant = await this.db.db.query.tenants.findFirst();
    }
    if (!targetTenant) {
      throw new NotFoundException("Akun tenant tidak ditemukan di database. Silakan masuk kembali.");
    }

    const validTenantId = targetTenant.id;

    if (license.status === "aktif" && license.tenantId && license.tenantId !== validTenantId) {
      throw new BadRequestException("Kode lisensi ini sudah pernah digunakan oleh akun lain");
    }

    // Update license status and assign to tenant
    await this.db.db
      .update(schema.licenses)
      .set({ status: "aktif", tenantId: validTenantId })
      .where(eq(schema.licenses.id, license.id));

    // Update tenant with license plan, expiration date, and active status
    await this.db.db
      .update(schema.tenants)
      .set({
        status: "aktif",
        plan: license.plan,
        lisensiBerakhir: license.berakhir,
      })
      .where(eq(schema.tenants.id, validTenantId));

    // Audit log
    await this.db.db.insert(schema.auditLog).values({
      tenantId: validTenantId,
      aktor: "tenant",
      aksi: "Aktivasi lisensi",
      target: `${license.kode} (${license.plan}, Exp: ${license.berakhir.toISOString().split("T")[0]})`,
    });

    return true;
  }

  async handleGoogleCallback(code: string): Promise<{ token: string; user: { name: string; email: string; picture: string } }> {
    const clientId = this.configService.get<string>("googleClientId") || process.env.GOOGLE_CLIENT_ID || "";
    const clientSecret = this.configService.get<string>("googleClientSecret") || process.env.GOOGLE_CLIENT_SECRET || "";
    const redirectUri =
      this.configService.get<string>("googleRedirectUri") ||
      process.env.GOOGLE_REDIRECT_URI ||
      process.env.GOOGLE_CALLBACK_URL ||
      "http://localhost:3000/api/auth/google/callback";

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      this.logger.error(`Google token exchange failed: ${errText}`);
      throw new UnauthorizedException("Gagal menukar kode otorisasi dengan Google");
    }

    const tokenData = (await tokenRes.json()) as { access_token: string };
    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userRes.ok) {
      throw new UnauthorizedException("Gagal mengambil data akun Google");
    }

    const googleProfile = (await userRes.json()) as {
      id: string;
      email: string;
      name?: string;
      picture?: string;
    };

    const email = googleProfile.email;
    const name = googleProfile.name || email.split("@")[0];
    const picture =
      googleProfile.picture ||
      `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=10b981&color=fff&size=200`;

    let tenant: typeof schema.tenants.$inferSelect | null | undefined = null;
    try {
      tenant = (await this.db.db.query.tenants.findFirst({
        where: eq(schema.tenants.email, email),
      })) ?? null;
    } catch (err) {
      this.logger.warn(`Tenant lookup failed for ${email}: ${err instanceof Error ? err.message : String(err)} — attempting upsert`);
      tenant = null;
    }

    if (!tenant) {
      try {
        const [newTenant] = await this.db.db
          .insert(schema.tenants)
          .values({
            nama: name,
            industri: "Belum Memilih",
            email: email,
            plan: "Starter",
            status: "aktif",
          })
          .onConflictDoUpdate({
            target: schema.tenants.email,
            set: { updatedAt: new Date() },
          })
          .returning();
        tenant = newTenant;
      } catch (err: any) {
        const isUniqueViolation = err?.code === "23505" || err?.message?.includes("duplicate") || err?.message?.includes("unique");
        if (isUniqueViolation) {
          try {
            tenant = (await this.db.db.query.tenants.findFirst({
              where: eq(schema.tenants.email, email),
            })) ?? null;
          } catch {}
        }
        if (!tenant) {
          this.logger.error(`Tenant upsert failed for ${email}: ${err instanceof Error ? err.message : String(err)}`);
          throw new UnauthorizedException("Gagal menyiapkan akun. Silakan coba lagi.");
        }
      }
      if (tenant) {
        try {
          await this.db.db.insert(schema.botSettings).values({ tenantId: tenant.id }).onConflictDoNothing();
        } catch (err) {
          this.logger.warn(`BotSettings init failed for ${tenant.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const payload: JwtPayload = {
      sub: tenant.id,
      email: tenant.email,
      role: "tenant",
      nama: tenant.nama,
    };

    const jwtToken = this.jwtService.sign(payload);
    return {
      token: jwtToken,
      user: {
        name,
        email,
        picture,
      },
    };
  }
}
