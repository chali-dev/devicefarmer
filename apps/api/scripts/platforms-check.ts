/**
 * Removal of the official platform APIs (owner decision 2026-11-18), against the real API + DB + Redis (no mocks):
 * - API: every OAuth / connection / API-check / app-credential endpoint, comment sync and analytics refresh are gone
 *   (404, also for admins); GET /api/platforms only carries `enabled` + `features`; /api/publish/platforms has no
 *   `methods`; alert rules / kinds / channel kinds have no connection.expired and no accountCheckHours (PUT with it
 *   is a 400); the dashboard social widget has no `connections`; the generic manual "mark checked" still works.
 * - Data migration (src/db/official-api-removal-migration.ts, run by db:migrate) on seeded rows: platform_connections
 *   rows deleted (sealed tokens gone); unfinished account-stats / comment-sync / social-account-check tasks cancelled
 *   with the task log line, finished ones and other types untouched; a waiting publish round with method 'api'
 *   becomes method null + publish log, an awaiting_operator one is untouched; connection.expired notifications and
 *   alert states deleted (others kept); channel kinds cleaned (a channel left with no kind is disabled, not "all");
 *   alerts.rules loses accountCheckHours + kinds.connection.expired. A second run changes nothing.
 * - A leftover BullMQ job of a cancelled removed-type task is consumed by the real worker without touching the row
 *   (stays cancelled, no task.unknown_type).
 * Creates a temporary user; removes everything it created and restores alerts.rules.
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:3190 npx tsx --env-file=../../.env scripts/platforms-check.ts
 */
import { randomBytes } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { sqlClient as sql } from '../src/db/index.js';
import { migrateOfficialApiRemoval, REMOVED_PUBLISH_LOG, REMOVED_TASK_LOG } from '../src/db/official-api-removal-migration.js';
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
    && Array.isArray(pf.body.enabled) && JSON.stringify(Object.keys(pf.body.features).sort()) === '["trackedCollector","trending","youtubeKey"]', pf.body);
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
  check('dashboard social widget: no connections', dash.status === 200 && dash.body.widgets?.social && !('connections' in dash.body.widgets.social), dash.body.widgets?.social);
  const ck = await http('POST', `/api/social/accounts/${accId}/checked`, U, { loginStatus: 'logged_in' });
  check('manual "mark checked" still works', ck.status === 200, ck.status);

  // ---------------------------------------------------------------- data migration
  const [conn] = await sql<{ id: string }[]>`insert into platform_connections (social_account_id, user_id, platform, access_token_enc, refresh_token_enc, scopes)
    values (${accId}, ${userId}, 'instagram', ${`sealed-${tag}`}, ${`sealedR-${tag}`}, '{x}') returning id`;
  const task = async (type: string, status: string) => (await sql<{ id: string }[]>`insert into tasks (type, status, created_by, instance_name, payload, max_attempts)
    values (${type}, ${status}, ${userId}, ${`plc ${tag}`}, '{}'::jsonb, 1) returning id`)[0]!.id;
  const tStats = await task('account-stats', 'pending');
  const tSync = await task('comment-sync', 'scheduled');
  const tCheck = await task('social-account-check', 'running');
  const tDone = await task('account-stats', 'success');
  const tOther = await task('tracked-refresh', 'scheduled');
  const taskIds = [tStats, tSync, tCheck, tDone, tOther];
  const [content] = await sql<{ id: string }[]>`insert into contents (user_id, title, body) values (${userId}, ${`plc ${tag}`}, 'x') returning id`;
  const pub = async (status: string) => (await sql<{ id: string }[]>`insert into publish_tasks (user_id, content_id, account_id, platform, caption, status, method, created_by)
    values (${userId}, ${content!.id}, ${accId}, 'instagram', '', ${status}, 'api', ${userId}) returning id`)[0]!.id;
  const pWaiting = await pub('scheduled');
  // one unfinished row per content+account (partial unique index): the second one is already finished-ish
  const pAwaiting = (await sql<{ id: string }[]>`update publish_tasks set status = 'awaiting_operator' where id = ${await (async () => {
    const [c2] = await sql<{ id: string }[]>`insert into contents (user_id, title, body) values (${userId}, ${`plc2 ${tag}`}, 'x') returning id`;
    return (await sql<{ id: string }[]>`insert into publish_tasks (user_id, content_id, account_id, platform, caption, status, method, created_by)
      values (${userId}, ${c2!.id}, ${accId}, 'instagram', '', 'pending', 'api', ${userId}) returning id`)[0]!.id;
  })()} returning id`)[0]!.id;
  const publishIds = [pWaiting, pAwaiting];
  await sql`insert into notifications (user_id, kind, severity, params) values (${userId}, 'connection.expired', 'error', '{}'::jsonb), (${userId}, 'device.down', 'error', '{}'::jsonb)`;
  await sql`insert into alert_states (kind, key, active) values ('connection.expired', ${`plc-${tag}`}, true), ('device.down', ${`plc-${tag}`}, true)`;
  const chan = async (name: string, kinds: string[]) => (await sql<{ id: string }[]>`insert into alert_channels (name, type, enabled, config, kinds)
    values (${name}, 'telegram', true, '{}'::jsonb, ${kinds}) returning id`)[0]!.id;
  const cMixed = await chan(`plc mixed ${tag}`, ['connection.expired', 'device.down']);
  const cOnly = await chan(`plc only ${tag}`, ['connection.expired']);
  const cAll = await chan(`plc all ${tag}`, []);
  channelIds.push(cMixed, cOnly, cAll);
  await sql`insert into settings (key, value) values ('alerts.rules', ${JSON.stringify({ cooldownMinutes: 17, accountCheckHours: 12, kinds: { 'connection.expired': { inApp: false }, 'device.down': { inApp: false } } })}::jsonb)
    on conflict (key) do update set value = excluded.value`;

  const logs: string[] = [];
  const r1 = await migrateOfficialApiRemoval(sql, (m) => logs.push(m), { taskIds, publishTaskIds: publishIds });
  check('migration run 1: counts', r1.connections >= 1 && r1.tasks === 3 && r1.publishTasks === 1 && r1.notifications >= 1 && r1.alertStates >= 1
    && r1.channels >= 2 && r1.channelsDisabled >= 1 && r1.rules === 1, r1);
  check('migration logs one summary line', logs.length === 1 && logs[0]!.startsWith('official platform APIs removed:'), logs);
  const [connLeft] = await sql`select count(*)::int as n from platform_connections`;
  check('platform_connections: all rows deleted (no sealed token left)', connLeft!.n === 0 && !(await sql`select 1 from platform_connections where id = ${conn!.id}`).length);
  const st = await sql<{ id: string; status: string; error: string | null; finished_at: Date | null }[]>`select id, status, error, finished_at from tasks where id = any(${taskIds}::uuid[])`;
  const s = (id: string) => st.find((x) => x.id === id)!;
  check('removed-type tasks (pending/scheduled/running) cancelled with finished_at', [tStats, tSync, tCheck].every((id) => s(id).status === 'cancelled' && s(id).finished_at && s(id).error === REMOVED_TASK_LOG), st);
  check('finished removed-type task and other types untouched', s(tDone).status === 'success' && s(tOther).status === 'scheduled');
  const tl = await sql<{ task_id: string; message: string }[]>`select task_id, message from task_logs where task_id = any(${taskIds}::uuid[])`;
  check('task log "cancelled: official platform APIs removed" once per cancelled task', [tStats, tSync, tCheck].every((id) => tl.filter((l) => l.task_id === id && l.message === REMOVED_TASK_LOG).length === 1)
    && !tl.some((l) => l.task_id === tDone || l.task_id === tOther));
  const pr = await sql<{ id: string; status: string; method: string | null }[]>`select id, status, method from publish_tasks where id = any(${publishIds}::uuid[])`;
  const pl = await sql<{ publish_task_id: string; message: string }[]>`select publish_task_id, message from publish_logs where publish_task_id = any(${publishIds}::uuid[])`;
  check('waiting api publish round → method null + publish log; awaiting_operator untouched',
    pr.find((x) => x.id === pWaiting)?.method === null && pr.find((x) => x.id === pWaiting)?.status === 'scheduled'
    && pr.find((x) => x.id === pAwaiting)?.method === 'api' && pl.filter((l) => l.publish_task_id === pWaiting && l.message === REMOVED_PUBLISH_LOG).length === 1
    && !pl.some((l) => l.publish_task_id === pAwaiting), { pr, pl });
  const nk = await sql<{ kind: string }[]>`select kind from notifications where user_id = ${userId}`;
  check('connection.expired notifications deleted, others kept', nk.length === 1 && nk[0]!.kind === 'device.down', nk);
  const as = await sql<{ kind: string }[]>`select kind from alert_states where key = ${`plc-${tag}`}`;
  check('connection.expired alert states deleted, others kept', as.length === 1 && as[0]!.kind === 'device.down', as);
  const cs = await sql<{ id: string; enabled: boolean; kinds: string[] }[]>`select id, enabled, kinds from alert_channels where id = any(${[cMixed, cOnly, cAll]}::uuid[])`;
  const c = (id: string) => cs.find((x) => x.id === id)!;
  check('channel kinds cleaned: mixed keeps device.down (enabled), only-connection.expired disabled with no kinds, "all" untouched',
    JSON.stringify(c(cMixed).kinds) === '["device.down"]' && c(cMixed).enabled && c(cOnly).kinds.length === 0 && !c(cOnly).enabled && c(cAll).enabled && c(cAll).kinds.length === 0, cs);
  const [rules] = await sql<{ value: any }[]>`select value from settings where key = 'alerts.rules'`;
  check('alerts.rules: accountCheckHours and kinds.connection.expired removed, the rest kept',
    !('accountCheckHours' in rules!.value) && !('connection.expired' in rules!.value.kinds) && rules!.value.kinds['device.down'].inApp === false && rules!.value.cooldownMinutes === 17, rules!.value);

  const r2 = await migrateOfficialApiRemoval(sql, () => undefined, { taskIds, publishTaskIds: publishIds });
  check('migration run 2: no-op', Object.values(r2).every((n) => n === 0), r2);
  const st2 = await sql<{ n: number }[]>`select count(*)::int as n from task_logs where task_id = any(${taskIds}::uuid[])`;
  check('run 2 wrote no task logs', st2[0]!.n === tl.length);

  // ---------------------------------------------------------------- a leftover job of a cancelled removed-type task
  await q.add('account-stats', { taskId: tStats }, { jobId: tStats, removeOnComplete: true, removeOnFail: true });
  let consumed = false;
  for (let i = 0; i < 50 && !consumed; i++) { await sleep(200); consumed = !(await q.getJob(tStats)); }
  const [after] = await sql<{ status: string; error_code: string | null }[]>`select status, error_code from tasks where id = ${tStats}`;
  const tl2 = await sql<{ n: number }[]>`select count(*)::int as n from task_logs where task_id = ${tStats}`;
  check('leftover job consumed by the worker; the task stays cancelled (no task.unknown_type), no new log', consumed && after!.status === 'cancelled' && after!.error_code === null && tl2[0]!.n === 1, { consumed, after, logs: tl2[0]!.n });
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
