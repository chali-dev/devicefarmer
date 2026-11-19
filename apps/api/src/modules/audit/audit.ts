import { lt } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { db, schema } from '../../db/index.js';

/** Safety net: any key matching this is dropped from `detail`, at any depth. */
export const SENSITIVE_KEY = /pass|secret|token|key|credential|authorization/i;
const MAX_DEPTH = 6;
const MAX_ARRAY = 100;
const MAX_STRING = 500;

/** Drops sensitive keys recursively and bounds the size of what is stored. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k) || v === undefined) continue;
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface AuditEntry {
  userId?: string | null;
  username?: string | null;
  action: string;
  target?: string | null;
  targetId?: string | null;
  method: string;
  path: string;
  status: number;
  ip?: string | null;
  detail?: Record<string, unknown> | null;
}

/**
 * Fire-and-forget write. Never throws and never awaits in the caller's response path:
 * a failed audit write is logged, the request is unaffected.
 */
export function recordAudit(log: FastifyBaseLogger, e: AuditEntry): void {
  let detail: Record<string, unknown> | null = null;
  try {
    const d = e.detail ? (redact(e.detail) as Record<string, unknown>) : null;
    detail = d && Object.keys(d).length ? d : null;
  } catch (err) {
    log.warn({ err }, 'audit detail redaction failed');
  }
  void db.insert(schema.auditLogs).values({
    userId: e.userId ?? null,
    username: e.username ?? null,
    action: e.action,
    target: e.target ? e.target.slice(0, 300) : null,
    targetId: e.targetId ?? null,
    method: e.method,
    path: e.path,
    status: e.status,
    ok: e.status < 400,
    ip: e.ip ?? null,
    detail,
  }).catch((err: unknown) => log.error({ err, action: e.action }, 'audit write failed'));
}

/** Helper for routes that record explicitly (login): fills method/path/ip from the request. */
export function auditRequest(req: FastifyRequest, e: Omit<AuditEntry, 'method' | 'path' | 'ip'>): void {
  recordAudit(req.log, { ...e, method: req.method, path: req.routeOptions.url ?? req.url.split('?')[0]!, ip: req.ip });
}

/** Deletes audit entries older than `days` (系统配置 → 日志 操作日志, run by the hourly system maintenance). */
export async function purgeAuditLog(days: number): Promise<number> {
  const rows = await db.delete(schema.auditLogs).where(lt(schema.auditLogs.at, new Date(Date.now() - days * 86_400_000))).returning({ id: schema.auditLogs.id });
  return rows.length;
}
