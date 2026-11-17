import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { config } from '../../config.js';
import { SENSITIVE_KEY } from '../audit/audit.js';

/**
 * System logs (系统日志, admin): the API's pino output (request logs included) is teed by `logSink`:
 * stdout gets exactly what pino wrote, and a redacted copy goes to an in-memory ring of the last
 * LOG_RING_SIZE lines and to daily files `LOG_DIR/api-YYYY-MM-DD.log` (UTC day; retention in settings,
 * deleted by the hourly maintenance). Redaction: values of keys matching the audit rule
 * (pass|secret|token|key|credential|authorization) and secret-looking substrings in text
 * (`token=…`, `"apiKey": "…"`, `Bearer …`, URL credentials) become `[redacted]`.
 */

export const REDACTED = '[redacted]';
const SECRET_PAIR = /([\w-]*(?:pass|secret|token|key|credential|authorization)[\w-]*)(["']?\s*[:=]\s*["']?)([^\s"'&,;}]+)/gi;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_CREDENTIALS = /([a-z][\w+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
const MAX_DEPTH = 8;

export function redactText(s: string): string {
  return s
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(AUTH_SCHEME, `$1 ${REDACTED}`)
    .replace(SECRET_PAIR, (_m, k: string, sep: string) => `${k}${sep}${REDACTED}`);
}

/** Redacts a parsed log line: sensitive keys at any depth and secret-looking text in strings. */
export function redactLog(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => redactLog(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) && v !== null && v !== undefined && v !== '' ? REDACTED : redactLog(v, depth + 1);
  }
  return out;
}

export const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
export type LevelName = keyof typeof LEVELS;
export interface LogEntry { time: number; level: number; msg?: string; [k: string]: unknown }
interface Stored { entry: LogEntry; line: string }

const ring: (Stored | undefined)[] = new Array(config.LOG_RING_SIZE);
let head = 0; // next write position
let count = 0;

const dir = path.resolve(config.LOG_DIR);
let file: { day: string; stream: fs.WriteStream } | null = null;
let fileError = false;

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fileFor = (day: string) => path.join(dir, `api-${day}.log`);

function appendFile(line: string, time: number): void {
  const day = dayOf(time);
  if (file?.day !== day) {
    file?.stream.end();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reported by the stream */ }
    const stream = fs.createWriteStream(fileFor(day), { flags: 'a' });
    stream.on('error', (err) => {
      if (!fileError) process.stderr.write(`log file ${fileFor(day)} not writable: ${err.message}\n`);
      fileError = true;
    });
    file = { day, stream };
  }
  file.stream.write(`${line}\n`);
}

function ingest(raw: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = { time: Date.now(), level: LEVELS.info, msg: raw }; }
  if (!parsed || typeof parsed !== 'object') return;
  const entry = redactLog(parsed) as LogEntry;
  if (typeof entry.time !== 'number') entry.time = Date.now();
  if (typeof entry.level !== 'number') entry.level = LEVELS.info;
  const line = JSON.stringify(entry);
  ring[head] = { entry, line };
  head = (head + 1) % ring.length;
  count = Math.min(count + 1, ring.length);
  appendFile(line, entry.time);
}

/** pino destination (Fastify `logger.stream`): stdout unchanged, plus the redacted ring and files. */
export const logSink = {
  write(chunk: string): void {
    process.stdout.write(chunk);
    for (const raw of chunk.split('\n')) {
      if (!raw.trim()) continue;
      try { ingest(raw); } catch { /* logging must never break the API */ }
    }
  },
};

export interface LogQuery { level?: LevelName; q?: string; from?: Date; to?: Date; limit: number; date?: string }

function matcher(q: LogQuery): (s: Stored) => boolean {
  const min = q.level ? LEVELS[q.level] : 0;
  const text = q.q?.toLowerCase();
  const from = q.from?.getTime() ?? -Infinity;
  const to = q.to?.getTime() ?? Infinity;
  return (s) => s.entry.level >= min && s.entry.time >= from && s.entry.time <= to && (!text || s.line.toLowerCase().includes(text));
}

/**
 * Newest first. Without `date` the in-memory ring is searched (since this process started, last
 * LOG_RING_SIZE lines); with `date` (YYYY-MM-DD, UTC) that day's file, keeping the last `limit` matches.
 */
export async function readLogs(q: LogQuery): Promise<{ source: 'memory' | 'file'; entries: LogEntry[]; capacity: number }> {
  const match = matcher(q);
  if (!q.date) {
    const out: LogEntry[] = [];
    for (let i = 1; i <= count && out.length < q.limit; i++) {
      const s = ring[(head - i + ring.length) % ring.length];
      if (s && match(s)) out.push(s.entry);
    }
    return { source: 'memory', entries: out, capacity: ring.length };
  }
  const f = fileFor(q.date);
  if (!fs.existsSync(f)) return { source: 'file', entries: [], capacity: ring.length };
  const kept: LogEntry[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(f, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let entry: LogEntry;
    try { entry = JSON.parse(line) as LogEntry; } catch { continue; }
    if (!match({ entry, line })) continue;
    kept.push(entry);
    if (kept.length > q.limit) kept.shift();
  }
  return { source: 'file', entries: kept.reverse(), capacity: ring.length };
}

const FILE_RE = /^api-(\d{4}-\d{2}-\d{2})\.log$/;

export async function listLogFiles(): Promise<{ date: string; size: number }[]> {
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const out: { date: string; size: number }[] = [];
  for (const n of names) {
    const m = FILE_RE.exec(n);
    if (!m) continue;
    const st = await fs.promises.stat(path.join(dir, n)).catch(() => null);
    if (st) out.push({ date: m[1]!, size: st.size });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** Deletes daily files older than `days` (today's file counts as day 1). Returns the deleted dates. */
export async function purgeLogFiles(days: number, now = Date.now()): Promise<string[]> {
  const cutoff = dayOf(now - (days - 1) * 86_400_000);
  const deleted: string[] = [];
  for (const f of await listLogFiles()) {
    if (f.date >= cutoff) continue;
    await fs.promises.unlink(fileFor(f.date)).then(() => deleted.push(f.date), () => undefined);
  }
  return deleted;
}
