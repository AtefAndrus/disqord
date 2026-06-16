import { statSync } from "node:fs";

export interface MetricsSnapshot {
  uptime: number;
  memory: { rss: number; heapUsed: number };
  discord: { ping: number | null };
  counters: Record<string, number>;
  dbBytes: number;
  logBytes: number;
}

interface MetricsClient {
  ws: { ping: number };
}

interface LogByteSource {
  getLogBytes(): number;
}

export interface MetricsContext {
  client?: MetricsClient;
  databasePath?: string;
  logFileWriter?: LogByteSource;
}

class Metrics {
  private cumulative: Map<string, number> = new Map();
  private startedAtMs: number = Date.now();
  private context: MetricsContext = {};

  attach(ctx: MetricsContext): void {
    this.context = { ...this.context, ...ctx };
  }

  reset(): void {
    this.cumulative.clear();
    this.startedAtMs = Date.now();
    this.context = {};
  }

  increment(name: string, by = 1): void {
    if (!Number.isFinite(by) || by <= 0) return;
    this.cumulative.set(name, (this.cumulative.get(name) ?? 0) + by);
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.cumulative) counters[k] = v;

    const mem = process.memoryUsage();
    const pingRaw = this.context.client?.ws?.ping;
    const ping =
      typeof pingRaw === "number" && Number.isFinite(pingRaw) && pingRaw >= 0 ? pingRaw : null;

    return {
      uptime: Math.floor((Date.now() - this.startedAtMs) / 1000),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed },
      discord: { ping },
      counters,
      dbBytes: this.computeDbBytes(),
      logBytes: this.context.logFileWriter?.getLogBytes() ?? 0,
    };
  }

  private computeDbBytes(): number {
    const path = this.context.databasePath;
    if (!path) return 0;
    let total = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        total += statSync(path + suffix).size;
      } catch {}
    }
    return total;
  }
}

export const metrics = new Metrics();
