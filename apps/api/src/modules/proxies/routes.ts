import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import type { Instance, PoolProxy } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { sealSecret } from '../../lib/secret-box.js';
import { isAdmin } from '../auth/rbac.js';
import { enqueue } from '../instances/queue.js';
import { publishInstance, updateInstance } from '../instances/repo.js';
import {
  checkPoolProxy, endpointKey, endpointText, HOST_RE, isUniqueViolation, mapLimit, maskedLine, parseProxyLine, toPublicProxy, type ParsedProxy,
} from './pool.js';

const BUSY: Instance['status'][] = ['creating', 'starting', 'stopping', 'restarting', 'deleting'];
const MAX_IMPORT_LINES = 1000;
const CHECK_CONCURRENCY = 8;

const opt = (max: number) => z.string().trim().max(max).nullable().optional();
const Fields = {
  label: opt(80),
  country: opt(64),
  region: opt(80),
  city: opt(80),
  provider: opt(80),
  notes: opt(500),
};
const Endpoint = {
  type: z.enum(['socks5', 'http']),
  host: z.string().trim().min(1).max(253).regex(HOST_RE, 'hostname or IPv4'),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(200).nullable().optional(),
};
const CreateBody = z.object({ ...Endpoint, password: z.string().max(200).nullable().optional(), ...Fields });
/** Password is write-only: omitted = keep, null/'' = clear, string = replace. */
const UpdateBody = z.object({
  type: Endpoint.type.optional(), host: Endpoint.host.optional(), port: Endpoint.port.optional(), username: Endpoint.username,
  password: z.string().max(200).nullable().optional(), ...Fields,
});
const IdParams = z.object({ id: z.string().uuid() });

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
        bound: z.enum(['bound', 'free']).optional(),
        q: z.string().trim().max(200).optional(),
        country: z.string().trim().max(64).optional(),
      }),
    },
  }, async (req) => {
    const { status, bound, q, country } = req.query;
    const where: SQL[] = [];
    if (status) where.push(eq(schema.proxies.status, status));
    if (country) where.push(ilike(schema.proxies.country, country));
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(or(ilike(schema.proxies.label, like), ilike(schema.proxies.host, like), ilike(schema.proxies.provider, like),
        ilike(schema.proxies.notes, like), ilike(schema.proxies.city, like), sql`${schema.proxies.lastCheck}->>'egressIp' ilike ${like}`)!);
    }
    const used = sql`exists (select 1 from ${schema.instances} i where i.proxy_id = ${schema.proxies.id})`;
    if (bound === 'bound') where.push(used);
    if (bound === 'free') where.push(sql`not ${used}`);
    const rows = await db.select().from(schema.proxies).where(where.length ? and(...where) : undefined).orderBy(schema.proxies.createdAt);
    const b = await boundMap();
    return { proxies: rows.map((p) => toPublicProxy(p, b.get(p.id) ?? null)) };
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

  /** Bulk import, one proxy per line. `dryRun` returns the per-line preview without inserting. */
  app.post('/api/proxies/import', {
    schema: {
      body: z.object({
        text: z.string().max(200_000),
        defaultType: z.enum(['socks5', 'http']).default('socks5'),
        dryRun: z.boolean().default(false),
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
        type: p.type, host: p.host, port: p.port, username: p.username, passwordEnc: p.password ? sealSecret(p.password) : null,
        provider: blankToNull(req.body.provider), country: blankToNull(req.body.country),
      }).onConflictDoNothing().returning({ id: schema.proxies.id });
      results.push(row ? { line, input: maskedLine(p), status: 'created', id: row.id } : { line, input: maskedLine(p), status: 'duplicate', error: 'already in pool' });
    }
    results.sort((a, b) => a.line - b.line);
    const count = (s: Result['status']) => results.filter((r) => r.status === s).length;
    return { dryRun, results, created: count('created'), duplicate: count('duplicate'), invalid: count('invalid') };
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
