import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import pino from "pino";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
} from "@whiskeysockets/baileys";

// Status per nomor: socket aktif + QR terakhir (base64 data URL untuk dashboard)
interface Session {
  sock: WASocket | null;
  qr: string | null;
  status: "tersambung" | "memindai" | "terputus";
}

const sessions = new Map<string, Session>();

function sessionDir(waNumberId: string): string {
  const base = process.env.WA_SESSION_VOLUME_PATH || path.resolve(process.cwd(), "tmp", "wa-sessions");
  const dir = path.join(base, waNumberId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function apiBase(): string {
  return (process.env.INTERNAL_API_URL || "http://localhost:3000/api").replace(/\/$/, "");
}
function internalHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "x-internal-secret": process.env.INTERNAL_SECRET ?? "" };
}

async function pushStatus(waNumberId: string, status: string, nomor?: string): Promise<void> {
  const s = sessions.get(waNumberId);
  if (s) s.status = status as Session["status"];
  await fetch(`${apiBase()}/internal/wa-status`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({ waNumberId, status, nomor }),
  }).catch(() => undefined);
}

/** Terima pesan masuk → teruskan ke api (yang memvalidasi kuota & enqueue worker). */
async function pushIncoming(
  waNumberId: string,
  nomor: string,
  kontak: string | undefined,
  pesan: string,
  kanal?: "Chat" | "Iklan",
): Promise<void> {
  await fetch(`${apiBase()}/internal/incoming`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({ waNumberId, nomor, kontak, pesan, kanal }),
  }).catch((e) => console.error("[wa] incoming gagal:", (e as Error).message));
}

function textOf(msg: any): string | null {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    null
  );
}

/** Buat / sambung ulang sesi Baileys untuk satu wa_number. */
export async function connect(waNumberId: string): Promise<void> {
  const existing = sessions.get(waNumberId);
  if (existing?.sock) return;

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir(waNumberId));

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["CS AI SaaS", "Chrome", "1.0"],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 15000,
  });

  sessions.set(waNumberId, { sock, qr: existing?.qr ?? null, status: "memindai" });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr);
        sessions.set(waNumberId, { sock, qr: dataUrl, status: "memindai" });
        await pushStatus(waNumberId, "memindai");
        console.log(`[wa] ${waNumberId} QR siap dipindai!`);
      } catch (e) {
        console.error("[wa] gagal membuat data URL QR:", e);
      }
    }
    if (connection === "open") {
      const phone = (sock.user?.id || "").replace(/:.*$/, "").replace(/@.*$/, "");
      sessions.set(waNumberId, { sock, qr: null, status: "tersambung" });
      await pushStatus(waNumberId, "tersambung", phone || undefined);
      console.log(`[wa] ${waNumberId} tersambung (nomor: ${phone})`);
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error as any)?.output?.statusCode;
      sessions.set(waNumberId, { sock: null, qr: null, status: "terputus" });
      await pushStatus(waNumberId, "terputus");
      // Reconnect otomatis kecuali logout eksplisit (401)
      if (code !== DisconnectReason.loggedOut) {
        console.log(`[wa] ${waNumberId} terputus (code ${code}), reconnect 5 dtk...`);
        setTimeout(() => connect(waNumberId).catch(console.error), 5000);
      } else {
        try {
          fs.rmSync(sessionDir(waNumberId), { recursive: true, force: true });
        } catch {}
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const teks = textOf(msg);
      if (!teks) continue;
      const nomor = (msg.key.remoteJid ?? "").replace(/@.*$/, "");
      const kontak = msg.pushName || nomor;
      const isAdContext = Boolean(
        msg.message?.extendedTextMessage?.contextInfo?.externalAdReply ||
        (msg.message as any)?.contextInfo?.externalAdReply,
      );
      await pushIncoming(waNumberId, nomor, kontak, teks, isAdContext ? "Iklan" : undefined);
    }
  });
}

export async function disconnect(waNumberId: string): Promise<void> {
  const s = sessions.get(waNumberId);
  try {
    await s?.sock?.logout();
  } catch { /* abaikan */ }
  sessions.set(waNumberId, { sock: null, qr: null, status: "terputus" });
  await pushStatus(waNumberId, "terputus");
}

export function getQr(waNumberId: string): { qr: string | null; status: string } {
  const s = sessions.get(waNumberId);
  return { qr: s?.qr ?? null, status: s?.status ?? "terputus" };
}

/** Tunggu sebentar hingga QR pertama di-generate oleh WhatsApp server jika belum ada. */
export async function getQrWithWait(waNumberId: string, timeoutMs = 4000): Promise<{ qr: string | null; status: string }> {
  await connect(waNumberId).catch((err) => console.error("[wa-gateway] connect error:", err));
  const current = getQr(waNumberId);
  if (current.qr || current.status === "tersambung") return current;

  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const s = getQr(waNumberId);
      if (s.qr || s.status === "tersambung" || Date.now() - start >= timeoutMs) {
        clearInterval(interval);
        resolve(s);
      }
    }, 200);
  });
}

export function getSocket(waNumberId: string): WASocket | null {
  return sessions.get(waNumberId)?.sock ?? null;
}

/** Kirim pesan teks via socket aktif. */
export async function sendText(waNumberId: string, nomor: string, pesan: string): Promise<void> {
  const sock = getSocket(waNumberId);
  if (!sock) throw new Error(`Sesi ${waNumberId} tidak tersambung`);
  const jid = nomor.includes("@") ? nomor : `${nomor}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: pesan });
}

/** Kirim pesan teks, gambar, atau video via socket aktif. */
export async function sendMediaOrText(
  waNumberId: string,
  nomor: string,
  options: { pesan?: string; mediaUrl?: string; mediaType?: "image" | "video"; caption?: string },
): Promise<void> {
  const sock = getSocket(waNumberId);
  if (!sock) throw new Error(`Sesi ${waNumberId} tidak tersambung`);
  const jid = nomor.includes("@") ? nomor : `${nomor}@s.whatsapp.net`;

  if (options.mediaUrl) {
    let source: any = { url: options.mediaUrl };
    // Jika path lokal atau URL relatif backend
    if (!options.mediaUrl.startsWith("http://") && !options.mediaUrl.startsWith("https://")) {
      const apiHost = process.env.API_URL || process.env.INTERNAL_API_URL || "http://localhost:3000";
      const cleanHost = apiHost.replace(/\/api$/, "").replace(/\/$/, "");
      if (options.mediaUrl.startsWith("/")) {
        source = { url: `${cleanHost}${options.mediaUrl}` };
      } else {
        const localPath = path.isAbsolute(options.mediaUrl)
          ? options.mediaUrl
          : path.resolve(process.cwd(), options.mediaUrl);
        if (fs.existsSync(localPath)) {
          source = fs.readFileSync(localPath);
        }
      }
    }

    const isVideo =
      options.mediaType === "video" || Boolean(options.mediaUrl.match(/\.(mp4|3gp|mov|webm)$/i));

    if (isVideo) {
      await sock.sendMessage(jid, {
        video: source,
        caption: options.caption || (options.pesan && !options.pesan.startsWith("[Video") ? options.pesan : undefined),
      });
      return;
    } else {
      await sock.sendMessage(jid, {
        image: source,
        caption: options.caption || (options.pesan && !options.pesan.startsWith("[Gambar") ? options.pesan : undefined),
      });
      return;
    }
  }

  if (options.pesan) {
    await sock.sendMessage(jid, { text: options.pesan });
  }
}
