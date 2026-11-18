/**
 * 代理 IP 批量操作 (POST /api/proxies/batch) against the real API and DB. No mocks, no proxy traffic, no containers.
 * - delete: free proxies are deleted, a proxy bound to a device is skipped with `proxy.bound` (+ proxy/device names),
 *   an unknown id fails the whole batch with 404 and nothing changes, duplicate ids count once.
 * - set-kind: rows move to the other tab, `changed` counts only rows that had another kind, `kind` required.
 * - RBAC (user → 403, nothing changed), validation (empty / > 500 ids, bad action → 400).
 * - Audit: `proxy.batch_delete` / `proxy.batch_set_kind` with counts only (no hosts, usernames or passwords).
 * The bound proxy uses a placeholder `instances` row written directly to the DB (status stopped, adb port 5591,
 * never started); it and every test proxy are removed at the end.
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:3000 npx tsx --env-file=../../.env scripts/proxy-batch-check.ts
 */
import { randomBytes } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http<T = any>(method: string, p: string, token: string, body?: unknown) {
  const res = await fetch(API + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json as T, text };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
}

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const secret = `PXB-SECRET-${tag}`;
const proxyIds: string[] = [];
const userIds: string[] = [];
const fakeIds: string[] = [];
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
const P = schema.proxies;

try {
  // ---------------------------------------------------------------- setup
  const mk = async (n: number, kind: 'static' | 'mobile' = 'static') => {
    const r = await http('POST', '/api/proxies', T, {
      type: 'socks5', kind, host: `pxb-${tag}.invalid`, port: 20000 + n, username: `pxbuser${n}`, password: secret, label: `pxb-${tag}-${n}`,
    });
    if (r.status !== 201) throw new Error(`create proxy ${r.status} ${r.text}`);
    proxyIds.push(r.body.proxy.id);
    return r.body.proxy.id as string;
  };
  const [p1, p2, p3, pBound, p5, p6] = [await mk(1), await mk(2), await mk(3), await mk(4), await mk(5), await mk(6, 'mobile')] as string[];
  const [fake] = await db.insert(schema.instances).values({
    name: `pxbfake-${tag}`, image: 'none', adbPort: 5591, status: 'stopped' as const, spec: { width: 720, height: 1280, dpi: 320 }, proxyId: pBound!,
  }).returning();
  fakeIds.push(fake!.id);
  const pw = randomBytes(12).toString('hex');
  const u = await http('POST', '/api/users', T, { username: `pxbu${tag}`, password: pw, role: 'user' });
  userIds.push(u.body.user?.id ?? u.body.id);
  const U = await login(`pxbu${tag}`, pw);
  check('setup: 6 proxies (5 static, 1 mobile), one bound to a placeholder device, one plain user', proxyIds.length === 6 && !!fake && !!U);

  const batch = (token: string, body: unknown) => http('POST', '/api/proxies/batch', token, body);
  const existing = async () => (await db.select({ id: P.id }).from(P).where(inArray(P.id, proxyIds))).map((x) => x.id);
  const kinds = async () => Object.fromEntries((await db.select({ id: P.id, kind: P.kind }).from(P).where(inArray(P.id, proxyIds))).map((x) => [x.id, x.kind]));

  // ---------------------------------------------------------------- RBAC + validation (nothing changes)
  let r = await batch(U, { ids: [p1], action: 'delete' });
  check('user: 403 proxy.admin_only', r.status === 403 && r.body?.code === 'proxy.admin_only', `${r.status} ${r.text}`);
  r = await batch(T, { ids: [], action: 'delete' });
  check('empty ids → 400', r.status === 400, `${r.status}`);
  r = await batch(T, { ids: Array.from({ length: 501 }, () => p1), action: 'delete' });
  check('501 ids → 400', r.status === 400, `${r.status}`);
  r = await batch(T, { ids: [p1], action: 'explode' });
  check('unknown action → 400', r.status === 400, `${r.status}`);
  r = await batch(T, { ids: [p1], action: 'set-kind' });
  check('set-kind without kind → 400 proxy.batch_kind_required', r.status === 400 && r.body?.code === 'proxy.batch_kind_required', `${r.status} ${r.text}`);
  r = await batch(T, { ids: [p1, '00000000-0000-4000-8000-000000000000'], action: 'delete' });
  check('unknown id → 404 proxy.not_found', r.status === 404 && r.body?.code === 'proxy.not_found', `${r.status} ${r.text}`);
  check('after the refused batches all 6 proxies still exist', (await existing()).length === 6);

  // ---------------------------------------------------------------- set-kind
  r = await batch(T, { ids: [p1, p2, p6], action: 'set-kind', kind: 'mobile' });
  let k = await kinds();
  check('set-kind mobile: ok = 3, changed = 2 (p6 already mobile), no skips', r.status === 200 && r.body.ok.length === 3 && r.body.changed === 2 && r.body.skipped.length === 0, r.text);
  check('set-kind: p1/p2 now mobile, p3 untouched', k[p1!] === 'mobile' && k[p2!] === 'mobile' && k[p3!] === 'static' && k[p6!] === 'mobile');
  r = await http('GET', '/api/proxies?kind=mobile', T);
  check('list ?kind=mobile shows the moved rows', [p1, p2, p6].every((id) => r.body.proxies.some((p: any) => p.id === id)));
  r = await batch(T, { ids: [p1, p2, pBound], action: 'set-kind', kind: 'static' });
  k = await kinds();
  check('set-kind back to static (bound proxy too): changed = 2', r.status === 200 && r.body.changed === 2 && k[p1!] === 'static' && k[pBound!] === 'static', r.text);

  // ---------------------------------------------------------------- delete
  r = await batch(T, { ids: [p1, p2, pBound, p2], action: 'delete' });
  const left = await existing();
  const sk = r.body?.skipped?.[0];
  check('delete: 200, ok = [p1, p2] (duplicate id once), skipped = bound proxy', r.status === 200 && r.body.ok.length === 2 && r.body.ok.includes(p1) && r.body.ok.includes(p2)
    && r.body.skipped.length === 1 && sk?.id === pBound, r.text);
  check('skip reason: proxy.bound with proxy text and device name', sk?.code === 'proxy.bound' && sk?.params?.name === `pxbfake-${tag}` && String(sk?.params?.proxy).includes(`pxb-${tag}-4`), JSON.stringify(sk));
  check('skip params carry no username/password', !JSON.stringify(r.body).includes(secret) && !JSON.stringify(r.body).includes('pxbuser'));
  check('DB: p1/p2 gone, bound proxy and the rest kept', !left.includes(p1!) && !left.includes(p2!) && left.includes(pBound!) && left.length === 4);
  const [inst] = await db.select({ proxyId: schema.instances.proxyId }).from(schema.instances).where(inArray(schema.instances.id, fakeIds));
  check('placeholder device keeps its binding', inst?.proxyId === pBound);
  r = await batch(T, { ids: [p1], action: 'delete' });
  check('deleting an already deleted id → 404', r.status === 404 && r.body?.code === 'proxy.not_found');
  r = await batch(T, { ids: [pBound], action: 'delete' });
  check('only bound ids: 200 with ok = 0, skipped = 1', r.status === 200 && r.body.ok.length === 0 && r.body.skipped.length === 1);
  r = await batch(T, { ids: [p3, p5, p6], action: 'delete' });
  check('delete across kinds: ok = 3', r.status === 200 && r.body.ok.length === 3 && r.body.skipped.length === 0, r.text);
  // Unbind, then the batch deletes it.
  await db.update(schema.instances).set({ proxyId: null }).where(inArray(schema.instances.id, fakeIds));
  r = await batch(T, { ids: [pBound], action: 'delete' });
  check('after unbinding: the former bound proxy is deleted', r.status === 200 && r.body.ok.length === 1 && (await existing()).length === 0, r.text);

  // ---------------------------------------------------------------- audit (fire-and-forget writes)
  await sleep(800);
  const rows = await sqlClient`select action, user_id, status, detail from audit_logs where at >= ${t0.toISOString()}::timestamptz and action like 'proxy.batch_%' order by at`;
  const dels = rows.filter((x) => x.action === 'proxy.batch_delete');
  const okDel = dels.find((x) => x.status === 200 && x.detail?.ok === 2);
  check('audit: proxy.batch_delete with count/ok/skipped/changed', !!okDel && okDel.detail.count === 4 && okDel.detail.skipped === 1 && okDel.detail.changed === 2, JSON.stringify(okDel?.detail));
  check('audit: proxy.batch_set_kind recorded with kind', rows.some((x) => x.action === 'proxy.batch_set_kind' && x.status === 200 && x.detail?.kind === 'mobile' && x.detail?.changed === 2));
  check('audit: refused batches recorded (403 user, 404 unknown id)', dels.some((x) => x.status === 403 && x.user_id === userIds[0]) && dels.some((x) => x.status === 404));
  const all = JSON.stringify(rows.map((x) => x.detail));
  check('audit: no hosts, usernames, passwords or ids lists in details', !all.includes(secret) && !all.includes('pxbuser') && !all.includes(`pxb-${tag}`) && !all.includes(p3!), all.slice(0, 300));
} catch (err) {
  check(`unexpected error: ${(err as Error).message}`, false);
} finally {
  if (fakeIds.length) await db.delete(schema.instances).where(inArray(schema.instances.id, fakeIds));
  if (proxyIds.length) await db.delete(P).where(inArray(P.id, proxyIds));
  for (const id of userIds) if (id) await http('DELETE', `/api/users/${id}`, T);
  const leftP = proxyIds.length ? await db.select({ id: P.id }).from(P).where(inArray(P.id, proxyIds)) : [];
  check('cleanup: test proxies, placeholder device and user removed', leftP.length === 0);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
