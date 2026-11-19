import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { PROXY_KINDS, type Instance, type PoolProxy, type ProxyCheck } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { openSecret, sealSecret } from '../../lib/secret-box.js';
import { isAdmin } from '../auth/rbac.js';
import { enqueue } from '../instances/queue.js';
import { publishInstance, updateInstance } from '../instances/repo.js';
import {
  checkPoolProxy, endpointKey, probeProxy, endpointText, HOST_RE, isUniqueViolation, mapLimit, maskedLine, parseProxyLine, toPublicProxy, type ParsedProxy,
} from './pool.js';

const BUSY: Instance['status'][] = ['creating', 'starting', 'stopping', 'restarting', 'deleting'];
const MAX_IMPORT_LINES = 1000;
const CHECK_CONCURRENCY = 8;
const BATCH_MAX = 500;

const opt = (max: number) => z.string().trim().max(max).nullable().optional();
const Fields = {
  label: opt(80),
  country: opt(64),
  region: opt(80),
  city: opt(80),
  provider: opt(80),
  notes: opt(500),
};
const Kind = z.enum(PROXY_KINDS);
const Endpoint = {
  type: z.enum(['socks5', 'http']),
  host: z.string().trim().min(1).max(253).regex(HOST_RE, 'hostname or IPv4'),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(200).nullable().optional(),
};
const CreateBody = z.object({ ...Endpoint, kind: Kind.default('static'), password: z.string().max(200).nullable().optional(), ...Fields });
/** Password is write-only: omitted = keep, null/'' = clear, string = replace. */
const UpdateBody = z.object({
  type: Endpoint.type.optional(), kind: Kind.optional(), host: Endpoint.host.optional(), port: Endpoint.port.optional(), username: Endpoint.username,
  password: z.string().max(200).nullable().optional(), ...Fields,
});
const IdParams = z.object({ id: z.string().uuid() });
/** Unsaved configuration to probe. With `id` (editing), an empty password falls back to the stored one. */
const TestBody = z.object({ ...Endpoint, password: z.string().max(200).nullable().optional(), id: z.string().uuid().optional() });

const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v);

async function boundMap(ids?: string[]): Promise<Map<string, { id: string; name: string }>> {
  const q = db.select({ id: schema.instances.id, name: schema.instances.name, proxyId: schema.instances.proxyId }).from(schema.instances);
  const rows = await (ids ? q.where(inArray(schema.instances.proxyId, ids)) : q.where(sql`${schema.instances.proxyId} is not null`));
  return new Map(rows.map((r) => [r.proxyId!, { id: r.id, name: r.name }]));
}

async function mustGet(id: string): Promise<PoolProxy> {
  const [p] = await db.select().from(schema.proxies).where(eq(schema.proxies.id, id));
  if (!p) throw notFound('代理不存在', 'proxy.not_found');
  return p;
}

const duplicate = () => conflict('代理池中已存在相同的代理（类型、地址、端口、用户名相同）', 'proxy.duplicate');

/** Proxy pool (代理管理): admin only. Users only see their devices' proxy via the instance API (no credentials). */
export const proxyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', async (req) => {
    if (!isAdmin(req.user)) throw forbidden('仅管理员可以管理代理池', 'proxy.admin_only');
  });

  app.get('/api/proxies', {
    schema: {
      querystring: z.object({
        status: z.enum(['unchecked', 'ok', 'failed']).optional(),
        kind: Kind.optional(),
        bound: z.enum(['bound', 'free']).optional(),
        q: z.string().trim().max(200).optional(),
        country: z.string().trim().max(64).optional(),
      }),
    },
  }, async (req) => {
    const { status, kind, bound, q, country } = req.query;
    const where: SQL[] = [];
    if (status) where.push(eq(schema.proxies.status, status));
    if (kind) where.push(eq(schema.proxies.kind, kind));
    if (country) where.push(ilike(schema.proxies.country, country));
    // Several terms separated by commas (or Chinese commas) match any of them.
    const terms = (q ?? '').split(/[,，]/).map((t) => t.trim()).filter(Boolean).slice(0, 20);
    if (terms.length) {
      where.push(or(...terms.map((t) => {
        const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        return or(ilike(schema.proxies.label, like), ilike(schema.proxies.host, like), ilike(schema.proxies.provider, like),
          ilike(schema.proxies.notes, like), ilike(schema.proxies.city, like), sql`${schema.proxies.lastCheck}->>'egressIp' ilike ${like}`)!;
      }))!);
    }
    const used = sql`exists (select 1 from ${schema.instances} i where i.proxy_id = ${schema.proxies.id})`;
    if (bound === 'bound') where.push(used);
    if (bound === 'free') where.push(sql`not ${used}`);
    const rows = await db.select().from(schema.proxies).where(where.length ? and(...where) : undefined).orderBy(schema.proxies.createdAt);
    const b = await boundMap();
    // Per-kind totals for the tab badges (unfiltered).
    const kc = await db.select({ kind: schema.proxies.kind, n: sql<number>`count(*)::int` }).from(schema.proxies).groupBy(schema.proxies.kind);
    const kindCounts = Object.fromEntries(PROXY_KINDS.map((k) => [k, kc.find((r) => r.kind === k)?.n ?? 0]));
    return { proxies: rows.map((p) => toPublicProxy(p, b.get(p.id) ?? null)), kindCounts };
  });

  app.post('/api/proxies', { schema: { body: CreateBody } }, async (req, reply) => {
    const { password, username, label, country, region, city, provider, notes, ...ep } = req.body;
    const user = blankToNull(username) ?? null;
    const pw = blankToNull(password) ?? null;
    if (pw && !user) throw badRequest('设置密码时必须填写用户名', 'proxy.password_without_username');
    const [row] = await db.insert(schema.proxies).values({
      ...ep, username: user, passwordEnc: pw ? sealSecret(pw) : null,
      label: blankToNull(label), country: blankToNull(country), region: blankToNull(region), city: blankToNull(city),
      provider: blankToNull(provider), notes: blankToNull(notes),
    }).returning().catch((err) => { throw isUniqueViolation(err, 'proxies_endpoint_unique') ? duplicate() : err; });
    reply.code(201);
    return { proxy: toPublicProxy(row!, null) };
  });

  /**
   * Edit a pool entry. If the endpoint or credentials change, the status resets to unchecked and a
   * bound device gets the new settings hot-applied (set-proxy task).
   */
  app.put('/api/proxies/:id', { schema: { params: IdParams, body: UpdateBody } }, async (req) => {
    const cur = await mustGet(req.params.id);
    const b = req.body;
    const set: Partial<typeof schema.proxies.$inferInsert> = {};
    for (const k of ['label', 'country', 'region', 'city', 'provider', 'notes'] as const) {
      const v = blankToNull(b[k]);
      if (v !== undefined) set[k] = v;
    }
    if (b.kind !== undefined && b.kind !== cur.kind) set.kind = b.kind;
    if (b.type !== undefined && b.type !== cur.type) set.type = b.type;
    if (b.host !== undefined && b.host !== cur.host) set.host = b.host;
    if (b.port !== undefined && b.port !== cur.port) set.port = b.port;
    const user = blankToNull(b.username);
    if (user !== undefined && user !== cur.username) set.username = user;
    const pw = blankToNull(b.password);
    if (pw !== undefined) set.passwordEnc = pw ? sealSecret(pw) : null;
    const finalUser = set.username !== undefined ? set.username : cur.username;
    const finalPw = set.passwordEnc !== undefined ? set.passwordEnc : cur.passwordEnc;
    if (finalPw && !finalUser) throw badRequest('设置密码时必须填写用户名', 'proxy.password_without_username');
    const connChanged = ['type', 'host', 'port', 'username', 'passwordEnc'].some((k) => k in set);
    const [holder] = await db.select().from(schema.instances).where(eq(schema.instances.proxyId, cur.id));
    if (connChanged && holder && BUSY.includes(holder.status)) {
      throw conflict(`绑定的设备 ${holder.name} 正忙（${holder.status}），请稍后再改`, 'proxy.bound_busy', { name: holder.name, status: holder.status });
    }
    if (connChanged) { set.status = 'unchecked'; set.lastCheck = null; }
    if (!Object.keys(set).length) return { proxy: toPublicProxy(cur, holder ? { id: holder.id, name: holder.name } : null), taskId: null };
    const [row] = await db.update(schema.proxies).set(set).where(eq(schema.proxies.id, cur.id)).returning()
      .catch((err) => { throw isUniqueViolation(err, 'proxies_endpoint_unique') ? duplicate() : err; });
    let taskId: string | null = null;
    if (holder) {
      // Device view shows label/host/geo: broadcast; on connection change re-apply to the sidecar.
      if (connChanged) await updateInstance(holder.id, { proxyStatus: null });
      else await publishInstance(holder);
      if (connChanged) taskId = await enqueue('set-proxy', holder, req.user.id, {}, `${row!.type}://${row!.host}:${row!.port}`);
    }
    return { proxy: toPublicProxy(row!, holder ? { id: holder.id, name: holder.name } : null), taskId };
  });

  app.delete('/api/proxies/:id', { schema: { params: IdParams } }, async (req, reply) => {
    const p = await mustGet(req.params.id);
    const holder = (await boundMap([p.id])).get(p.id);
    const bound = (name: string) => conflict(`代理 ${endpointText(p)} 已绑定到设备 ${name}，请先解绑`, 'proxy.bound', { proxy: endpointText(p), name });
    if (holder) throw bound(holder.name);
    await db.delete(schema.proxies).where(eq(schema.proxies.id, p.id)).catch((err) => {
      // Bound concurrently: the FK (ON DELETE RESTRICT) refuses.
      if ((err as { code?: string; cause?: { code?: string } }).code === '23503' || (err as { cause?: { code?: string } }).cause?.code === '23503') throw bound('?');
      throw err;
    });
    reply.code(204);
  });

  /**
   * Batch actions (批量操作). An unknown id fails the whole batch with 404 and changes nothing.
   * - delete: same rule as the single delete: a proxy bound to a device is skipped (`proxy.bound`), the others are deleted.
   *   Rows are locked FOR UPDATE, so a concurrent bind (which locks the same rows) waits for the batch.
   * - set-kind: moves every row to `kind` (static/mobile); `changed` counts rows that had another kind.
   */
  app.post('/api/proxies/batch', {
    schema: {
      body: z.object({
        ids: z.array(z.string().uuid()).min(1).max(BATCH_MAX),
        action: z.enum(['delete', 'set-kind']),
        kind: Kind.optional(),
      }),
    },
  }, async (req) => {
    const { action, kind } = req.body;
    if (action === 'set-kind' && !kind) throw badRequest('kind is required', 'proxy.batch_kind_required');
    const ids = [...new Set(req.body.ids)];
    const res = await db.transaction(async (tx) => {
      const rows = await tx.select().from(schema.proxies).where(inArray(schema.proxies.id, ids)).for('update');
      if (rows.length !== ids.length) throw notFound('代理不存在', 'proxy.not_found');
      const ok: string[] = [];
      const skipped: { id: string; code: string; params?: Record<string, string> }[] = [];
      if (action === 'set-kind') {
        const changed = await tx.update(schema.proxies).set({ kind: kind! })
          .where(and(inArray(schema.proxies.id, ids), sql`${schema.proxies.kind} <> ${kind!}`)).returning({ id: schema.proxies.id });
        return { ok: ids, skipped, changed: changed.length };
      }
      const holders = await tx.select({ name: schema.instances.name, proxyId: schema.instances.proxyId })
        .from(schema.instances).where(inArray(schema.instances.proxyId, ids));
      const byProxy = new Map(holders.map((h) => [h.proxyId!, h.name]));
      for (const p of rows) {
        const name = byProxy.get(p.id);
        if (name) skipped.push({ id: p.id, code: 'proxy.bound', params: { proxy: endpointText(p), name } });
        else ok.push(p.id);
      }
      if (ok.length) await tx.delete(schema.proxies).where(inArray(schema.proxies.id, ok));
      return { ok, skipped, changed: ok.length };
    });
    // (The device view of a proxy has no kind, so a kind change needs no device broadcast.)
    if (req.audit) req.audit.extra = { ok: res.ok.length, skipped: res.skipped.length, changed: res.changed };
    return { ok: res.ok, skipped: res.skipped, changed: res.changed };
  });

  /** Bulk import, one proxy per line. `dryRun` returns the per-line preview without inserting. */
  app.post('/api/proxies/import', {
    schema: {
      body: z.object({
        text: z.string().max(200_000),
        defaultType: z.enum(['socks5', 'http']).default('socks5'),
        dryRun: z.boolean().default(false),
        kind: Kind.default('static'),
        provider: opt(80), country: opt(64),
      }),
    },
  }, async (req) => {
    const { text, defaultType, dryRun } = req.body;
    const lines = text.split(/\r?\n/).map((l, i) => ({ line: i + 1, raw: l.trim() })).filter((l) => l.raw && !l.raw.startsWith('#'));
    if (lines.length > MAX_IMPORT_LINES) throw conflict(`一次最多导入 ${MAX_IMPORT_LINES} 行`, 'proxy.import_too_many', { max: MAX_IMPORT_LINES });
    type Result = { line: number; input: string; status: 'created' | 'duplicate' | 'invalid'; id?: string; error?: string };
    const results: Result[] = [];
    const parsed: { line: number; p: ParsedProxy }[] = [];
    const seen = new Set<string>();
    for (const { line, raw } of lines) {
      const p = parseProxyLine(raw, defaultType);
      if (typeof p === 'string') { results.push({ line, input: raw.replace(/:[^:@/]*@/, ':***@').slice(0, 120), status: 'invalid', error: p }); continue; }
      const key = endpointKey(p);
      if (seen.has(key)) { results.push({ line, input: maskedLine(p), status: 'duplicate', error: 'duplicate line' }); continue; }
      seen.add(key);
      parsed.push({ line, p });
    }
    // Existing entries with the same endpoint identity.
    const existing = new Set<string>();
    if (parsed.length) {
      const rows = await db.select({ type: schema.proxies.type, host: schema.proxies.host, port: schema.proxies.port, username: schema.proxies.username })
        .from(schema.proxies).where(inArray(sql`lower(${schema.proxies.host})`, [...new Set(parsed.map((x) => x.p.host.toLowerCase()))]));
      for (const r of rows) existing.add(endpointKey(r));
    }
    for (const { line, p } of parsed) {
      if (existing.has(endpointKey(p))) { results.push({ line, input: maskedLine(p), status: 'duplicate', error: 'already in pool' }); continue; }
      if (dryRun) { results.push({ line, input: maskedLine(p), status: 'created' }); continue; }
      const [row] = await db.insert(schema.proxies).values({
        type: p.type, kind: req.body.kind, host: p.host, port: p.port, username: p.username, passwordEnc: p.password ? sealSecret(p.password) : null,
        provider: blankToNull(req.body.provider), country: blankToNull(req.body.country),
      }).onConflictDoNothing().returning({ id: schema.proxies.id });
      results.push(row ? { line, input: maskedLine(p), status: 'created', id: row.id } : { line, input: maskedLine(p), status: 'duplicate', error: 'already in pool' });
    }
    results.sort((a, b) => a.line - b.line);
    const count = (s: Result['status']) => results.filter((r) => r.status === s).length;
    return { dryRun, results, created: count('created'), duplicate: count('duplicate'), invalid: count('invalid') };
  });

  /**
   * Probe an unsaved configuration (add/edit dialog) with the same check as saved entries. Stores nothing;
   * the password is never echoed (the result only has egress IP, geo, latency, error). Not audit-logged.
   */
  app.post('/api/proxies/test', { schema: { body: TestBody } }, async (req) => {
    const { id, type, host, port } = req.body;
    const username = blankToNull(req.body.username) ?? null;
    let password = blankToNull(req.body.password) ?? null;
    if (!password && id) {
      const cur = await mustGet(id);
      // Only reuse the stored password for the same endpoint and username: a changed user or a changed host/port/type
      // must not receive the stored (write-only) secret.
      const same = username === cur.username && type === cur.type && host === cur.host && port === cur.port;
      if (cur.passwordEnc && username && same) password = openSecret(cur.passwordEnc);
    }
    if (password && !username) throw badRequest('设置密码时必须填写用户名', 'proxy.password_without_username');
    const result = await probeProxy({ type, host, port, ...(username ? { username } : {}), ...(password ? { password } : {}) })
      .catch((err: Error): ProxyCheck => ({ at: new Date().toISOString(), ok: false, egressIp: null, latencyMs: null, country: null, city: null, error: err.message }));
    if (password && result.error) {
      for (const s of [password, encodeURIComponent(password)]) result.error = result.error.split(s).join('***');
    }
    return { result };
  });

  /** Check through the proxy from the API host (not via a device): egress IP, geo, latency. */
  app.post('/api/proxies/:id/check', { schema: { params: IdParams } }, async (req) => {
    const row = await checkPoolProxy(await mustGet(req.params.id));
    return { proxy: toPublicProxy(row, (await boundMap([row.id])).get(row.id) ?? null) };
  });

  /** Batch check (`ids` omitted = whole pool). */
  app.post('/api/proxies/check', { schema: { body: z.object({ ids: z.array(z.string().uuid()).min(1).max(500).optional() }) } }, async (req) => {
    const rows = await db.select().from(schema.proxies).where(req.body.ids ? inArray(schema.proxies.id, req.body.ids) : undefined);
    const checked = await mapLimit(rows, CHECK_CONCURRENCY, checkPoolProxy);
    const b = await boundMap(checked.map((r) => r.id));
    const proxies = checked.map((r) => toPublicProxy(r, b.get(r.id) ?? null));
    return { proxies, ok: proxies.filter((p) => p.status === 'ok').length, failed: proxies.filter((p) => p.status === 'failed').length };
  });

  /** Current binding (with the device's own egress status) and bind/unbind history from the audit log. */
  app.get('/api/proxies/:id/usage', { schema: { params: IdParams } }, async (req) => {
    const p = await mustGet(req.params.id);
    const [inst] = await db.select({
      id: schema.instances.id, name: schema.instances.name, status: schema.instances.status, proxyStatus: schema.instances.proxyStatus,
    }).from(schema.instances).where(eq(schema.instances.proxyId, p.id));
    const id = p.id;
    const history = await db.select({
      at: schema.auditLogs.at, username: schema.auditLogs.username, action: schema.auditLogs.action,
      target: schema.auditLogs.target, targetId: schema.auditLogs.targetId, ok: schema.auditLogs.ok, detail: schema.auditLogs.detail,
    }).from(schema.auditLogs).where(and(
      inArray(schema.auditLogs.action, ['proxy.set', 'device.create']),
      or(sql`${schema.auditLogs.detail}->>'proxyId' = ${id}`, sql`${schema.auditLogs.detail}->>'fromProxyId' = ${id}`, sql`${schema.auditLogs.detail}->'proxyIds' ? ${id}`),
    )).orderBy(desc(schema.auditLogs.at)).limit(50);
    return {
      proxy: toPublicProxy(p, inst ? { id: inst.id, name: inst.name } : null),
      boundInstance: inst ?? null,
      history: history.map((h) => ({
        at: h.at, username: h.username, ok: h.ok, device: h.target, deviceId: h.action === 'proxy.set' ? h.targetId : null,
        event: h.action === 'device.create' ? 'create' : h.detail?.proxyId === id ? 'bind' : 'unbind',
      })),
    };
  });
};
