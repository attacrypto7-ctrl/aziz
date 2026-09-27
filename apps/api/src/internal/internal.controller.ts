import { Controller, Post, Body, Headers } from "@nestjs/common";
import { Public } from "../common/decorators/public.decorator";
import { InternalService } from "./internal.service";

/**
 * Prefix: /api/internal/* — HANYA untuk wa-gateway & worker (x-internal-secret).
 * Ditandai @Public() agar lolos JwtAuthGuard global; diamankan via secret.
 */
@Controller("internal")
export class InternalController {
  constructor(private readonly internal: InternalService) {}

  @Post("incoming")
  @Public()
  incoming(
    @Headers("x-internal-secret") secret: string,
    @Body() body: { waNumberId: string; nomor: string; kontak?: string; pesan: string; kanal?: "Chat" | "Iklan" },
  ) {
    this.internal.checkSecret(secret);
    return this.internal.incoming(body);
  }

  @Post("reply-result")
  @Public()
  replyResult(
    @Headers("x-internal-secret") secret: string,
    @Body() body: Parameters<InternalService["replyResult"]>[0],
  ) {
    this.internal.checkSecret(secret);
    return this.internal.replyResult(body);
  }

  @Post("wa-status")
  @Public()
  waStatus(
    @Headers("x-internal-secret") secret: string,
    @Body() body: { waNumberId: string; status: string; nomor?: string },
  ) {
    this.internal.checkSecret(secret);
    return this.internal.waStatus(body.waNumberId, body.status, body.nomor);
  }

  @Post("usage")
  @Public()
  usage(
    @Headers("x-internal-secret") secret: string,
    @Body() body: Parameters<InternalService["usage"]>[0],
  ) {
    this.internal.checkSecret(secret);
    return this.internal.usage(body);
  }

  @Post("index-done")
  @Public()
  indexDone(
    @Headers("x-internal-secret") secret: string,
    @Body() body: { docId: string; ok: boolean; chunks: number },
  ) {
    this.internal.checkSecret(secret);
    return this.internal.indexDone(body.docId, body.ok, body.chunks);
  }
}
