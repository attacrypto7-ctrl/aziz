import { eq } from "drizzle-orm";
import { schema } from "@cs-ai/database";
import { db, groq, reportReply, reportUsage } from "./util";
import type { ChatJob } from "./chat.processor";

/**
 * Proses chat dari iklan — PLAN.md bagian 4.4:
 * 1. Cocokkan template dulu (sama_persis / boleh_mirip) TANPA panggil AI.
 * 2. Groq hanya sebagai cadangan, dengan instruksi ketat:
 *    "hanya boleh pilih dari daftar balasan ini, dilarang mengarang."
 */
export async function processAd(job: ChatJob): Promise<void> {
  const database = db();
  const { tenantId, pesan } = job;

  const templates = await database
    .select()
    .from(schema.adTemplates)
    .where(eq(schema.adTemplates.tenantId, tenantId));
  const aktif = templates.filter((t) => t.aktif);
  const AD_STOPWORDS = new Set([
    "halo", "hai", "selamat", "pagi", "siang", "sore", "malam",
    "kak", "kakak", "min", "admin", "gan", "sis", "boss", "bapak", "ibu",
    "saya", "kami", "anda", "kamu", "dia", "mereka", "kita",
    "mau", "bisa", "apakah", "tanya", "toko", "ada", "yang", "dan", "atau",
    "ini", "itu", "dari", "untuk", "pada", "ke", "di", "dengan", "dong", "ya"
  ]);

  const teks = pesan.toLowerCase().trim();
  const kata = teks
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !AD_STOPWORDS.has(w));

  // 1a. sama persis (abaikan tanda baca)
  let hit = aktif.find(
    (t) =>
      t.caraMencocokkan === "sama_persis" &&
      t.pertanyaan.toLowerCase().replace(/[^\w\s]/g, " ").trim() ===
        teks.replace(/[^\w\s]/g, " ").trim(),
  );
  let keyakinan = 1;

  // 1b. boleh mirip: bandingkan token substantif yang bermakna
  if (!hit) {
    hit = aktif.find((t) => {
      if (t.caraMencocokkan !== "boleh_mirip") return false;
      const targetTokens = t.pertanyaan
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !AD_STOPWORDS.has(w));
      if (!targetTokens.length || !kata.length) return false;
      const sharedTokens = kata.filter((w) => targetTokens.includes(w));
      return sharedTokens.length >= 1 && (sharedTokens.length / targetTokens.length >= 0.3 || sharedTokens.length >= 2);
    });
    keyakinan = 0.88;
  }

  if (hit) {
    await sendSteps(hit.id, hit.pertanyaan, job, keyakinan);
    await bumpDipakai(hit.id, hit.dipakai ?? 0);
    return;
  }

  // 2. Fallback Groq — hanya boleh memilih dari daftar balasan template
  const client = groq();
  if (client && aktif.length > 0) {
    const daftar = aktif.map((t) => `- [${t.id}] ${t.pertanyaan}`).join("\n");
    const [settings] = await database
      .select()
      .from(schema.botSettings)
      .where(eq(schema.botSettings.tenantId, tenantId));
    const model = client.getModelForLevel(settings?.tingkatKepintaran ?? "seimbang");
    const res = await client.simpleChat(
      model,
      `Kamu asisten toko. Pelanggan bertanya dari iklan. Daftar pertanyaan yang BOLEH dijawab:\n${daftar}\n\nBalas HANYA dengan ID baris yang paling cocok, format: ID:<id>. Jika tidak ada yang cocok, balas persis: TIDAK_COCON. Dilarang mengarang jawaban.`,
      pesan,
      { maxTokens: 60, temperature: 0 },
    );
    await reportUsage({
      tenantId, model,
      tokensInput: res.usage?.promptTokens ?? 0,
      tokensOutput: res.usage?.completionTokens ?? 0,
    });
    const m = (res.content ?? "").match(/ID:([0-9a-f-]{8,})/i);
    const chosen = m ? aktif.find((t) => t.id === m[1]) : undefined;
    if (chosen) {
      await sendSteps(chosen.id, chosen.pertanyaan, job, 0.7);
      await bumpDipakai(chosen.id, chosen.dipakai ?? 0);
      return;
    }
  }

  await reportReply({
    tenantId: job.tenantId, waNumberId: job.waNumberId, nomor: job.nomor, kontak: job.kontak,
    pesanAsli: pesan,
    balasan: "Belum ada template yang cocok. Chat ini akan dialihkan ke admin agar tidak salah jawab.",
    keyakinan: 0.2, status: "perlu_manusia", kanal: "Iklan",
  });
}

async function sendSteps(templateId: string, fallback: string, job: ChatJob, keyakinan: number): Promise<void> {
  const steps = await db()
    .select()
    .from(schema.adTemplateSteps)
    .where(eq(schema.adTemplateSteps.templateId, templateId));

  const sorted = steps.sort((a, b) => a.urutan - b.urutan);
  if (!sorted.length) {
    await reportReply({
      tenantId: job.tenantId, waNumberId: job.waNumberId, nomor: job.nomor, kontak: job.kontak,
      pesanAsli: job.pesan, balasan: fallback, keyakinan, status: "terjawab", kanal: "Iklan",
    });
    return;
  }

  for (const step of sorted) {
    if (step.tipe === "teks" && step.isiTeks) {
      await reportReply({
        tenantId: job.tenantId, waNumberId: job.waNumberId, nomor: job.nomor, kontak: job.kontak,
        pesanAsli: job.pesan, balasan: step.isiTeks, keyakinan, status: "terjawab", kanal: "Iklan",
      });
    } else if (step.tipe === "gambar" && step.urlGambar) {
      await reportReply({
        tenantId: job.tenantId, waNumberId: job.waNumberId, nomor: job.nomor, kontak: job.kontak,
        pesanAsli: job.pesan,
        balasan: step.namaGambar ? `[Gambar: ${step.namaGambar}]` : "[Gambar]",
        mediaUrl: step.urlGambar,
        mediaType: "image",
        keyakinan, status: "terjawab", kanal: "Iklan",
      });
    } else if (step.tipe === "video" && step.urlGambar) {
      await reportReply({
        tenantId: job.tenantId, waNumberId: job.waNumberId, nomor: job.nomor, kontak: job.kontak,
        pesanAsli: job.pesan,
        balasan: step.namaGambar ? `[Video: ${step.namaGambar}]` : "[Video]",
        mediaUrl: step.urlGambar,
        mediaType: "video",
        keyakinan, status: "terjawab", kanal: "Iklan",
      });
    }
  }
}

async function bumpDipakai(id: string, dipakai: number): Promise<void> {
  await db()
    .update(schema.adTemplates)
    .set({ dipakai: dipakai + 1 })
    .where(eq(schema.adTemplates.id, id));
}
