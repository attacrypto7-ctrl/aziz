import { initDb, getDb } from "@cs-ai/database";
import { GroqClient } from "@cs-ai/groq-client";

// Klien DB singleton untuk worker
export function initWorkerDb(): void {
  const defaultUrl = "postgresql://postgres:postgres@localhost:5432/chatbot_db?schema=public";
  const url = process.env.DATABASE_URL || defaultUrl;
  if (!process.env.DATABASE_URL) {
    console.warn(`[worker] DATABASE_URL not set — using fallback ${defaultUrl}`);
  }
  try {
    initDb(url);
  } catch (err) {
    const isDev = (process.env.NODE_ENV || "development") !== "production";
    console.error("[worker] DB init failed:", err instanceof Error ? err.message : String(err));
    if (!isDev) throw err;
    console.warn("[worker] dev mode — continuing without DB");
  }
}

export function db() {
  return getDb();
}

// Klien AI (Groq / DeepSeek — satu key untuk seluruh platform — rate-limit per tenant di api)
let groqClient: GroqClient | null = null;
export function groq(): GroqClient | null {
  const key = process.env.AI_API_KEY || process.env.GROQ_API_KEY;
  if (!key) return null;
  if (!groqClient) {
    groqClient = new GroqClient({
      apiKey: key,
      baseURL: process.env.AI_BASE_URL,
    });
  }
  return groqClient;
}

const internalBase = () => (process.env.INTERNAL_API_URL || "http://localhost:3000/api").replace(/\/$/, "");
const internalHeaders = () => ({
  "Content-Type": "application/json",
  "x-internal-secret": process.env.INTERNAL_SECRET ?? "",
});

/** Laporkan hasil balasan ke api (disimpan + diantrekan ke wa-gateway). */
export async function reportReply(data: {
  tenantId: string;
  waNumberId: string;
  nomor: string;
  kontak?: string;
  pesanAsli: string;
  balasan: string;
  mediaUrl?: string;
  mediaType?: "image" | "video";
  keyakinan: number;
  status: string;
  kanal: "Chat" | "Iklan";
}): Promise<void> {
  await fetch(`${internalBase()}/internal/reply-result`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify(data),
  });
}

/** Catat pemakaian token untuk rate-limit & analitik. */
export async function reportUsage(data: {
  tenantId: string; model: string; tokensInput: number; tokensOutput: number; costCents?: number;
}): Promise<void> {
  await fetch(`${internalBase()}/internal/usage`, {
    method: "POST", headers: internalHeaders(), body: JSON.stringify(data),
  }).catch(() => undefined);
}

/** Laporkan hasil indexing dokumen. */
export async function reportIndex(docId: string, ok: boolean, chunks: number): Promise<void> {
  await fetch(`${internalBase()}/internal/index-done`, {
    method: "POST", headers: internalHeaders(), body: JSON.stringify({ docId, ok, chunks }),
  }).catch(() => undefined);
}
