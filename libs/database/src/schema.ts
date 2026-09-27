import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  real,
  index,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// TENANTS
// ---------------------------------------------------------------------------
export const tenants = pgTable("tenants", {
  id: uuid().primaryKey().defaultRandom(),
  nama: varchar({ length: 255 }).notNull(),
  industri: varchar({ length: 255 }).notNull(),
  plan: varchar({ length: 16 }).notNull().default("Starter"),
  email: varchar({ length: 255 }).notNull().unique(),
  bergabung: timestamp({ withTimezone: true }).notNull().defaultNow(),
  status: varchar({ length: 16 }).notNull().default("aktif"),
  nomorWa: integer("nomor_wa").notNull().default(0),
  chatBulanIni: integer("chat_bulan_ini").notNull().default(0),
  kuotaChat: integer("kuota_chat").notNull().default(3000),
  tokenBulanIni: integer("token_bulan_ini").notNull().default(0),
  lisensiBerakhir: timestamp("lisensi_berakhir", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// LICENSES
// ---------------------------------------------------------------------------
export const licenses = pgTable("licenses", {
  id: uuid().primaryKey().defaultRandom(),
  kode: varchar({ length: 32 }).notNull().unique(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  plan: varchar({ length: 16 }).notNull(),
  status: varchar({ length: 16 }).notNull().default("nonaktif"),
  dibuat: timestamp({ withTimezone: true }).notNull().defaultNow(),
  berakhir: timestamp({ withTimezone: true }).notNull(),
  kuotaChat: integer("kuota_chat").notNull().default(999999),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// WA_NUMBERS
// ---------------------------------------------------------------------------
export const waNumbers = pgTable("wa_numbers", {
  id: uuid().primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  label: varchar({ length: 255 }).notNull(),
  nomor: varchar({ length: 32 }).notNull(),
  status: varchar({ length: 16 }).notNull().default("terputus"),
  terakhirAktif: timestamp("terakhir_aktif", { withTimezone: true }),
  autoChat: boolean("auto_chat").notNull().default(true),
  autoIklan: boolean("auto_iklan").notNull().default(true),
    sessionEncrypted: text("session_encrypted"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// KNOWLEDGE_DOCS
// ---------------------------------------------------------------------------
export const knowledgeDocs = pgTable("knowledge_docs", {
  id: uuid().primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  nama: varchar({ length: 255 }).notNull(),
  tipe: varchar({ length: 16 }).notNull().default("Teks"),
  ukuran: varchar({ length: 32 }),
  potongan: integer("potongan").notNull().default(0),
  versi: integer("versi").notNull().default(1),
  diperbarui: timestamp({ withTimezone: true }).notNull().defaultNow(),
  status: varchar({ length: 16 }).notNull().default("memproses"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// KNOWLEDGE_CHUNKS (dengan pgvector embedding)
// ---------------------------------------------------------------------------
export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid().primaryKey().defaultRandom(),
    docId: uuid("doc_id").notNull().references(() => knowledgeDocs.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    content: text().notNull(),
    embedding: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantDocIdx: index("idx_knowledge_chunks_tenant_doc").on(table.tenantId, table.docId),
  }),
);

// ---------------------------------------------------------------------------
// FAQ_ITEMS
// ---------------------------------------------------------------------------
export const faqItems = pgTable("faq_items", {
  id: uuid().primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  pertanyaan: text().notNull(),
    jawaban: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// AD_TEMPLATES
// ---------------------------------------------------------------------------
export const adTemplates = pgTable("ad_templates", {
  id: uuid().primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  pertanyaan: text().notNull(),
  jawaban: text(),
  mode: varchar({ length: 16 }),
  caraMencocokkan: varchar("cara_mencocokkan", { length: 16 }).notNull().default("boleh_mirip"),
  aktif: boolean().notNull().default(true),
  dipakai: integer("dipakai").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// AD_TEMPLATE_STEPS
// ---------------------------------------------------------------------------
export const adTemplateSteps = pgTable("ad_template_steps", {
  id: uuid().primaryKey().defaultRandom(),
  templateId: uuid("template_id").notNull().references(() => adTemplates.id, { onDelete: "cascade" }),
  urutan: integer().notNull(),
  tipe: varchar({ length: 16 }).notNull().default("teks"),
  isiTeks: text("isi_teks"),
  urlGambar: varchar("url_gambar", { length: 512 }),
    namaGambar: varchar("nama_gambar", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// CHAT_LOGS
// ---------------------------------------------------------------------------
export const chatLogs = pgTable("chat_logs", {
  id: uuid().primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  waNumberId: uuid("wa_number_id").references(() => waNumbers.id),
  kontak: varchar({ length: 255 }).notNull(),
  nomor: varchar({ length: 32 }).notNull(),
  kanal: varchar({ length: 16 }).notNull().default("Chat"),
  pesanTerakhir: text("pesan_terakhir").notNull(),
  balasan: text(),
  waktu: timestamp({ withTimezone: true }).notNull().defaultNow(),
  keyakinan: real().notNull().default(0),
  status: varchar({ length: 20 }).notNull().default("perlu_manusia"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index("idx_chat_logs_tenant").on(table.tenantId),
  waktuIdx: index("idx_chat_logs_waktu").on(table.tenantId, table.waktu),
}));

// ---------------------------------------------------------------------------
// USAGE_LOGS
// ---------------------------------------------------------------------------
export const usageLogs = pgTable("usage_logs", {
  id: uuid().primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  model: varchar({ length: 128 }).notNull(),
  tokensInput: integer("tokens_input").notNull(),
  tokensOutput: integer("tokens_output").notNull(),
  costCents: integer("cost_cents").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index("idx_usage_logs_tenant").on(table.tenantId),
  dayIdx: index("idx_usage_logs_day").on(table.tenantId, table.createdAt),
}));

// ---------------------------------------------------------------------------
// AUDIT_LOG
// ---------------------------------------------------------------------------
export const auditLog = pgTable("audit_log", {
  id: uuid().primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id),
  aktor: varchar({ length: 255 }).notNull(),
  aksi: varchar({ length: 255 }).notNull(),
  target: varchar({ length: 512 }),
  waktu: timestamp({ withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index("idx_audit_log_tenant").on(table.tenantId),
  waktuIdx: index("idx_audit_log_waktu").on(table.waktu),
}));

// ---------------------------------------------------------------------------
// BOT_SETTINGS
// ---------------------------------------------------------------------------
export const botSettings = pgTable("bot_settings", {
  id: uuid().primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  namaBot: varchar("nama_bot", { length: 255 }),
  gayaBahasa: text("gaya_bahasa"),
  tingkatKepintaran: varchar("tingkat_kepintaran", { length: 16 }).notNull().default("hemat"),
  bahasaBalasan: varchar("bahasa_balasan", { length: 16 }).notNull().default("id"),
  ambangAlih: integer("ambang_alih").notNull().default(60),
  autoSapaan: boolean("auto_sapaan").notNull().default(true),
  stopSetelahAdmin: boolean("stop_setelah_admin").notNull().default(true),
  simpanTranskrip: boolean("simpan_transkrip").notNull().default(true),
  autoChatAktif: boolean("auto_chat_aktif").notNull().default(true),
  autoIklanAktif: boolean("auto_iklan_aktif").notNull().default(true),
  aiEngine: varchar("ai_engine", { length: 64 }),
    fallowUnknown: boolean("fallow_unknown").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// MESSAGE_QUEUE (audit fallback)
// ---------------------------------------------------------------------------
export const messageQueue = pgTable("message_queue", {
  id: uuid().primaryKey().defaultRandom(),
  direction: varchar({ length: 4 }).notNull(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  waNumberId: uuid("wa_number_id").references(() => waNumbers.id),
  nomor: varchar({ length: 32 }).notNull(),
  kontak: varchar({ length: 255 }),
  pesan: text().notNull(),
  status: varchar({ length: 20 }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// ADMIN_USERS: akun admin platform
// ---------------------------------------------------------------------------
export const adminUsers = pgTable("admin_users", {
  id: uuid().primaryKey().defaultRandom(),
  email: varchar({ length: 255 }).notNull().unique(),
  passwordHash: text("password_hash"),
  nama: varchar({ length: 255 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Schema export for Drizzle
// ---------------------------------------------------------------------------
export const dbSchema = {
  tenants,
  licenses,
  waNumbers,
  knowledgeDocs,
  knowledgeChunks,
  faqItems,
  adTemplates,
  adTemplateSteps,
  chatLogs,
  usageLogs,
  auditLog,
  botSettings,
  messageQueue,
  adminUsers,
};
