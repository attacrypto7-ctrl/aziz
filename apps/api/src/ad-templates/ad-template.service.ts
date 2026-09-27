import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { eq, and } from "drizzle-orm";
import { DatabaseService, schema } from "../database/database.service";
import type { CreateAdTemplateDto, UpdateAdTemplateDto } from "@cs-ai/shared-types";

/** AdTemplateService — CRUD template Auto Bales Iklan + langkah balasan. */
@Injectable()
export class AdTemplateService {
  constructor(private db: DatabaseService) {}

  async list(tenantId: string) {
    const validId = await this.resolveTenantId(tenantId);
    const rows = await this.db.db
      .select()
      .from(schema.adTemplates)
      .where(eq(schema.adTemplates.tenantId, validId));
    const out: any[] = [];
    for (const t of rows) out.push(await this.withSteps(t));
    return out;
  }

  async create(tenantId: string, dto: CreateAdTemplateDto) {
    if (!dto.pertanyaan?.trim()) throw new BadRequestException("pertanyaan wajib diisi");
    const validId = await this.resolveTenantId(tenantId);
    const [t] = await this.db.db
      .insert(schema.adTemplates)
      .values({
        tenantId: validId,
        pertanyaan: dto.pertanyaan,
        jawaban: dto.langkah?.find((l) => l.tipe === "teks")?.isiTeks ?? null,
        caraMencocokkan: dto.caraMencocokkan ?? "boleh_mirip",
        aktif: dto.aktif ?? true,
      })
      .returning();
    await this.replaceSteps(t.id, dto.langkah ?? []);
    return this.withSteps(t);
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


  async update(tenantId: string, id: string, dto: UpdateAdTemplateDto) {
    const validId = await this.resolveTenantId(tenantId);
    const existing = await this.db.db.query.adTemplates.findFirst({
      where: and(eq(schema.adTemplates.id, id), eq(schema.adTemplates.tenantId, validId)),
    });
    if (!existing) throw new NotFoundException("Template tidak ditemukan");
    const [t] = await this.db.db
      .update(schema.adTemplates)
      .set({
        ...(dto.pertanyaan ? { pertanyaan: dto.pertanyaan } : {}),
        ...(dto.caraMencocokkan ? { caraMencocokkan: dto.caraMencocokkan } : {}),
        ...(dto.aktif !== undefined ? { aktif: dto.aktif } : {}),
      })
      .where(eq(schema.adTemplates.id, id))
      .returning();
    if (dto.langkah) await this.replaceSteps(id, dto.langkah);
    return this.withSteps(t);
  }

  async remove(tenantId: string, id: string) {
    const validId = await this.resolveTenantId(tenantId);
    const existing = await this.db.db.query.adTemplates.findFirst({
      where: and(eq(schema.adTemplates.id, id), eq(schema.adTemplates.tenantId, validId)),
    });
    if (!existing) throw new NotFoundException("Template tidak ditemukan");
    await this.db.db.delete(schema.adTemplateSteps).where(eq(schema.adTemplateSteps.templateId, id));
    await this.db.db.delete(schema.adTemplates).where(eq(schema.adTemplates.id, id));
    return { success: true, id };
  }

  private async replaceSteps(templateId: string, langkah: Array<any>) {
    await this.db.db.delete(schema.adTemplateSteps).where(eq(schema.adTemplateSteps.templateId, templateId));
    if (!langkah.length) return;
    await this.db.db.insert(schema.adTemplateSteps).values(
      langkah.map((l, i) => {
        const mediaUrl = l.urlGambar || l.urlVideo || l.urlMedia || l.mediaUrl || null;
        const mediaName = l.namaGambar || l.namaVideo || l.namaMedia || null;
        return {
          templateId,
          urutan: l.urutan ?? i + 1,
          tipe: l.tipe,
          isiTeks: l.isiTeks ?? null,
          urlGambar: mediaUrl,
          namaGambar: mediaName,
        };
      }),
    );
  }

  private async withSteps(t: any) {
    const steps = await this.db.db
      .select()
      .from(schema.adTemplateSteps)
      .where(eq(schema.adTemplateSteps.templateId, t.id));
    return {
      id: t.id,
      tenantId: t.tenantId,
      pertanyaan: t.pertanyaan,
      jawaban: t.jawaban ?? steps.find((s) => s.tipe === "teks")?.isiTeks ?? "",
      mode: t.caraMencocokkan === "sama_persis" ? "exact" : "fuzzy",
      caraMencocokkan: t.caraMencocokkan,
      aktif: t.aktif,
      dipakai: t.dipakai,
      langkah: steps
        .sort((a, b) => a.urutan - b.urutan)
        .map((s) => ({
          id: s.id,
          urutan: s.urutan,
          tipe: s.tipe,
          isiTeks: s.isiTeks,
          urlGambar: s.urlGambar,
          namaGambar: s.namaGambar,
          urlVideo: s.tipe === "video" ? s.urlGambar : undefined,
          namaVideo: s.tipe === "video" ? s.namaGambar : undefined,
          mediaUrl: s.urlGambar,
          namaMedia: s.namaGambar,
        })),
    };
  }
}
