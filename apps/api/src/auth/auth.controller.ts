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
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"><title>Autentikasi Gagal</title></head>
          <body style="font-family: sans-serif; background: #090d16; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
            <div style="text-align: center;">
              <p style="color: #ef4444; font-size: 16px;">Tidak ada kode otorisasi.</p>
            </div>
            <script>
              try {
                if (window.opener) {
                  window.opener.postMessage({ type: 'GOOGLE_AUTH_ERROR', message: 'Tidak ada kode otorisasi' }, '*');
                }
              } catch (e) {}
              setTimeout(() => {
                window.close();
                window.location.href = ${JSON.stringify(clientOrigin)};
              }, 1000);
            </script>
          </body>
          </html>
        `);
      }

      const result = await this.authService.handleGoogleCallback(code);
      const redirectTarget = `${clientOrigin}/auth/callback?token=${encodeURIComponent(
        result.token,
      )}&name=${encodeURIComponent(result.user.name)}&email=${encodeURIComponent(
        result.user.email,
      )}&picture=${encodeURIComponent(result.user.picture)}`;

      // Kirim hasil lewat postMessage ke window opener, coba tutup popup, atau fallback redirect
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Autentikasi Berhasil</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              background-color: #090d16;
              color: #f8fafc;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
            }
            .card {
              text-align: center;
              padding: 32px 24px;
              background: rgba(30, 41, 59, 0.7);
              border: 1px solid rgba(255, 255, 255, 0.1);
              border-radius: 16px;
              box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
              max-width: 360px;
              width: 88%;
            }
            .spinner {
              width: 36px;
              height: 36px;
              border: 3px solid rgba(16, 185, 129, 0.2);
              border-top-color: #10b981;
              border-radius: 50%;
              animation: spin 0.8s linear infinite;
              margin: 0 auto 16px;
            }
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
            h2 {
              margin: 0 0 8px;
              font-size: 1.25rem;
              color: #10b981;
            }
            p {
              margin: 0 0 16px;
              font-size: 0.875rem;
              color: #94a3b8;
            }
            .btn {
              display: inline-block;
              padding: 10px 20px;
              background: #10b981;
              color: #ffffff;
              border-radius: 8px;
              text-decoration: none;
              font-size: 0.875rem;
              font-weight: 600;
              transition: background 0.2s;
            }
            .btn:hover {
              background: #059669;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="spinner"></div>
            <h2>Login Berhasil!</h2>
            <p>Mengalihkan ke dashboard...</p>
            <a href="${redirectTarget}" class="btn">Masuk ke Dashboard</a>
          </div>
          <script>
            var targetUrl = ${JSON.stringify(redirectTarget)};
            var notifiedOpener = false;
            try {
              if (window.opener && !window.opener.closed) {
                window.opener.postMessage({
                  type: 'GOOGLE_AUTH_SUCCESS',
                  token: ${JSON.stringify(result.token)},
                  user: ${JSON.stringify(result.user)}
                }, '*');
                notifiedOpener = true;
              }
            } catch (e) {
              console.error(e);
            }

            if (notifiedOpener) {
              setTimeout(function() {
                try {
                  window.close();
                } catch (e) {}
                setTimeout(function() {
                  window.location.replace(targetUrl);
                }, 500);
              }, 300);
            } else {
              window.location.replace(targetUrl);
            }
          </script>
        </body>
        </html>
      `);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Autentikasi Google gagal";
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>Autentikasi Gagal</title></head>
        <body style="font-family: sans-serif; background: #090d16; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
          <div style="text-align: center; padding: 24px;">
            <h3 style="color: #ef4444; margin: 0 0 8px;">Login Gagal</h3>
            <p style="color: #94a3b8; font-size: 14px;">${msg}</p>
          </div>
          <script>
            try {
              if (window.opener && !window.opener.closed) {
                window.opener.postMessage({
                  type: 'GOOGLE_AUTH_ERROR',
                  message: ${JSON.stringify(msg)}
                }, '*');
              }
            } catch (e) {}
            setTimeout(() => {
              window.close();
              window.location.href = ${JSON.stringify(clientOrigin)};
            }, 1200);
          </script>
        </body>
        </html>
      `);
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
