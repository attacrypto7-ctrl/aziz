import { Controller, Post, Body, UseGuards, Request, Get, Query, Res, Req } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { Public } from "../common/decorators/public.decorator";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { ConfigService } from "@nestjs/config";
import { Response } from "express";

@Controller("auth")
@UseGuards(JwtAuthGuard)
export class AuthController {
  constructor(private readonly authService: AuthService, private config: ConfigService) {}

  @Get("google")
  @Public()
  async googleAuth(
    @Query("origin") origin: string,
    @Res() res: Response,
  ) {
    const clientId = this.config.get<string>("googleClientId") || process.env.GOOGLE_CLIENT_ID || "";
    const redirectUri =
      this.config.get<string>("googleRedirectUri") ||
      process.env.GOOGLE_REDIRECT_URI ||
      process.env.GOOGLE_CALLBACK_URL ||
      "http://localhost:3000/api/auth/google/callback";

    const defaultFrontend = this.config.get<string>("frontendUrl") || "http://localhost:8080";
    const clientOrigin = origin || defaultFrontend;
    const stateObj = { origin: clientOrigin };
    const state = Buffer.from(JSON.stringify(stateObj)).toString("base64url");

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(
      clientId,
    )}&redirect_uri=${encodeURIComponent(
      redirectUri,
    )}&response_type=code&scope=openid%20email%20profile&access_type=offline&prompt=consent&state=${encodeURIComponent(
      state,
    )}`;

    return res.redirect(authUrl);
  }

  @Get("google/callback")
  @Public()
  async googleCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Res() res: Response,
  ) {
    let clientOrigin = this.config.get<string>("frontendUrl") || "http://localhost:8080";
    try {
      if (state) {
        const decoded = JSON.parse(Buffer.from(state, "base64url").toString("utf-8"));
        if (decoded.origin) clientOrigin = decoded.origin;
      }
    } catch {
      void 0;
    }
    clientOrigin = clientOrigin.replace(/\/$/, "");

    try {
      if (!code) {
        return res.redirect(`${clientOrigin}/?error=${encodeURIComponent("Tidak ada kode otorisasi")}`);
      }

      const result = await this.authService.handleGoogleCallback(code);
      const redirectTarget = `${clientOrigin}/auth/callback?token=${encodeURIComponent(
        result.token,
      )}&name=${encodeURIComponent(result.user.name)}&email=${encodeURIComponent(
        result.user.email,
      )}&picture=${encodeURIComponent(result.user.picture)}`;

      return res.redirect(redirectTarget);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Autentikasi Google gagal";
      return res.redirect(`${clientOrigin}/?error=${encodeURIComponent(msg)}`);
    }
  }

  @Post("login")
  @Public()
  async login(
    @Body() body: { email: string; password?: string },
  ) {
    return this.authService.login(body.email, body.password ?? "");
  }

  @Post("register")
  @Public()
  async register(
    @Body() body: { nama: string; industri: string; email: string; plan: string },
  ) {
    return this.authService.register(body);
  }

  @Post("activate-license")
  async activateLicense(
    @Request() req: any,
    @Body() body: { kode: string },
  ) {
    const tenantId = req.user.tenantId ?? req.user.sub;
    return { success: await this.authService.activateLicense(tenantId, body.kode) };
  }
}
