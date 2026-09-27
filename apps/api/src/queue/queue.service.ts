import { Injectable, OnModuleInit, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";

/**
 * QueueService — manajemen Redis/BullMQ queues.
 * Menyediakan:
 *  - chatQueue         (untuk proses balas chat via Groq + RAG)
 *  - adQueue           (untuk proses balas iklan via template matching)
 *  - indexQueue        (untuk proses indexing dokumen → embedding)
 *  - outgoingQueue     (untuk kirim pesan ke WhatsApp via wa-gateway)
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);

  chatQueue!: Queue;
  adQueue!: Queue;
  indexQueue!: Queue;
  outgoingQueue!: Queue;
  scheduler!: QueueEvents;

  private redisUrl: string;
  private connection!: IORedis;
  private lastRedisWarn = 0;

  constructor(private configService: ConfigService) {
    this.redisUrl = configService.get<string>("redisUrl") || "redis://localhost:6379";
  }

  private isSilentRedisError(err: unknown): boolean {
    const m = err instanceof Error ? err.message : String(err);
    const c = (err as NodeJS.ErrnoException)?.code ?? "";
    const n = (err as any)?.name ?? "";
    return (
      n === "AggregateError" ||
      c === "ECONNREFUSED" ||
      c === "ECONNRESET" ||
      m.includes("ECONNREFUSED") ||
      m.includes("ECONNRESET") ||
      m.includes("closed") ||
      m.includes("Connection is closed")
    );
  }

  private throttledWarn(msg: string) {
    const now = Date.now();
    if (now - this.lastRedisWarn > 30000) {
      this.lastRedisWarn = now;
      this.logger.warn(msg);
    }
  }

  private attachSilentErrorHandler(target: { on: (ev: string, h: (err: any) => void) => unknown }, label: string) {
    (target as any).on("error", (err: unknown) => {
      if (this.isSilentRedisError(err)) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.throttledWarn(`[Redis] ${label} error: ${msg}`);
    });
  }

  async onModuleInit() {
    try {
      this.connection = new IORedis(this.redisUrl, {
        host: "127.0.0.1",
        family: 4,
        maxRetriesPerRequest: null,
        enableOfflineQueue: false,
        retryStrategy: () => {
          this.throttledWarn("[Redis] Connection failed (127.0.0.1) - retrying in 30s...");
          return 30000;
        },
        reconnectOnError: () => false,
        lazyConnect: true,
        enableReadyCheck: false,
      });
      this.connection.on("error", (err) => {
        if (this.isSilentRedisError(err)) {
          this.throttledWarn("[Redis] Connection failed (127.0.0.1) - retrying in 30s...");
          return;
        }
        this.throttledWarn(`[Redis] error: ${(err as Error).message}`);
      });
      this.connection.on("close", () => this.throttledWarn("[Redis] Connection failed (127.0.0.1) - retrying in 30s..."));
      const opts = { connection: this.connection };

      this.chatQueue = new Queue("chat", opts);
      this.adQueue = new Queue("ad", opts);
      this.indexQueue = new Queue("index", opts);
      this.outgoingQueue = new Queue("outgoing", opts);
      this.scheduler = new QueueEvents("csai-scheduler", opts);
      this.attachSilentErrorHandler(this.chatQueue as unknown as { on: (ev: string, h: (err: any) => void) => unknown }, "chat");
      this.attachSilentErrorHandler(this.adQueue as unknown as { on: (ev: string, h: (err: any) => void) => unknown }, "ad");
      this.attachSilentErrorHandler(this.indexQueue as unknown as { on: (ev: string, h: (err: any) => void) => unknown }, "index");
      this.attachSilentErrorHandler(this.outgoingQueue as unknown as { on: (ev: string, h: (err: any) => void) => unknown }, "outgoing");
      this.attachSilentErrorHandler(this.scheduler as unknown as { on: (ev: string, h: (err: any) => void) => unknown }, "scheduler");
      this.scheduler.on("failed", ({ jobId }) => this.logger.warn(`Queue job failed ${jobId}`));

      this.logger.log("Redis/BullMQ queues initialized");
    } catch (err) {
      if (this.isSilentRedisError(err)) {
        this.throttledWarn("[Redis] Connection failed (127.0.0.1) - retrying in 30s...");
        this.logger.warn("Dev mode — Redis unavailable, queues disabled gracefully");
        return;
      }
      const isDev = (process.env.NODE_ENV || "development") !== "production";
      this.logger.warn(`Redis init failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!isDev) throw err as Error;
      this.logger.warn("Dev mode — Redis unavailable, queues disabled gracefully");
    }
  }

  async onModuleDestroy() {
    await this.scheduler?.close().catch(() => undefined);
    await this.chatQueue?.close().catch(() => undefined);
    await this.adQueue?.close().catch(() => undefined);
    await this.indexQueue?.close().catch(() => undefined);
    await this.outgoingQueue?.close().catch(() => undefined);
    this.connection?.disconnect();
  }

  // Convenience: enqueue incoming WhatsApp message
  async enqueueIncomingMessage(data: IncomingMessageData) {
    if (data.kanal === "Iklan") {
      await this.adQueue.add("process-ad", data, { attempts: 3, backoff: { type: "exponential", delay: 5000 } });
    } else {
      await this.chatQueue.add("process-chat", data, { attempts: 3, backoff: { type: "exponential", delay: 5000 } });
    }
  }

  // Convenience: enqueue outgoing message
  async enqueueOutgoingMessage(data: OutgoingMessageData) {
    await this.outgoingQueue.add("send-wa", data, { attempts: 3, backoff: { type: "exponential", delay: 5000 } });
  }

  // Convenience: enqueue document indexing
  async enqueueIndexing(data: IndexingData) {
    await this.indexQueue.add("index-doc", data, { attempts: 2, backoff: { type: "exponential", delay: 10000 } });
  }
}

export interface IncomingMessageData {
  tenantId: string;
  waNumberId: string;
  nomor: string;
  kontak?: string;
  pesan: string;
  kanal: "Chat" | "Iklan";
}

export interface OutgoingMessageData {
  tenantId: string;
  waNumberId: string;
  nomor: string;
  pesan?: string;
  mediaUrl?: string;
  mediaType?: "image" | "video";
  caption?: string;
}

export interface IndexingData {
  tenantId: string;
  docId: string;
  content: string;
  tipe: "PDF" | "Teks" | "FAQ Manual";
}
