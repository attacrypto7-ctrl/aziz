import { Controller, Get, Patch, Body } from "@nestjs/common";
import { TenantService } from "./tenant.service";
import { Tenant } from "../common/decorators/tenant.decorator";

/** Prefix: /api/tenant/* — profil tenant, tipe bisnis, dan skor kesiapan AI */
@Controller("tenant")
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  @Get("me")
  getMe(@Tenant("tenantId") tenantId: string) {
    return this.tenantService.getMe(tenantId);
  }

  @Patch("business-type")
  updateBusinessType(
    @Tenant("tenantId") tenantId: string,
    @Body() dto: { businessType?: string; industri?: string; tipeBisnis?: string },
  ) {
    const val = dto.businessType || dto.tipeBisnis || dto.industri || "";
    return this.tenantService.updateBusinessType(tenantId, val);
  }

  @Get("readiness-score")
  getReadinessScore(@Tenant("tenantId") tenantId: string) {
    return this.tenantService.getReadinessScore(tenantId);
  }
}
