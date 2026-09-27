import { Injectable, NotFoundException, Logger } from "@nestjs/common";
import { eq, and } from "drizzle-orm";
import { DatabaseService, schema } from "../database/database.service";

export interface ReadinessScoreResult {
  score: number;
  level: "Perlu Dilengkapi" | "Cukup Siap" | "Sangat Siap & Akurat";
  levelColor: "warning" | "info" | "success";
  checklist: Array<{
    id: string;
    label: string;
    done: boolean;
    bobot: number;
    hint: string;
  }>;
  recommendations: string[];
}

@Injectable()
export class TenantService {
  private readonly logger = new Logger(TenantService.name);

  constructor(private db: DatabaseService) {}

  private async resolveTenantId(tenantId: string): Promise<string> {
    try {
      if (tenantId) {
        const t = await this.db.db.query.tenants.findFirst({
          where: eq(schema.tenants.id, tenantId),
        });
        if (t) return t.id;
      }
      const fallback = await this.db.db.query.tenants.findFirst();
      if (fallback) return fallback.id;
    } catch {}
    return tenantId;
  }

  async getMe(tenantId: string) {
    const validId = await this.resolveTenantId(tenantId);
    const tenant = await this.db.db.query.tenants.findFirst({
      where: eq(schema.tenants.id, validId),
    });

    if (!tenant) {
      throw new NotFoundException("Tenant tidak ditemukan");
    }

    return {
      id: tenant.id,
      nama: tenant.nama,
      industri: tenant.industri || "Belum Memilih",
      plan: tenant.plan,
      email: tenant.email,
      status: tenant.status,
      nomorWa: tenant.nomorWa,
      chatBulanIni: tenant.chatBulanIni,
      kuotaChat: tenant.kuotaChat,
      lisensiBerakhir: tenant.lisensiBerakhir?.toISOString() ?? null,
      createdAt: tenant.createdAt?.toISOString() ?? null,
    };
  }

  async updateBusinessType(tenantId: string, businessType: string) {
    const validId = await this.resolveTenantId(tenantId);
    const cleanType = (businessType || "").trim();

    if (!cleanType) {
      throw new NotFoundException("Tipe bisnis tidak boleh kosong");
    }

    const [updated] = await this.db.db
      .update(schema.tenants)
      .set({
        industri: cleanType,
        updatedAt: new Date(),
      })
      .where(eq(schema.tenants.id, validId))
      .returning();

    if (!updated) {
      throw new NotFoundException("Gagal memperbarui tipe bisnis tenant");
    }

    try {
      await this.db.db.insert(schema.auditLog).values({
        tenantId: validId,
        aktor: "tenant",
        aksi: "Pilih tipe bisnis",
        target: cleanType,
      });
    } catch {}

    return {
      id: updated.id,
      nama: updated.nama,
      industri: updated.industri,
      plan: updated.plan,
      email: updated.email,
    };
  }

  async getReadinessScore(tenantId: string): Promise<ReadinessScoreResult> {
    const validId = await this.resolveTenantId(tenantId);

    // Ambil data penunjang
    const tenant = await this.db.db.query.tenants.findFirst({
      where: eq(schema.tenants.id, validId),
    });

    const faqs = await this.db.db.query.faqItems.findMany({
      where: eq(schema.faqItems.tenantId, validId),
    });

    const docs = await this.db.db.query.knowledgeDocs.findMany({
      where: eq(schema.knowledgeDocs.tenantId, validId),
    });

    const wa = await this.db.db.query.waNumbers.findFirst({
      where: eq(schema.waNumbers.tenantId, validId),
    });

    const adTemplates = await this.db.db.query.adTemplates.findMany({
      where: eq(schema.adTemplates.tenantId, validId),
    });

    // 1. Tipe bisnis (15 poin)
    const hasBusinessType =
      Boolean(tenant?.industri) &&
      tenant?.industri !== "Belum Memilih" &&
      tenant?.industri !== "Belum Ditentukan" &&
      tenant?.industri !== "";
    const scoreBusinessType = hasBusinessType ? 15 : 0;

    // 2. FAQ & Template Pengetahuan (35 poin)
    let scoreFaq = 0;
    if (faqs.length >= 5) {
      scoreFaq = 35;
    } else if (faqs.length >= 3) {
      scoreFaq = 25;
    } else if (faqs.length >= 1) {
      scoreFaq = 15;
    }

    // 3. Dokumen / Materi Bisnis (20 poin)
    const hasProcessedDocs = docs.some((d) => d.status === "siap");
    let scoreDocs = 0;
    if (hasProcessedDocs || faqs.length >= 8) {
      scoreDocs = 20;
    } else if (docs.length > 0 || faqs.length >= 4) {
      scoreDocs = 10;
    }

    // 4. Template Iklan Siaga (15 poin)
    const hasAdTemplate = adTemplates.length > 0;
    const scoreAd = hasAdTemplate ? 15 : 0;

    // 5. Sambungan WhatsApp (15 poin)
    const isWaConnected = wa?.status === "tersambung";
    let scoreWa = 0;
    if (isWaConnected) {
      scoreWa = 15;
    } else if (wa?.status === "terputus") {
      scoreWa = 5;
    }

    const totalScore = Math.min(
      100,
      scoreBusinessType + scoreFaq + scoreDocs + scoreAd + scoreWa,
    );

    let level: ReadinessScoreResult["level"] = "Perlu Dilengkapi";
    let levelColor: ReadinessScoreResult["levelColor"] = "warning";
    if (totalScore >= 80) {
      level = "Sangat Siap & Akurat";
      levelColor = "success";
    } else if (totalScore >= 40) {
      level = "Cukup Siap";
      levelColor = "info";
    }

    const checklist = [
      {
        id: "tipe_bisnis",
        label: "Klasifikasi Tipe Bisnis",
        done: hasBusinessType,
        bobot: 15,
        hint: hasBusinessType
          ? `Tipe: ${tenant?.industri}`
          : "Pilih tipe bisnis Anda agar AI memahami karakteristik layanan Anda.",
      },
      {
        id: "profil_faq",
        label: "Tanya Jawab (FAQ) & Template Bisnis",
        done: faqs.length >= 3,
        bobot: 35,
        hint: `${faqs.length} FAQ aktif (disarankan minimal 3-5 info bisnis penting).`,
      },
      {
        id: "dokumen",
        label: "Dokumen & Materi Pendukung",
        done: scoreDocs >= 15,
        bobot: 20,
        hint:
          docs.length > 0
            ? `${docs.length} dokumen tersimpan.`
            : "Unggah dokumen PDF/katalog atau lengkapi template bisnis.",
      },
      {
        id: "iklan",
        label: "Template Balas Iklan",
        done: hasAdTemplate,
        bobot: 15,
        hint: hasAdTemplate
          ? `${adTemplates.length} template iklan siap pakai.`
          : "Buat minimal 1 template balasan untuk calon pembeli dari iklan.",
      },
      {
        id: "koneksi_wa",
        label: "Koneksi WhatsApp Aktif",
        done: isWaConnected,
        bobot: 15,
        hint: isWaConnected
          ? `Nomor tersambung (${wa?.nomor || "Aktif"})`
          : "Pindai QR code WhatsApp agar bot bisa mulai membalas otomatis.",
      },
    ];

    const recommendations: string[] = [];
    if (!hasBusinessType) {
      recommendations.push("Pilih tipe bisnis Anda (Toko, Agency, Yayasan, Klinik, dll) di profil.");
    }
    if (faqs.length < 3) {
      recommendations.push(
        "Isi template bisnis penting seperti Jam Operasional, Info Produk/Layanan, dan Cara Pemesanan.",
      );
    }
    if (!hasAdTemplate) {
      recommendations.push(
        "Tambahkan 1 template balas iklan agar respon ke calon pembeli dari iklan medsos instan.",
      );
    }
    if (!isWaConnected) {
      recommendations.push(
        "Sambungkan nomor WhatsApp bisnis Anda di menu Koneksi WhatsApp.",
      );
    }

    return {
      score: totalScore,
      level,
      levelColor,
      checklist,
      recommendations,
    };
  }
}
