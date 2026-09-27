import { Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { ConfigService } from "@nestjs/config";
import { DatabaseService, schema } from "../database/database.service";
import { QueueService } from "../queue/queue.service";
import type { UpdateBotSettingsDto, TrialRequestDto, TrialResponseDto } from "@cs-ai/shared-types";

/**
 * BotService — pengaturan bot per tenant + endpoint "Uji Coba Bot".
 * Trial: cocokkan template/FAQ dulu (gratis), fallback ke Groq kalau ada key.
 */
@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private db: DatabaseService,
    private queueService: QueueService,
    private configService: ConfigService,
  ) {}

  async getSettings(tenantId: string) {
    const validId = await this.resolveTenantId(tenantId);
    let settings = await this.db.db.query.botSettings.findFirst({
      where: eq(schema.botSettings.tenantId, validId),
    });
    if (!settings) {
      const [created] = await this.db.db
        .insert(schema.botSettings)
        .values({ tenantId: validId })
        .returning();
      settings = created;
    }
    return this.format(settings);
  }

  async updateSettings(tenantId: string, dto: UpdateBotSettingsDto) {
    const validId = await this.resolveTenantId(tenantId);
    await this.getSettings(validId); // pastikan row ada
    const [updated] = await this.db.db
      .update(schema.botSettings)
      .set({ ...dto })
      .where(eq(schema.botSettings.tenantId, validId))
      .returning();

    try {
      await this.db.db.insert(schema.auditLog).values({
        tenantId: validId,
        aktor: "tenant",
        aksi: "Update pengaturan bot",
        target: JSON.stringify(dto).slice(0, 500),
      });
    } catch {}
    return this.format(updated);
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


  /** Uji coba sandbox — tidak menyentuh WhatsApp asli. */
  async trial(tenantId: string, dto: TrialRequestDto): Promise<TrialResponseDto> {
    const tenant = await this.db.db.query.tenants.findFirst({
      where: eq(schema.tenants.id, tenantId),
    });
    if (!tenant || tenant.status !== "aktif" || !tenant.lisensiBerakhir || tenant.lisensiBerakhir.getTime() < Date.now()) {
      return {
        jawaban: "Lisensi bot belum aktif atau masa berlaku telah habis. Silakan aktifkan lisensi terlebih dahulu melalui menu Lisensi.",
        sumber: "Lisensi Tidak Aktif / Habis",
        keyakinan: 0,
      };
    }

    const pesan = dto.message.trim();
    if (dto.mode === "iklan") {
      const match = await this.matchAdTemplate(tenantId, pesan);
      if (match) return match;
      return {
        jawaban: "Belum ada template yang cocok. Chat ini akan dialihkan ke admin agar tidak salah jawab.",
        sumber: "Tidak ada match",
        keyakinan: 0.2,
      };
    }
    const faqMatch = await this.matchFaq(tenantId, pesan);
    if (faqMatch) return faqMatch;

    // Fallback AI (RAG penuh dikerjakan worker; di trial cukup prompt sederhana)
    const apiKey = this.configService.get<string>("aiApiKey") || this.configService.get<string>("groqApiKey");
    const aiBaseUrl = this.configService.get<string>("aiBaseUrl");
    if (apiKey) {
      try {
        const { GroqClient } = await import("@cs-ai/groq-client");
        const settings = await this.getSettings(tenantId);
        const client = new GroqClient({ apiKey, baseURL: aiBaseUrl || undefined });
        const res = await client.simpleChat(
          client.getModelForLevel(settings.tingkatKepintaran),
          `Kamu asisten toko "${settings.namaBot ?? "CS"}". Gaya: ${settings.gayaBahasa ?? "sopan, Bahasa Indonesia"}. Jawab maksimal 3 kalimat. Jika tidak tahu, katakan akan dicek admin — jangan mengarang.`,
          pesan,
          { maxTokens: 300 },
        );
        if (res.content) {
          return { jawaban: res.content, sumber: `AI (${settings.tingkatKepintaran})`, keyakinan: 0.75 };
        }
      } catch (err) {
        this.logger.warn(`AI trial gagal: ${(err as Error).message}`);
      }
    }
    return {
      jawaban: "Maaf, saya belum menemukan informasi itu di basis pengetahuan. Saya sambungkan ke admin ya, Kak.",
      sumber: "Di luar FAQ",
      keyakinan: 0.28,
    };
  }

  // ---- pencocokan lokal (sama seperti worker, tanpa AI) ----
  private async matchAdTemplate(tenantId: string, pesan: string): Promise<TrialResponseDto | null> {
    const templates = await this.db.db
      .select()
      .from(schema.adTemplates)
      .where(eq(schema.adTemplates.tenantId, tenantId));
    const aktif = templates.filter((t) => t.aktif);
    const teks = pesan.toLowerCase();
    const kata = teks.split(/\s+/).filter((w) => w.length > 3);

    for (const t of aktif) {
      if (t.caraMencocokkan === "sama_persis" && t.pertanyaan.toLowerCase() === teks) {
        return this.templateAnswer(t.id, t.pertanyaan, "Template iklan (sama_persis)", 1);
      }
    }
    for (const t of aktif) {
      if (t.caraMencocokkan === "boleh_mirip") {
        const target = t.pertanyaan.toLowerCase();
        if (kata.some((w) => target.includes(w))) {
          return this.templateAnswer(t.id, t.pertanyaan, "Template iklan (boleh_mirip)", 0.88);
        }
      }
    }
    return null;
  }

  private async templateAnswer(templateId: string, pertanyaan: string, sumber: string, keyakinan: number): Promise<TrialResponseDto> {
    const steps = await this.db.db
      .select()
      .from(schema.adTemplateSteps)
      .where(eq(schema.adTemplateSteps.templateId, templateId));
    const teks = steps
      .sort((a, b) => a.urutan - b.urutan)
      .filter((s) => s.tipe === "teks" && s.isiTeks)
      .map((s) => s.isiTeks)
      .join("\n");
    return { jawaban: teks || `(template: ${pertanyaan})`, sumber, keyakinan };
  }

  private async matchFaq(tenantId: string, pesan: string): Promise<TrialResponseDto | null> {
    const faqs = await this.db.db
      .select()
      .from(schema.faqItems)
      .where(eq(schema.faqItems.tenantId, tenantId));
    const kata = pesan.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const cocok = faqs.find((f) =>
      kata.some((w) => `${f.pertanyaan} ${f.jawaban}`.toLowerCase().includes(w)),
    );
    if (!cocok) return null;
    return { jawaban: cocok.jawaban, sumber: `FAQ: ${cocok.pertanyaan}`, keyakinan: 0.9 };
  }

  private format(s: any) {
    return {
      id: s.id,
      tenantId: s.tenantId,
      namaBot: s.namaBot ?? "",
      gayaBahasa: s.gayaBahasa ?? "",
      tingkatKepintaran: s.tingkatKepintaran,
      bahasaBalasan: s.bahasaBalasan,
      ambangAlih: s.ambangAlih,
      autoSapaan: s.autoSapaan,
      stopSetelahAdmin: s.stopSetelahAdmin,
      simpanTranskrip: s.simpanTranskrip,
      autoChatAktif: s.autoChatAktif,
      autoIklanAktif: s.autoIklanAktif,
      aiEngine: s.aiEngine ?? "",
      fallowUnknown: s.fallowUnknown,
    };
  }
}
