// =====================================================================
// Shared Types — dipakai bersama antara backend services & frontend
// Cocok dengan frontend/src/mock/data.ts
// =====================================================================

// ---- Enums ----
export type LicenseStatus = "aktif" | "nonaktif" | "revoked" | "expired";
export type WaStatus = "tersambung" | "memindai" | "terputus";
export type Plan = "Starter" | "Growth" | "Scale";
export type AiLevel = "hemat" | "seimbang" | "akurat";
export type BotLanguage = "id" | "en" | "auto";
export type ChatChannel = "Chat" | "Iklan";
export type ChatStatus = "terjawab" | "perlu_manusia" | "diambil_alih";
export type DocTipe = "PDF" | "Teks" | "FAQ Manual";
export type DocStatus = "terindeks" | "memproses" | "gagal";
export type CaraCocokkan = "sama_persis" | "boleh_mirip";
export type StepTipe = "teks" | "gambar" | "video";
export type MessageDirection = "in" | "out";

// ---- Interfaces ----
export interface Tenant {
  id: string;
  nama: string;
  industri: string;
  plan: Plan;
  email: string;
  bergabung: string;
  status: "aktif" | "suspend";
  nomorWa: number;
  chatBulanIni: number;
  kuotaChat: number;
  tokenBulanIni: number;
  lisensiBerakhir: string;
}

export interface License {
  id: string;
  kode: string;
  tenantId: string;
  tenantNama: string;
  plan: Plan;
  status: LicenseStatus;
  dibuat: string;
  berakhir: string;
  kuotaChat: number;
}

export interface WaNumber {
  id: string;
  tenantId: string;
  label: string;
  nomor: string;
  status: WaStatus;
  terakhirAktif: string;
  autoChat: boolean;
  autoIklan: boolean;
  qrCode?: string; // base64 QR code (untuk ditampilkan di dashboard)
}

export interface KnowledgeDoc {
  id: string;
  tenantId: string;
  nama: string;
  tipe: DocTipe;
  ukuran: string;
  potongan: number;
  versi: number;
  diperbarui: string;
  status: DocStatus;
}

export interface FaqItem {
  id: string;
  tenantId: string;
  pertanyaan: string;
  jawaban: string;
}

export interface AdTemplateStep {
  id?: string;
  templateId?: string;
  urutan: number;
  tipe: StepTipe;
  isiTeks?: string;
  urlGambar?: string;
  namaGambar?: string;
  urlVideo?: string;
  namaVideo?: string;
  urlMedia?: string;
  namaMedia?: string;
}

export interface AdTemplate {
  id: string;
  tenantId: string;
  pertanyaan: string;
  jawaban?: string;
  mode?: "exact" | "fuzzy";
  caraMencocokkan: CaraCocokkan;
  aktif: boolean;
  dipakai: number;
  langkah?: AdTemplateStep[];
}

export interface ChatLog {
  id: string;
  tenantId: string;
  waNumberId?: string;
  kontak: string;
  nomor: string;
  kanal: ChatChannel;
  pesanTerakhir: string;
  balasan: string;
  waktu: string;
  keyakinan: number;
  status: ChatStatus;
}

export interface AuditEntry {
  id: string;
  tenantId?: string;
  aktor: string;
  aksi: string;
  target: string;
  waktu: string;
}

export interface DailyChat {
  hari: string;
  chat: number;
  gagal: number;
}

export interface TokenUsage {
  bulan: string;
  token: number;
}

export interface TopQuestion {
  pertanyaan: string;
  jumlah: number;
}

export interface AnalyticsData {
  chatHarian: DailyChat[];
  pemakaianToken: TokenUsage[];
  pertanyaanTeratas: TopQuestion[];
}

// ---- Bot Settings ----
export interface BotSettings {
  id: string;
  tenantId: string;
  namaBot?: string;
  gayaBahasa?: string;
  tingkatKepintaran: AiLevel;
  bahasaBalasan: BotLanguage;
  ambangAlih: number;
  autoSapaan: boolean;
  stopSetelahAdmin: boolean;
  simpanTranskrip: boolean;
  autoChatAktif: boolean;
  autoIklanAktif: boolean;
  aiEngine?: string;
  fallowUnknown: boolean;
}

// ---- AI Engine config ----
export interface AiEngine {
  id: string;
  nama: string;
  catatan: string;
}

// ---- Auth ----
export interface JwtPayload {
  sub: string;      // user/tenant ID
  email: string;
  role: "admin" | "tenant";
  nama: string;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken?: string;
  tenantId?: string;
}

// ---- Request DTOs ----
export interface CreateLicenseDto {
  tenantId: string;
  plan: Plan;
  kuotaChat: number;
  berakhir: string;
}

export interface CreateFaqDto {
  pertanyaan: string;
  jawaban: string;
}

export interface CreateAdTemplateDto {
  pertanyaan: string;
  caraMencocokkan: CaraCocokkan;
  langkah: Omit<AdTemplateStep, "id" | "templateId">[];
  aktif?: boolean;
}

export interface UpdateAdTemplateDto {
  pertanyaan?: string;
  caraMencocokkan?: CaraCocokkan;
  langkah?: Omit<AdTemplateStep, "id" | "templateId">[];
  aktif?: boolean;
}

export interface UpdateBotSettingsDto {
  namaBot?: string;
  gayaBahasa?: string;
  tingkatKepintaran?: AiLevel;
  bahasaBalasan?: BotLanguage;
  ambangAlih?: number;
  autoSapaan?: boolean;
  stopSetelahAdmin?: boolean;
  simpanTranskrip?: boolean;
  autoChatAktif?: boolean;
  autoIklanAktif?: boolean;
  aiEngine?: string;
  fallowUnknown?: boolean;
}

export interface TrialRequestDto {
  mode: "chat" | "iklan";
  message: string;
}

export interface TrialResponseDto {
  jawaban: string;
  sumber: string;
  keyakinan: number;
}

export interface IncomingMessageDto {
  tenantId: string;
  waNumberId: string;
  nomor: string;
  kontak?: string;
  pesan: string;
}

export interface OutgoingMessageDto {
  tenantId: string;
  waNumberId: string;
  nomor: string;
  pesan?: string;
  mediaUrl?: string;
  mediaType?: "image" | "video";
  caption?: string;
}

export interface KnowledgeChunk {
  id: string;
  docId: string;
  tenantId: string;
  content: string;
  embedding?: number[];
}
