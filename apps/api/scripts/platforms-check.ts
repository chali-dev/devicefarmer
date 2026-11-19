/**
 * Removal of the official platform APIs (owner decision 2026-11-18), against the real API + DB + Redis (no mocks):
 * - API: every OAuth / connection / API-check / app-credential endpoint, comment sync and analytics refresh are gone
 *   (404, also for admins); GET /api/platforms only carries `enabled` + `features`; /api/publish/platforms has no
 *   `methods`; alert rules / kinds / channel kinds have no connection.expired and no accountCheckHours (PUT with it
 *   is a 400); the dashboard social widget has no `connections`; the manual "mark checked" is gone (404).
 * - Schema (migration drop_legacy): platform_connections / comment_sync_states dropped, settings row platform.apps and
 *   tasks of the removed types gone.
 * - A leftover BullMQ job of a removed-type task (its row deleted) is consumed by the real worker without a trace.
 * Creates a temporary user; removes everything it created and restores alerts.rules.
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:3190 npx tsx --env-file=../../.env scripts/platforms-check.ts
 */
import crypto, { randomBytes } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { sqlClient as sql } from '../src/db/index.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
let passed = 0; let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (ok) passed++; else failed++;
};
async function http<T = any>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(API + path, {
    method, redirect: 'manual',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, body: json as T };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  const b = await r.json() as { token?: string };
  if (!b.token) throw new Error(`login ${username}: ${r.status}`);
  return b.token;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tag = randomBytes(3).toString('hex');
const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const pw = randomBytes(12).toString('base64url');
const created = await http('POST', '/api/users', T, { username: `plc${tag}`, password: pw, role: 'user' });
const userId: string = created.body.user?.id ?? created.body.id;
const U = await login(`plc${tag}`, pw);
const [rulesBefore] = await sql<{ value: unknown }[]>`select value from settings where key = 'alerts.rules'`;
const channelIds: string[] = [];
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
const q = new Queue('task-ops', { connection: redis });

try {
  // ---------------------------------------------------------------- API surface
  const acc = await http('POST', '/api/social/accounts', U, { platform: 'instagram', handle: `plc_${tag}` });
  const accId: string = acc.body.account.id;
  check('setup: user + social account', !!userId && !!accId, acc.status);

  const gone: [string, string, unknown?][] = [
    ['GET', '/api/settings/platforms'],
    ['PUT', '/api/settings/platforms/instagram', { clientId: 'abcdef' }],
    ['POST', '/api/platforms/instagram/connect', { socialAccountId: accId }],
    ['GET', '/api/platforms/instagram/callback?state=x&code=y'],
    ['GET', '/api/platforms/connections'],
    ['DELETE', `/api/platforms/accounts/${accId}/connection`],
    ['POST', `/api/platforms/accounts/${accId}/check`],
    ['GET', '/api/platforms/instagram/capabilities'],
    ['POST', `/api/comments/accounts/${accId}/sync`],
    ['POST', `/api/analytics/accounts/${accId}/refresh`],
  ];
  for (const [m, p, b] of gone) {
    const [ra, ru] = [await http(m, p, T, b), await http(m, p, U, b)];
    check(`${m} ${p.replace(accId, ':id')} → 404 (admin ${ra.status}, user ${ru.status})`, ra.status === 404 && ru.status === 404);
  }

  const pf = await http('GET', '/api/platforms', U);
  check('GET /api/platforms: only enabled + features', pf.status === 200 && JSON.stringify(Object.keys(pf.body).sort()) === '["enabled","features"]'
    && Array.isArray(pf.body.enabled) && JSON.stringify(Object.keys(pf.body.features).sort()) === '["trending","youtubeKey"]', pf.body);
  const pp = await http('GET', '/api/publish/platforms', U);
  check('GET /api/publish/platforms: no methods field', pp.status === 200 && pp.body.platforms.length > 0 && pp.body.platforms.every((p: any) => !('methods' in p)), pp.body.platforms?.[0]);

  const al = await http('GET', '/api/settings/alerts', T);
  check('alert settings: no accountCheckHours, no connection.expired kind',
    al.status === 200 && !('accountCheckHours' in al.body.rules) && !('connection.expired' in al.body.rules.kinds) && !al.body.kinds.some((k: any) => k.kind === 'connection.expired')
    && !('accountCheckMax' in al.body.limits), { rules: al.body.rules, limits: al.body.limits });
  const put = await http('PUT', '/api/settings/alerts', T, { accountCheckHours: 24 });
  check('PUT /api/settings/alerts with accountCheckHours → 400', put.status === 400, put.status);
  const ch = await http('GET', '/api/alert-channels', T);
  check('alert channel kinds: no connection.expired', ch.status === 200 && ch.body.kinds.length > 0 && !ch.body.kinds.some((k: any) => k.kind === 'connection.expired'));
  const badCh = await http('POST', '/api/alert-channels', T, { name: `plc ${tag}`, type: 'telegram', kinds: ['connection.expired'], config: { botToken: '123456:abcdefghijklmnopqrstuvwxyz0123456789', chatId: '1' } });
  check('creating a channel with kind connection.expired → 400', badCh.status === 400, badCh.status);
  if (badCh.body?.channel?.id) channelIds.push(badCh.body.channel.id);

  const dash = await http('GET', '/api/dashboard', U);
  check('dashboard: no connections anywhere (only the devices widget since 2026-11-19)', dash.status === 200 && JSON.stringify(dash.body.order) === '["devices"]' && !JSON.stringify(dash.body).includes('connections'), JSON.stringify(dash.body).slice(0, 200));
  const ck = await http('POST', `/api/social/accounts/${accId}/checked`, U, { loginStatus: 'logged_in' });
  check('manual "mark checked" is gone too (404, statuses are system-written)', ck.status === 404, ck.status);

  // ---------------------------------------------------------------- schema: the removed tables / settings are gone (0048 drop_legacy)
  const [reg] = await sql<{ pc: string | null; cs: string | null }[]>`select to_regclass('platform_connections')::text as pc, to_regclass('comment_sync_states')::text as cs`;
  check('tables platform_connections and comment_sync_states dropped', reg!.pc === null && reg!.cs === null, reg);
  const [apps] = await sql<{ n: number }[]>`select count(*)::int as n from settings where key = 'platform.apps'`;
  check('settings row platform.apps gone', apps!.n === 0, apps);
  const [left] = await sql<{ n: number }[]>`select count(*)::int as n from tasks where type in ('account-stats', 'comment-sync', 'social-account-check')`;
  check('no task rows of the removed types', left!.n === 0, left);

  // ---------------------------------------------------------------- a leftover job of a removed-type task (row deleted by the migration)
  const ghost = crypto.randomUUID();
  await q.add('account-stats', { taskId: ghost }, { jobId: ghost, removeOnComplete: true, removeOnFail: true });
  let consumed = false;
  for (let i = 0; i < 50 && !consumed; i++) { await sleep(200); consumed = !(await q.getJob(ghost)); }
  const [after] = await sql<{ n: number }[]>`select count(*)::int as n from tasks where id = ${ghost}`;
  check('leftover job consumed by the worker without creating or touching a task row', consumed && after!.n === 0, { consumed, after });
} finally {
  await sql`delete from alert_states where key = ${`plc-${tag}`}`;
  if (channelIds.length) await sql`delete from alert_channels where id = any(${channelIds}::uuid[])`;
  if (rulesBefore) await sql`update settings set value = ${JSON.stringify(rulesBefore.value)}::jsonb where key = 'alerts.rules'`;
  else await sql`delete from settings where key = 'alerts.rules'`;
  if (userId) {
    await sql`delete from tasks where created_by = ${userId}`;
    await sql`delete from publish_tasks where user_id = ${userId}`;
    await sql`delete from contents where user_id = ${userId}`;
    await http('DELETE', `/api/users/${userId}`, T);
  }
  await q.close();
  await redis.quit();
  await sql.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
