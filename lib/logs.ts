import { promises as fs } from "node:fs";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/** Where captured logs live. One JSONL file per app. */
export function logDir(): string {
  return process.env.ONEOPS_LOG_DIR || path.join(os.homedir(), ".1ops", "logs");
}

export function logPath(app: string): string {
  return path.join(logDir(), `${app}.jsonl`);
}

export type Level = "error" | "warn" | "info";

export interface LogEntry {
  ts: number; // epoch ms
  level: Level;
  line: string;
  stream: "out" | "err";
}

/** Cheap heuristic so `--errors` actually means something without app cooperation. */
export function detectLevel(line: string, stream: "out" | "err"): Level {
  if (/\b(error|err|exception|fatal|unhandled|panic|traceback)\b/i.test(line)) return "error";
  if (/\b(warn|warning|deprecat)\b/i.test(line)) return "warn";
  // stderr alone isn't an error (progress bars, etc.), so don't force it.
  return "info";
}

export function ensureLogDir(): void {
  const d = logDir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

export async function appendLog(app: string, entry: LogEntry): Promise<void> {
  ensureLogDir();
  await fs.appendFile(logPath(app), JSON.stringify(entry) + "\n", "utf8");
}

/** Synchronous append — used by `1ops run` so a fast-exiting child can't drop lines. */
export function appendLogSync(app: string, entry: LogEntry): void {
  ensureLogDir();
  appendFileSync(logPath(app), JSON.stringify(entry) + "\n", "utf8");
}

export interface ReadOpts {
  level?: Level; // minimum level: "error" => only errors; "warn" => warn+error
  sinceMs?: number; // only entries with ts >= sinceMs
  lines?: number; // cap to the last N matching entries
}

const RANK: Record<Level, number> = { info: 0, warn: 1, error: 2 };

export async function readLogs(app: string, opts: ReadOpts = {}): Promise<LogEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(logPath(app), "utf8");
  } catch {
    return [];
  }
  let entries = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as LogEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is LogEntry => e !== null);

  if (opts.level) entries = entries.filter((e) => RANK[e.level] >= RANK[opts.level!]);
  if (opts.sinceMs) entries = entries.filter((e) => e.ts >= opts.sinceMs!);
  if (opts.lines && entries.length > opts.lines) entries = entries.slice(-opts.lines);
  return entries;
}

/** "5m" "30s" "2h" "1d" -> ms. Returns undefined if unparseable. */
export function parseSince(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.match(/^(\d+)\s*([smhd])$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as "s" | "m" | "h" | "d"];
  return Date.now() - n * mult;
}
