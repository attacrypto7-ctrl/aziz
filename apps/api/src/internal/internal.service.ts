import { Injectable, UnauthorizedException } from "@nestjs/common";
import { eq, and } from "drizzle-orm";
import { DatabaseService, schema } from "../database/database.service";
import { QueueService } from "../queue/queue.service";

/**
 * InternalService — endpoint privat untuk wa-gateway & worker.
 * Diamankan via header x-internal-secret (INTERNAL_SECRET), bukan JWT.
 */
@Injectable()
export class InternalService {
  constructor(
    private db: DatabaseService,
    private queue: QueueService,
  ) {}

  checkSecret(secret: string | undefined) {
    const expected = process.env.INTERNAL_SECRET ?? "";
    if (!expected || secret !== expected) {
      throw new UnauthorizedException("Invalid internal secret");
    }
  }

  /** wa-gateway → api: pesan WA masuk, teruskan ke antrian worker. */
  async incoming(data: {
    waNumberId: string; nomor: string; kontak?: string; pesan: string; kanal?: "Chat" | "Iklan";
  }) {
    const wa = await this.db.db.query.waNumbers.findFirst({
      where: eq(schema.waNumbers.id, data.waNumberId),
    });
    if (!wa) throw new UnauthorizedException("wa_number tidak dikenal");

    const tenantId = wa.tenantId;
    let kanal: "Chat" | "Iklan" = data.kanal ?? "Chat";

    // Deteksi cerdas: Cek apakah pesan cocok dengan template iklan aktif tenant
    if (kanal !== "Iklan") {
      try {
        const activeTemplates = await this.db.db.query.adTemplates.findMany({
          where: and(eq(schema.adTemplates.tenantId, tenantId), eq(schema.adTemplates.aktif, true)),
        });
        const AD_STOPWORDS = new Set([
          "halo", "hai", "selamat", "pagi", "siang", "sore", "malam",
          "kak", "kakak", "min", "admin", "gan", "sis", "boss", "bapak", "ibu",
          "saya", "kami", "anda", "kamu", "dia", "mereka", "kita",
          "mau", "bisa", "apakah", "tanya", "toko", "ada", "yang", "dan", "atau",
          "ini", "itu", "dari", "untuk", "pada", "ke", "di", "dengan", "dong", "ya"
        ]);
        const pesanClean = (data.pesan || "").toLowerCase().trim();
        const kataPesan = pesanClean
          .replace(/[^\w\s]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length >= 3 && !AD_STOPWORDS.has(w));

        const isMatchedAd = activeTemplates.some((t) => {
          const tTanya = (t.pertanyaan || "").toLowerCase().trim();
          if (t.caraMencocokkan === "sama_persis") {
            return (
              pesanClean.replace(/[^\w\s]/g, " ").trim() ===
              tTanya.replace(/[^\w\s]/g, " ").trim()
            );
          }
          const targetTokens = tTanya
            .replace(/[^\w\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length >= 3 && !AD_STOPWORDS.has(w));
          if (!targetTokens.length || !kataPesan.length) return false;
          const sharedTokens = kataPesan.filter((w) => targetTokens.includes(w));
          return sharedTokens.length >= 1 && (sharedTokens.length / targetTokens.length >= 0.3 || sharedTokens.length >= 2);
        });
        if (isMatchedAd) {
          kanal = "Iklan";
        }
      } catch {}
    }

    // Hormati switch auto per nomor
    if (kanal === "Iklan" && !wa.autoIklan) return { queued: false, reason: "auto_iklan mati" };
    if (kanal === "Chat" && !wa.autoChat) return { queued: false, reason: "auto_chat mati" };

    // Cek lisensi aktif (PLAN.md)
    const tenant = await this.db.db.query.tenants.findFirst({
      where: eq(schema.tenants.id, tenantId),
    });
    if (!tenant || tenant.status !== "aktif") return { queued: false, reason: "tenant nonaktif" };
    if (!tenant.lisensiBerakhir || tenant.lisensiBerakhir.getTime() < Date.now()) {
      return { queued: false, reason: "lisensi expired atau tidak aktif" };
    }

    // Audit masuk
    await this.db.db.insert(schema.messageQueue).values({
      direction: "in", tenantId, waNumberId: wa.id,
      nomor: data.nomor, kontak: data.kontak ?? "", pesan: data.pesan, status: "pending",
    });

    await this.queue.enqueueIncomingMessage({
      tenantId, waNumberId: wa.id, nomor: data.nomor,
      kontak: data.kontak, pesan: data.pesan, kanal,
    });
    return { queued: true };
  }

  /** worker → api: simpan hasil balasan + teruskan ke outgoing queue (wa-gateway). */
  async replyResult(data: {
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
  }) {
    await this.db.db.insert(schema.chatLogs).values({
      tenantId: data.tenantId,
      waNumberId: data.waNumberId,
      kontak: data.kontak ?? data.nomor,
      nomor: data.nomor,
      kanal: data.kanal,
      pesanTerakhir: data.pesanAsli,
      balasan: data.balasan,
      keyakinan: data.keyakinan,
      status: data.status as any,
    });
    await this.db.db.insert(schema.messageQueue).values({
      direction: "out",
      tenantId: data.tenantId,
      waNumberId: data.waNumberId,
      nomor: data.nomor,
      kontak: data.kontak ?? "",
      pesan: data.balasan,
      status: "queued",
    });
    // Naikkan counter chat tenant
    const tenant = await this.db.db.query.tenants.findFirst({
      where: eq(schema.tenants.id, data.tenantId),
    });
    if (tenant) {
      await this.db.db
        .update(schema.tenants)
        .set({ chatBulanIni: (tenant.chatBulanIni ?? 0) + 1 })
        .where(eq(schema.tenants.id, data.tenantId));
    }
    await this.queue.enqueueOutgoingMessage({
      tenantId: data.tenantId,
      waNumberId: data.waNumberId,
      nomor: data.nomor,
      pesan: data.balasan,
      mediaUrl: data.mediaUrl,
      mediaType: data.mediaType,
    });
    return { ok: true };
  }

  /** wa-gateway → api: update status koneksi nomor (tersambung/memindai/terputus). */
  async waStatus(waNumberId: string, status: string, nomor?: string) {
    const updateData: Record<string, any> = { status };
    if (nomor && nomor.trim()) updateData.nomor = nomor.trim();
    if (status === "tersambung") updateData.terakhirAktif = new Date();
    await this.db.db
      .update(schema.waNumbers)
      .set(updateData)
      .where(eq(schema.waNumbers.id, waNumberId));
    return { ok: true };
  }

  /** worker → api: catat pemakaian token Groq per tenant. */
  async usage(data: { tenantId: string; model: string; tokensInput: number; tokensOutput: number; costCents?: number }) {
    await this.db.db.insert(schema.usageLogs).values({
      tenantId: data.tenantId, model: data.model,
      tokensInput: data.tokensInput, tokensOutput: data.tokensOutput,
      costCents: data.costCents ?? 0,
    });
    const tenant = await this.db.db.query.tenants.findFirst({
      where: eq(schema.tenants.id, data.tenantId),
    });
    if (tenant) {
      await this.db.db
        .update(schema.tenants)
        .set({ tokenBulanIni: (tenant.tokenBulanIni ?? 0) + data.tokensInput + data.tokensOutput })
        .where(eq(schema.tenants.id, data.tenantId));
    }
    return { ok: true };
  }

  /** worker → api: update status indexing dokumen. */
  async indexDone(docId: string, ok: boolean, chunks: number) {
    await this.db.db
      .update(schema.knowledgeDocs)
      .set({ status: ok ? "terindeks" : "gagal", potongan: chunks })
      .where(eq(schema.knowledgeDocs.id, docId));
    return { ok: true };
  }
}
