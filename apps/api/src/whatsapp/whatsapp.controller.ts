import { Controller, Get, Post, Delete, Patch, Body, Param } from "@nestjs/common";
import { WhatsappService } from "./whatsapp.service";
import { Tenant } from "../common/decorators/tenant.decorator";

/** Prefix: /api/whatsapp/* */
@Controller("whatsapp")
export class WhatsappController {
  constructor(private readonly wa: WhatsappService) {}

  @Get("numbers")
  list(@Tenant("tenantId") tenantId: string) {
    return this.wa.list(tenantId);
  }

  @Get("primary")
  getPrimary(@Tenant("tenantId") tenantId: string) {
    return this.wa.getOrCreatePrimary(tenantId);
  }

  @Get("qr")
  getQrDirect(@Tenant("tenantId") tenantId: string) {
    return this.wa.getQr(tenantId);
  }

  @Post("numbers")
  create(@Tenant("tenantId") tenantId: string, @Body() dto: { label?: string; nomor?: string }) {
    return this.wa.create(tenantId, dto);
  }

  @Delete("numbers/:id")
  remove(@Tenant("tenantId") tenantId: string, @Param("id") id: string) {
    return this.wa.remove(tenantId, id);
  }

  @Get("numbers/:id/qr")
  getQr(@Tenant("tenantId") tenantId: string, @Param("id") id: string) {
    return this.wa.getQr(tenantId, id);
  }

  @Post("numbers/:id/disconnect")
  disconnect(@Tenant("tenantId") tenantId: string, @Param("id") id: string) {
    return this.wa.disconnect(tenantId, id);
  }

  @Patch("numbers/:id/auto")
  toggleAuto(
    @Tenant("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() dto: { autoChat?: boolean; autoIklan?: boolean },
  ) {
    return this.wa.toggleAuto(tenantId, id, dto);
  }
}
