import { and, count, desc, eq, gte, ilike, lte, or, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import type { AuditLog } from '../../db/schema.js';

const t = schema.auditLogs;
const EXPORT_MAX = 10_000;

const Filters = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  user: z.string().trim().max(64).optional(),
  action: z.string().trim().max(100).optional(),
  ok: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(200).optional(),
});

const likeOf = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function whereOf(f: z.infer<typeof Filters>): SQL | undefined {
  const w: SQL[] = [];
  if (f.from) w.push(gte(t.at, f.from));
  if (f.to) w.push(lte(t.at, f.to));
  if (f.user) w.push(ilike(t.username, likeOf(f.user)));
  if (f.action) w.push(eq(t.action, f.action));
  if (f.ok) w.push(eq(t.ok, f.ok === 'true'));
  if (f.q) {
    const like = likeOf(f.q);
    w.push(or(ilike(t.target, like), ilike(t.path, like), ilike(t.username, like))!);
  }
  return w.length ? and(...w) : undefined;
}

/** RFC 4180 escaping, plus a leading ' on cells Excel would evaluate as a formula. */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS: [string, (r: AuditLog) => unknown][] = [
  ['时间', (r) => r.at.toISOString()],
  ['操作人', (r) => r.username ?? (r.userId ? r.userId : '匿名')],
  ['操作', (r) => r.action],
  ['对象', (r) => r.target],
  ['对象ID', (r) => r.targetId],
  ['方法', (r) => r.method],
  ['路径', (r) => r.path],
  ['状态码', (r) => r.status],
  ['结果', (r) => (r.ok ? '成功' : '失败')],
  ['IP', (r) => r.ip],
  ['详情', (r) => r.detail],
];

/** Audit log (操作日志). Admin only. */
export const auditRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAdmin);

  app.get('/api/audit', {
    schema: {
      querystring: Filters.extend({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).default(50).transform((n) => Math.min(200, n)),
      }),
    },
  }, async (req) => {
    const { page, pageSize, ...f } = req.query;
    const where = whereOf(f);
    const [items, [total]] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.at), desc(t.id)).limit(pageSize).offset((page - 1) * pageSize),
      db.select({ n: count() }).from(t).where(where),
    ]);
    return { items, total: total?.n ?? 0 };
  });

  app.get('/api/audit/actions', async () => {
    const rows = await db.selectDistinct({ action: t.action }).from(t).orderBy(t.action);
    return { actions: rows.map((r) => r.action) };
  });

  app.get('/api/audit/export.csv', { schema: { querystring: Filters } }, async (req, reply) => {
    const rows = await db.select().from(t).where(whereOf(req.query)).orderBy(desc(t.at), desc(t.id)).limit(EXPORT_MAX);
    const lines = [CSV_COLUMNS.map(([h]) => csvCell(h)).join(',')];
    for (const r of rows) lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(r))).join(','));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="audit-${stamp}.csv"`)
      .header('x-total-rows', String(rows.length));
    // BOM so Excel detects UTF-8 (Chinese text).
    return reply.send(`﻿${lines.join('\r\n')}\r\n`);
  });
};
