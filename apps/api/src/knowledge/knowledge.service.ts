import { Injectable, NotFoundException, BadRequestException, Logger } from "@nestjs/common";
import { eq, and, sql } from "drizzle-orm";
import { DatabaseService, schema } from "../database/database.service";
import { QueueService } from "../queue/queue.service";
import type { DocTipe } from "@cs-ai/shared-types";

/**
 * KnowledgeService — manajemen dokumen & FAQ per tenant.
 * Dokumen baru otomatis di-enqueue ke worker untuk indexing (chunking + embedding).
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private db: DatabaseService,
    private queueService: QueueService,
  ) {}

  // ---- Documents ----
  async getDocs(tenantId: string) {
    const validId = await this.resolveTenantId(tenantId);
    const docs = await this.db.db
      .select()
      .from(schema.knowledgeDocs)
      .where(eq(schema.knowledgeDocs.tenantId, validId))
      .orderBy(schema.knowledgeDocs.diperbarui);

    return docs.map((d) => ({
      id: d.id,
      tenantId: d.tenantId,
      nama: d.nama,
      tipe: d.tipe,
      ukuran: d.ukuran || "-",
      potongan: d.potongan,
      versi: d.versi,
      diperbarui: d.diperbarui.toISOString(),
      status: d.status,
    }));
  }

  async uploadDoc(
    tenantId: string,
    file: Express.Multer.File,
    body?: { nama?: string; tipe?: string },
  ) {
    const validId = await this.resolveTenantId(tenantId);
    const ukuran = formatBytes(file.size);
    const nama = body?.nama || file.originalname || "dokumen";
    const tipe = (body?.tipe as DocTipe) || detectFileType(file);

    const [doc] = await this.db.db
      .insert(schema.knowledgeDocs)
      .values({
        tenantId: validId,
        nama,
        tipe,
        ukuran,
        versi: 1,
        status: "memproses",
      })
      .returning();

    let content = "";
    if (file.buffer) {
      content = file.buffer.toString("utf-8");
    } else if (file.path) {
      const fs = require("fs");
      content = fs.readFileSync(file.path, "utf-8");
    }

    await this.queueService.enqueueIndexing({
      tenantId: validId,
      docId: doc.id,
      content,
      tipe: tipe === "PDF" ? "PDF" : "Teks",
    });

    return {
      id: doc.id,
      tenantId: doc.tenantId,
      nama: doc.nama,
      tipe: doc.tipe,
      ukuran: doc.ukuran,
      potongan: doc.potongan,
      versi: doc.versi,
      diperbarui: doc.diperbarui?.toISOString() ?? new Date().toISOString(),
      status: doc.status,
    };
  }

  async deleteDoc(tenantId: string, docId: string) {
    const validId = await this.resolveTenantId(tenantId);
    const doc = await this.db.db.query.knowledgeDocs.findFirst({
      where: and(eq(schema.knowledgeDocs.id, docId), eq(schema.knowledgeDocs.tenantId, validId)),
    });
    if (!doc) throw new NotFoundException("Dokumen tidak ditemukan");

    await this.db.db
      .delete(schema.knowledgeChunks)
      .where(eq(schema.knowledgeChunks.docId, docId));
    await this.db.db.delete(schema.knowledgeDocs).where(eq(schema.knowledgeDocs.id, docId));

    return { success: true, id: docId };
  }

  async getDocChunks(tenantId: string, docId: string) {
    const validId = await this.resolveTenantId(tenantId);
    const chunks = await this.db.db
      .select({
        id: schema.knowledgeChunks.id,
        content: schema.knowledgeChunks.content,
        createdAt: schema.knowledgeChunks.createdAt,
      })
      .from(schema.knowledgeChunks)
      .where(
        and(
          eq(schema.knowledgeChunks.docId, docId),
          eq(schema.knowledgeChunks.tenantId, validId),
        ),
      )
      .orderBy(schema.knowledgeChunks.createdAt);

    return { docId, totalChunks: chunks.length, chunks };
  }

  // ---- FAQ ----
  async getFaq(tenantId: string) {
    const validId = await this.resolveTenantId(tenantId);
    const faqs = await this.db.db
      .select()
      .from(schema.faqItems)
      .where(eq(schema.faqItems.tenantId, validId))
      .orderBy(schema.faqItems.createdAt);

    return faqs.map((f) => ({
      id: f.id,
      tenantId: f.tenantId,
      pertanyaan: f.pertanyaan,
      jawaban: f.jawaban,
    }));
  }

  async createFaq(tenantId: string, data: { pertanyaan: string; jawaban: string }) {
    if (!data.pertanyaan || !data.jawaban) {
      throw new BadRequestException("pertanyaan dan jawaban wajib diisi");
    }

    const validId = await this.resolveTenantId(tenantId);
    const [faq] = await this.db.db
      .insert(schema.faqItems)
      .values({ tenantId: validId, pertanyaan: data.pertanyaan, jawaban: data.jawaban })
      .returning();

    return {
      id: faq.id,
      tenantId: faq.tenantId,
      pertanyaan: faq.pertanyaan,
      jawaban: faq.jawaban,
    };
  }

  async updateFaq(tenantId: string, faqId: string, data: { pertanyaan?: string; jawaban?: string }) {
    const validId = await this.resolveTenantId(tenantId);
    const faq = await this.db.db.query.faqItems.findFirst({
      where: and(eq(schema.faqItems.id, faqId), eq(schema.faqItems.tenantId, validId)),
    });
    if (!faq) throw new NotFoundException("FAQ tidak ditemukan");

    await this.db.db.update(schema.faqItems).set(data).where(eq(schema.faqItems.id, faqId));

    const updated = await this.db.db.query.faqItems.findFirst({
      where: eq(schema.faqItems.id, faqId),
    });

    return {
      id: updated!.id,
      tenantId: updated!.tenantId,
      pertanyaan: updated!.pertanyaan,
      jawaban: updated!.jawaban,
    };
  }

  async deleteFaq(tenantId: string, faqId: string) {
    const validId = await this.resolveTenantId(tenantId);
    const faq = await this.db.db.query.faqItems.findFirst({
      where: and(eq(schema.faqItems.id, faqId), eq(schema.faqItems.tenantId, validId)),
    });
    if (!faq) throw new NotFoundException("FAQ tidak ditemukan");

    await this.db.db.delete(schema.faqItems).where(eq(schema.faqItems.id, faqId));
    return { success: true, id: faqId };
  }

  // ---- RAG Search ----
  async search(tenantId: string, query: string, topK = 5) {
    const validId = await this.resolveTenantId(tenantId);
    const faqs = await this.db.db
      .select()
      .from(schema.faqItems)
      .where(
        and(
          eq(schema.faqItems.tenantId, validId),
          sql`to_tsvector('indonesian', ${""}) @@ plainto_tsquery('indonesian', ${query})`,
        ),
      );

    const chunks = await this.db.db
      .select({
        id: schema.knowledgeChunks.id,
        content: schema.knowledgeChunks.content,
      })
      .from(schema.knowledgeChunks)
      .where(eq(schema.knowledgeChunks.tenantId, validId))
      .orderBy(schema.knowledgeChunks.createdAt)
      .limit(topK);

    return { faqs, chunks };
  }

  private async resolveTenantId(tenantId: string): Promise<string> {
    try {
      const tenant = await this.db.db.query.tenants.findFirst({
        where: eq(schema.tenants.id, tenantId),
      });
      if (tenant) return tenant.id;
      const fallback = await this.db.db.query.tenants.findFirst();
      if (fallback) return fallback.id;
    } catch {}
    return tenantId;
  }

}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function detectFileType(file: Express.Multer.File): DocTipe {
  if (file.mimetype?.includes("pdf")) return "PDF";
  if (file.mimetype?.includes("text") || file.originalname?.endsWith(".txt")) return "Teks";
  return "Teks";
}