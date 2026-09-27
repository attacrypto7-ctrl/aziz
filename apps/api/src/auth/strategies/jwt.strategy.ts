import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { eq } from "drizzle-orm";
import { JwtPayload } from "@cs-ai/shared-types";
import { DatabaseService, schema } from "../../database/database.service";

/**
 * JwtStrategy — memvalidasi token JWT dan mengembalikan payload user.
 * Payload berisi: sub (id), email, role, nama, tenantId.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    configService: ConfigService,
    private readonly db: DatabaseService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>("jwtSecret") || "dev-secret-change-me",
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload & { tenantId?: string }> {
    const result: JwtPayload & { tenantId?: string } = {
      sub: payload.sub,
      email: payload.email,
      role: payload.role,
      nama: payload.nama,
    };

    // Untuk tenant, pastikan ID tenant valid di database
    if (payload.role === "tenant") {
      let validTenantId = payload.sub;
      try {
        let tenant = await this.db.db.query.tenants.findFirst({
          where: eq(schema.tenants.id, payload.sub),
        });

        if (!tenant && payload.email) {
          tenant = await this.db.db.query.tenants.findFirst({
            where: eq(schema.tenants.email, payload.email),
          });
        }

        if (!tenant && payload.email) {
          const [newTenant] = await this.db.db
            .insert(schema.tenants)
            .values({
              nama: payload.nama || payload.email.split("@")[0],
              industri: "Lainnya",
              email: payload.email,
              plan: "Starter",
              status: "aktif",
            })
            .returning();
          tenant = newTenant;

          try {
            await this.db.db.insert(schema.botSettings).values({ tenantId: tenant.id }).onConflictDoNothing();
          } catch {}
        }

        if (tenant) {
          validTenantId = tenant.id;
          result.nama = tenant.nama;
          result.email = tenant.email;
        }
      } catch (err) {
        this.logger.warn(`Tenant resolution in JwtStrategy failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      result.tenantId = validTenantId;
      result.sub = validTenantId;
    }

    return result;
  }
}

