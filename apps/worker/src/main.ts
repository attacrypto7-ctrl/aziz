import dotenv from "dotenv";
import path from "path";
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
import { Worker, Queue } from "bullmq";
import IORedis from "ioredis";
import { initWorkerDb } from "./util";
import { processChat, type ChatJob } from "./chat.processor";
import { processAd } from "./ad.processor";
import { processIndex, type IndexJob } from "./index.processor";
import { runLicenseCron } from "./license.cron";

process.on("unhandledRejection", (reason: any) => {
  if (reason?.code === "ECONNREFUSED" || reason?.message?.includes("ECONNREFUSED") || reason?.name === "AggregateError") return;
});

// =====================================================================
// Worker — proses antrian Redis (BullMQ). Jalan sebagai service terpisah
// di Railway supaya Groq yang lambat tidak mengganggu dashboard.
// Queues: chat, ad, index, outgoing (outgoing dikonsumsi wa-gateway).
// =====================================================================

async function main() {
  initWorkerDb();

  const isDev = (process.env.NODE_ENV || "development") !== "production";
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  let lastRedisWarn = 0;
  const throttledWarn = (msg: string) => {
    const now = Date.now();
    if (now - lastRedisWarn > 30000) {
      lastRedisWarn = now;
      console.warn(msg);
    }
  };
  const isConnRefused = (err: unknown) => {
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
  };
  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    retryStrategy: () => {
      throttledWarn("[worker] Redis offline - retrying in 30s...");
      return 30000;
    },
    reconnectOnError: () => false,
    lazyConnect: true,
    enableReadyCheck: false,
  });
  connection.on("error", (err) => {
    if (isConnRefused(err)) {
      throttledWarn("[worker] Redis connection failed - retrying in 30s...");
      return;
    }
    throttledWarn(`[worker] Redis error: ${(err as Error).message}`);
  });
  connection.on("close", () => throttledWarn("[worker] Redis connection failed - retrying in 30s..."));
  connection.on("connect", () => console.log("[worker] redis connecting..."));
  connection.on("ready", () => console.log("[worker] redis ready"));

  const onWorkerError = (name: string) => (err: Error) => {
    if (isConnRefused(err)) {
      throttledWarn("[worker] Redis connection failed (127.0.0.1:6379) - retrying in 30s...");
      return;
    }
    throttledWarn(`[worker] ${name} error: ${err.message}`);
  };

  let cronConnection: InstanceType<typeof IORedis> | null = null;
  try {
    const commonOpts = { connection, concurrency: 5 };

    const chatWorker = new Worker("chat", async (job) => processChat(job.data as ChatJob), commonOpts);
    chatWorker.on("error", onWorkerError("chat"));
    chatWorker.on("failed", (job) => console.warn(`[worker] chat job failed ${job?.id}`));

    const adWorker = new Worker("ad", async (job) => processAd(job.data as ChatJob), commonOpts);
    adWorker.on("error", onWorkerError("ad"));

    const indexWorker = new Worker("index", async (job) => processIndex(job.data as IndexJob), {
      ...commonOpts,
      concurrency: 2,
    });
    indexWorker.on("error", onWorkerError("index"));

    cronConnection = connection.duplicate();
    cronConnection.on("error", (err) => {
      if (isConnRefused(err)) {
        throttledWarn("[worker] Redis connection failed (127.0.0.1:6379) - retrying in 30s...");
        return;
      }
      throttledWarn(`[worker] Redis error: ${(err as Error).message}`);
    });
    cronConnection.on("close", () => throttledWarn("[worker] Redis connection failed (127.0.0.1:6379) - retrying in 30s..."));

    const cronQueue = new Queue("cron", { connection: cronConnection });
    (cronQueue as unknown as { on: (e: string, h: (err: Error) => void) => void }).on("error", (err: Error) => {
      if (isConnRefused(err)) {
        throttledWarn("[worker] Redis connection failed (127.0.0.1:6379) - retrying in 30s...");
        return;
      }
      throttledWarn(`[worker] cron queue error: ${err.message}`);
    });
    try {
      await cronQueue.upsertJobScheduler("license-check", { pattern: "0 * * * *" }, {
        name: "license-check",
        data: {},
      });
    } catch (err) {
      console.warn(`[worker] cron scheduler init failed (redis offline?) — will retry: ${err instanceof Error ? err.message : String(err)}`);
    }

    const cronWorker = new Worker("cron", async () => runLicenseCron(), { connection });
    cronWorker.on("error", onWorkerError("cron"));

    console.log("[worker] queues aktif: chat, ad, index, cron (redis retry enabled)");
  } catch (err) {
    console.warn(`[worker] Redis init failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!isDev) throw err;
    console.warn("[worker] dev mode — Redis unavailable, worker tetap berjalan (retry background)");
  }

  if (isDev) {
    process.on("unhandledRejection", (reason) => {
      if (isConnRefused(reason)) {
        throttledWarn("[worker] Redis connection failed (127.0.0.1:6379) - retrying in 30s...");
        return;
      }
      const msg = reason instanceof Error ? reason.message : String(reason);
      if (msg.includes("Connection is closed")) {
        throttledWarn("[worker] Redis connection failed (127.0.0.1:6379) - retrying in 30s...");
        return;
      }
      console.warn(`[worker] unhandledRejection: ${msg}`);
    });
    process.on("uncaughtException", (err) => {
      if (isConnRefused(err)) {
        throttledWarn("[worker] Redis connection failed (127.0.0.1:6379) - retrying in 30s...");
        return;
      }
      console.error("[worker] uncaughtException:", (err as Error).message);
    });
  }
}

main().catch((err) => {
  const isDev = (process.env.NODE_ENV || "development") !== "production";
  if (
    isDev &&
    ((err as NodeJS.ErrnoException)?.code === "ECONNREFUSED" ||
      (err instanceof Error && err.message.includes("ECONNREFUSED")))
  ) {
    console.warn("[worker] Redis connection failed (127.0.0.1:6379) - worker tetap berjalan (retry in 30s)");
    return;
  }
  console.error("[worker] fatal:", err instanceof Error ? err.message : String(err));
  if (!isDev) process.exit(1);
  console.warn("[worker] dev mode — not exiting, worker tetap berjalan meski Redis offline");
});
