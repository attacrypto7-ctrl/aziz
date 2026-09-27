import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Query,
} from "@nestjs/common";
import { AdminService } from "./admin.service";
import { AdminGuard } from "../common/guards/admin.guard";

/**
 * AdminController — endpoint API untuk panel admin.
 * Prefix: /api/admin/*
 *
 * Perlu role "admin" (JWT). Semua endpoint kecuali @Public
 * dilindungi JwtAuthGuard + role check.
 */
@UseGuards(AdminGuard)
@Controller("admin")
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ---- Tenants ----
  @Get("tenants")
  getAllTenants() {
    return this.adminService.getAllTenants();
  }

  @Get("tenants/:id")
  getTenant(@Param("id") id: string) {
    return this.adminService.getTenant(id);
  }

  @Put("tenants/:id")
  updateTenant(
    @Param("id") id: string,
    @Body() body: { status?: string; plan?: string; email?: string },
  ) {
    return this.adminService.updateTenant(id, body);
  }

  @Get("tenants/search")
  searchTenants(@Query("q") q: string) {
    return this.adminService.searchTenants(q);
  }

  // ---- Licenses ----
  @Post("licenses")
  createLicense(
    @Body() body: { tenantId?: string; plan: string; kuotaChat?: number; berakhir: string },
  ) {
    return this.adminService.createLicense(body);
  }

  @Post("licenses/:id/revoke")
  revokeLicense(@Param("id") id: string) {
    return this.adminService.revokeLicense(id);
  }

  @Delete("licenses/:id")
  deleteLicense(@Param("id") id: string) {
    return this.adminService.deleteLicense(id);
  }

  @Get("licenses")
  getAllLicenses(@Query("tenantId") tenantId?: string) {
    return this.adminService.getAllLicenses(tenantId);
  }

  @Get("licenses/:id")
  getLicense(@Param("id") id: string) {
    return this.adminService.getLicense(id);
  }

  @Get("licenses/:id/status")
  getLicenseStatus(@Param("id") id: string) {
    return this.adminService.getLicenseStatus(id);
  }

  // ---- Audit ----
  @Get("audit")
  getAuditLog(
    @Query("limit") limit?: number,
    @Query("tenantId") tenantId?: string,
  ) {
    return this.adminService.getAuditLog(limit, tenantId);
  }
}
