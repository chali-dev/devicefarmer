/**
 * 话术库 + 定时采集 + 趋势热点 test against the real API, DB, Redis/BullMQ and (where noted) the real YouTube Data API. No mocks.
 * - Templates (comment_templates with persona (personas, see personas-check.ts) and tags; no kind): the 范例 of personas: a template without a persona is refused (create and edit,
 *   template.persona_required); CRUD, `kind` in a body / query → 400 (strict), shared vs private
 *   rules, isolation/RBAC, filters, facets, audit.
 * - Scheduled collection: per-account interval, the collection tick enqueues each due slot exactly once (also under two
 *   concurrent ticks), skips paused / in-progress / manual-only / unconfigured accounts with codes, re-checks at run time.
 *   Scheduled refresh tasks created here run in the future and are cancelled, so no YouTube call is made for them.
 * - Trending: settings validation + RBAC, coded errors without regions/key, rank changes vs. the previous snapshot
 *   (two snapshots seeded in the DB for the fictional region ZZ), retention purge via the tick, no dashboard widget (removed 2026-11-19).
 *   Without YOUTUBE_TEST_API_KEY: a syntactically valid dummy key is set briefly and the scheduled trending task is
 *   expected to fail against the real API with tracked.youtube_key_invalid (one rejected request, no quota).
 *   With YOUTUBE_TEST_API_KEY: a real chart fetch for US (10 videos, 1 quota unit per refresh) and a real scheduled
 *   refresh of one tracked channel.
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:3000 npx tsx --env-file=../../.env scripts/content-tools-check.ts
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { closeTaskQueues, createTask } from '../src/modules/tasks/core.js';
import { scheduleTrackedRefreshes } from '../src/modules/tracked/schedule.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const REAL_KEY = process.env.YOUTUBE_TEST_API_KEY;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function http<T = any>(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json as T, text };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitTask(taskId: string, ms = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    if (t && ['success', 'failed', 'cancelled'].includes(t.status)) return t;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for task ${taskId} (${t?.status})`);
    await sleep(300);
  }
}
const TA = schema.trackedAccounts;
const acct = async (id: string) => (await db.select().from(TA).where(eq(TA.id, id)))[0]!;
const tasksOf = (refId: string) => db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'tracked-refresh'), eq(schema.tasks.refId, refId)));

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('hex');
const userIds: string[] = [];
const accountIds: string[] = [];
const templateIds: string[] = [];
const publicPersonaIds: string[] = [];
const taskIds: string[] = [];
const snapshotIds: string[] = [];
const DUMMY_KEY = `AIzaDummy${randomBytes(15).toString('hex')}`;
let keyWasSet = false;
let keyTouched = false;
const [trendingRow] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'trending'));
const startedAt = new Date();

/** Runs the collection tick now (admin) and returns its result. */
async function tick() {
  const r = await http('POST', '/api/collection/run', T);
  if (r.status !== 202) throw new Error(`collection run: ${r.status} ${r.text}`);
  taskIds.push(r.body.task.id);
  const t = await waitTask(r.body.task.id);
  return { task: t, result: t.result as any };
}

try {
  const mk = async (name: string) => {
    const r = await http('POST', '/api/users', T, { username: name, password: pw, role: 'user' });
    const id = r.body.user?.id ?? r.body.id; userIds.push(id);
    return { id, token: await login(name, pw) };
  };
  const A = await mk(`cta${tag}`);
  const B = await mk(`ctb${tag}`);

  // ================================================================ 话术库 (templates)
  const tpl = async (token: string, body: Record<string, unknown>) => {
    const r = await http('POST', '/api/comment-templates', token, body);
    if (r.body?.template?.id) templateIds.push(r.body.template.id);
    return r;
  };
  const mkPersona = async (token: string, scope: 'public' | 'mine', name: string) => {
    const x = await http('POST', '/api/personas', token, { scope, name });
    if (scope === 'public' && x.body?.persona?.id) publicPersonaIds.push(x.body.persona.id);
    return x.body.persona as { id: string; name: string };
  };
  const pFit = await mkPersona(A.token, 'mine', 'Fitness Coach');
  const pChef = await mkPersona(T, 'public', `Chef ${tag}`);
  const pChef2 = await mkPersona(T, 'public', `Chef2 ${tag}`);
  const pSecret = await mkPersona(B.token, 'mine', `Secret ${tag}`);
  let r = await tpl(A.token, { name: `reply ${tag}`, text: 'Thanks for watching!' });
  const rNull = await tpl(A.token, { name: `reply ${tag}`, text: 'Thanks for watching!', personaId: null });
  check('a template without a persona is refused (话术库 removed: templates are the 范例 of personas) → 400 template.persona_required',
    r.status === 400 && r.body.code === 'template.persona_required' && rNull.status === 400 && rNull.body.code === 'template.persona_required', `${r.status} ${r.body?.code}`);
  r = await tpl(A.token, { name: `reply ${tag}`, text: 'Thanks for watching!', personaId: pFit.id });
  const aComment = r.body.template;
  check('create a 范例 (no kind any more: one list per persona)', r.status === 201 && !('kind' in aComment) && aComment.persona?.id === pFit.id && aComment.tags.length === 0 && aComment.shared === false);
  r = await tpl(A.token, { name: `post ${tag}`, text: 'Leg day 💪 #gym', personaId: pFit.id, tags: ['Gym', 'gym ', 'Diet'] });
  const aPost = r.body.template;
  check('create a template with persona; tags lowercased + deduplicated', r.status === 201 && aPost.persona?.name === 'Fitness Coach' && JSON.stringify(aPost.tags) === '["gym","diet"]', JSON.stringify(aPost?.tags));
  r = await tpl(A.token, { name: `x ${tag}`, text: 'x', shared: true, personaId: pChef.id });
  check('user cannot create a shared template (403 comment.admin_only)', r.status === 403 && r.body.code === 'comment.admin_only');
  r = await tpl(A.token, { name: `x ${tag}`, text: 'x', kind: 'post', personaId: pFit.id });
  const r2 = await tpl(A.token, { name: `x ${tag}`, text: 'x', personaId: 'p'.repeat(51) });
  check('the removed kind (strict body) / personaId not a uuid → 400', r.status === 400 && r2.status === 400, `${r.status} ${r2.status}`);
  r = await tpl(T, { name: `shared post ${tag}`, text: 'Dinner in 15 minutes', personaId: pChef.id, shared: true });
  const sharedPost = r.body.template;
  r = await tpl(T, { name: `shared reply ${tag}`, text: 'We appreciate it', shared: true });
  check('admin: a shared template without a persona is refused too', r.status === 400 && r.body.code === 'template.persona_required');
  r = await tpl(T, { name: `shared reply ${tag}`, text: 'We appreciate it', shared: true, personaId: pChef.id });
  const sharedComment = r.body.template;
  check('admin creates shared templates', sharedPost?.shared === true && sharedComment?.shared === true);
  r = await tpl(B.token, { name: `b post ${tag}`, text: 'B private caption', personaId: pSecret.id, tags: ['bonly'] });
  const bPost = r.body.template;

  const list = async (token: string, q = '') => (await http('GET', `/api/comment-templates${q}`, token)).body.templates.filter((x: any) => x.name.includes(tag)) as any[];
  const names = (xs: any[]) => xs.map((x) => x.name).sort().join(',');
  let l = await list(A.token);
  check('list: 4 visible to A (own + shared, B\'s private hidden)', l.length === 4 && !l.some((x) => x.id === bPost.id), names(l));
  r = await http('GET', '/api/comment-templates?kind=post', A.token);
  const rf = await http('GET', '/api/comment-templates/facets?kind=all', A.token);
  check('the removed ?kind= → 400 (strict query) on the list and the facets', r.status === 400 && rf.status === 400, `${r.status} ${rf.status}`);
  l = await list(T);
  check('admin sees every user\'s templates (incl. B\'s) with owner names', l.length === 5 && l.find((x) => x.id === bPost.id)?.ownerName === `ctb${tag}`);
  l = await list(A.token, `?personaId=${pFit.id}`);
  const lNone = await list(A.token, '?personaId=none');
  const lTag = await list(A.token, '?tag=GYM');
  const lQ = await list(A.token, `?q=${encodeURIComponent('dinner')}`);
  const lShared = await list(A.token, '?scope=shared');
  const lOwn = await list(A.token, '?scope=own');
  check('filters: personaId, personaId=none (empty: every template has a persona), tag (case-insensitive), q in text, scope shared/own',
    names(l) === [`post ${tag}`, `reply ${tag}`].sort().join(',') && lNone.length === 0 && names(lTag) === `post ${tag}` && names(lQ) === `shared post ${tag}` && lShared.length === 2 && lOwn.length === 2,
    `${l.length}/${lNone.length}/${lTag.length}/${lQ.length}/${lShared.length}/${lOwn.length}`);
  r = await http('GET', '/api/comment-templates/facets', A.token);
  check('facets: tags of visible templates only', r.status === 200 && r.body.tags.includes('gym') && !r.body.tags.includes('bonly'), JSON.stringify(r.body));

  // isolation + write rules
  const getB = await http('PUT', `/api/comment-templates/${bPost.id}`, A.token, { name: 'hijack' });
  const delB = await http('DELETE', `/api/comment-templates/${bPost.id}`, A.token);
  check('other user\'s private template: PUT/DELETE → 404 comment.template_not_found', getB.status === 404 && delB.status === 404 && getB.body.code === 'comment.template_not_found');
  r = await http('PUT', `/api/comment-templates/${sharedPost.id}`, A.token, { text: 'changed' });
  check('user cannot edit a shared template (403)', r.status === 403 && r.body.code === 'comment.admin_only');
  r = await http('PUT', `/api/comment-templates/${aPost.id}`, A.token, { personaId: null, tags: ['Travel'], text: 'Edited caption' });
  check('edit own: personaId null → 400 template.persona_required, nothing changed', r.status === 400 && r.body.code === 'template.persona_required');
  r = await http('PUT', `/api/comment-templates/${aPost.id}`, A.token, { personaId: pChef.id, tags: ['Travel'], text: 'Edited caption' });
  check('edit own: persona changed (public), tags replaced, text changed', r.status === 200 && r.body.template.persona?.id === pChef.id && JSON.stringify(r.body.template.tags) === '["travel"]' && r.body.template.text === 'Edited caption');
  r = await http('PUT', `/api/comment-templates/${aPost.id}`, A.token, {});
  check('empty update → 400 common.nothing_to_update', r.status === 400 && r.body.code === 'common.nothing_to_update');
  r = await http('PUT', `/api/comment-templates/${aComment.id}`, A.token, { kind: 'post' });
  check('PUT with the removed kind → 400', r.status === 400, `${r.status}`);
  r = await http('PUT', `/api/comment-templates/${sharedPost.id}`, T, { personaId: pChef2.id });
  check('admin edits shared template', r.status === 200 && r.body.template.persona?.name === `Chef2 ${tag}`);
  r = await http('DELETE', `/api/comment-templates/${aComment.id}`, A.token);
  check('delete own template → 204', r.status === 204);

  // ================================================================ 定时采集 (scheduled collection)
  const track = async (token: string, input: string, platform?: string) => {
    const x = await http('POST', '/api/tracked-accounts', token, { input, platform });
    if (x.body?.account?.id) accountIds.push(x.body.account.id);
    return x.body.account;
  };
  const ytA = await track(A.token, `@ctA${tag}`, 'youtube');
  const ytPaused = await track(A.token, `@ctP${tag}`, 'youtube');
  const ytBusy = await track(A.token, `@ctBusy${tag}`, 'youtube');
  const ytFar = await track(A.token, `@ctFar${tag}`, 'youtube');
  const ytRace = await track(A.token, `@ctRace${tag}`, 'youtube');
  const igA = await track(A.token, `ct${tag}`, 'tiktok'); // a platform without a data source (TikTok)
  const ytB = await track(B.token, `@ctB${tag}`, 'youtube');

  r = await http('PATCH', `/api/tracked-accounts/${igA.id}`, A.token, { refreshIntervalHours: 6 });
  check('platform without a data source cannot be scheduled (400 tracked.schedule_manual_only)', r.status === 400 && r.body.code === 'tracked.schedule_manual_only');
  r = await http('PATCH', `/api/tracked-accounts/${ytA.id}`, A.token, { refreshIntervalHours: 5 });
  check('unsupported interval → 400', r.status === 400);
  r = await http('PATCH', `/api/tracked-accounts/${ytA.id}`, B.token, { refreshIntervalHours: 6 });
  check('other user cannot schedule my account (404)', r.status === 404 && r.body.code === 'tracked.not_found');
  const t0 = Date.now();
  r = await http('PATCH', `/api/tracked-accounts/${ytA.id}`, A.token, { refreshIntervalHours: 6 });
  const next = r.body.account?.nextRefreshAt ? new Date(r.body.account.nextRefreshAt).getTime() : 0;
  check('enable every 6 h: first slot within the next hour, listed with the account', r.status === 200 && r.body.account.refreshIntervalHours === 6 && next > t0 - 1000 && next <= t0 + 3600_000,
    r.body.account?.nextRefreshAt);
  for (const a of [ytPaused, ytBusy, ytRace, ytB]) await http('PATCH', `/api/tracked-accounts/${a.id}`, a === ytB ? B.token : A.token, { refreshIntervalHours: 6 });
  await http('PATCH', `/api/tracked-accounts/${ytFar.id}`, A.token, { refreshIntervalHours: 24 });
  await http('PATCH', `/api/tracked-accounts/${ytPaused.id}`, A.token, { status: 'paused' });

  // API key: the dummy is never used for these accounts (their slots are in the future and the tasks are cancelled).
  keyWasSet = (await http('GET', '/api/settings/youtube', T)).body.youtube.apiKeySet;
  if (REAL_KEY || !keyWasSet) { keyTouched = true; await http('PUT', '/api/settings/youtube', T, { apiKey: REAL_KEY ?? DUMMY_KEY }); }

  // Deterministic slots: due ones 50 min ahead (scheduled, never run here), ytFar 3 h ahead (not due).
  const slot = new Date(Math.ceil((Date.now() + 50 * 60_000) / 1000) * 1000);
  await db.update(TA).set({ nextRefreshAt: slot }).where(inArray(TA.id, [ytA.id, ytPaused.id, ytBusy.id, ytB.id]));
  await db.update(TA).set({ nextRefreshAt: new Date(Date.now() + 3 * 3600_000) }).where(eq(TA.id, ytFar.id));
  // A legacy/odd row: platform without a source with an interval (cannot be set via the API) must be skipped.
  await db.update(TA).set({ refreshIntervalHours: 6, nextRefreshAt: slot }).where(eq(TA.id, igA.id));
  // ytBusy has an unfinished refresh (a scheduled one far ahead) → skipped as in progress.
  const busyTask = (await createTask({ type: 'tracked-refresh', userId: A.id, label: 'busy', refType: 'tracked_account', refId: ytBusy.id, payload: { trackedAccountId: ytBusy.id }, runAt: new Date(Date.now() + 2 * 3600_000) })).task;
  taskIds.push(busyTask.id);
  const farBefore = (await acct(ytFar.id)).nextRefreshAt!.getTime();

  r = await http('POST', '/api/collection/run', A.token);
  check('collection run is admin only (403)', r.status === 403);
  let tk = await tick();
  check('collection tick task succeeded', tk.task.status === 'success', tk.task.error ?? '');
  const aTasks = await tasksOf(ytA.id);
  const a1 = await acct(ytA.id);
  check('due account: exactly one scheduled tracked-refresh, runAt = slot, owner = account owner, idempotency key per slot',
    aTasks.length === 1 && aTasks[0]!.status === 'scheduled' && aTasks[0]!.runAt?.getTime() === slot.getTime() && aTasks[0]!.createdBy === A.id
      && aTasks[0]!.idempotencyKey === `scheduled:${ytA.id}:${slot.toISOString()}` && (aTasks[0]!.payload as any).scheduled === true,
    `${aTasks.length} ${aTasks[0]?.status} ${aTasks[0]?.idempotencyKey}`);
  check('slot advanced by the interval; no skip code', a1.nextRefreshAt?.getTime() === slot.getTime() + 6 * 3600_000 && a1.scheduleSkipCode === null);
  const bTasks = await tasksOf(ytB.id);
  check('other user\'s due account queued too, owned by that user', bTasks.length === 1 && bTasks[0]!.createdBy === B.id);
  const p1 = await acct(ytPaused.id); const bz = await acct(ytBusy.id); const ig1 = await acct(igA.id);
  check('paused → skipped (tracked.paused), slot advanced, no task', p1.scheduleSkipCode === 'tracked.paused' && p1.nextRefreshAt!.getTime() > slot.getTime() && (await tasksOf(ytPaused.id)).length === 0);
  check('refresh in progress → skipped (tracked.refresh_in_progress)', bz.scheduleSkipCode === 'tracked.refresh_in_progress' && (await tasksOf(ytBusy.id)).length === 1);
  check('platform without a source → skipped (tracked.schedule_manual_only), no task', ig1.scheduleSkipCode === 'tracked.schedule_manual_only' && (await tasksOf(igA.id)).length === 0);
  check('not yet due → untouched', (await acct(ytFar.id)).nextRefreshAt!.getTime() === farBefore && (await tasksOf(ytFar.id)).length === 0);
  check('tick result lists skips with codes', tk.result.tracked.skipped.some((s: any) => s.id === ytPaused.id && s.code === 'tracked.paused'), JSON.stringify(tk.result.tracked).slice(0, 200));

  tk = await tick();
  check('second tick: nothing new for the same slot', (await tasksOf(ytA.id)).length === 1);
  // Same slot again (as if another process had read the row before it was advanced). While its task is unfinished the
  // slot is refused as in progress; once that task ended (cancelled here) the idempotency key still prevents a second run.
  await db.update(TA).set({ nextRefreshAt: slot }).where(eq(TA.id, ytA.id));
  tk = await tick();
  check('replayed slot while its task is pending → skipped (tracked.refresh_in_progress), still one task',
    tk.result.tracked.skipped.some((s: any) => s.id === ytA.id && s.code === 'tracked.refresh_in_progress') && (await tasksOf(ytA.id)).length === 1);
  await http('POST', `/api/tasks/${aTasks[0]!.id}/cancel`, T);
  await db.update(TA).set({ nextRefreshAt: slot }).where(eq(TA.id, ytA.id));
  tk = await tick();
  check('replayed slot after its task ended → idempotency key returns the existing task (duplicate), still one task',
    tk.result.tracked.duplicate >= 1 && (await tasksOf(ytA.id)).length === 1, JSON.stringify(tk.result.tracked).slice(0, 120));
  // Two concurrent ticks on a fresh slot: one claims it.
  const raceSlot = new Date(slot.getTime() + 60_000);
  await db.update(TA).set({ nextRefreshAt: raceSlot }).where(eq(TA.id, ytRace.id));
  await Promise.all([scheduleTrackedRefreshes(), scheduleTrackedRefreshes()]);
  check('two concurrent ticks → exactly one task for the slot', (await tasksOf(ytRace.id)).length === 1);

  r = await http('GET', `/api/tracked-accounts/${ytA.id}`, A.token);
  check('account shows next run + last refresh task (the scheduled one)', r.body.account.nextRefreshAt === a1.nextRefreshAt!.toISOString() && r.body.account.lastRefresh?.id === aTasks[0]!.id);

  // Run-time re-check of scheduled runs (no API call is made).
  const sp = (await createTask({ type: 'tracked-refresh', userId: A.id, label: 'paused', refType: 'tracked_account', refId: ytPaused.id, payload: { trackedAccountId: ytPaused.id, scheduled: true } })).task;
  taskIds.push(sp.id);
  let done = await waitTask(sp.id);
  check('scheduled run on a paused account → success, skipped (tracked.paused)', done.status === 'success' && (done.result as any)?.outcome === 'skipped' && (done.result as any)?.code === 'tracked.paused');
  r = await http('PATCH', `/api/tracked-accounts/${ytFar.id}`, A.token, { refreshIntervalHours: null });
  check('switch schedule off → interval and next slot cleared', r.status === 200 && r.body.account.refreshIntervalHours === null && r.body.account.nextRefreshAt === null);
  const so = (await createTask({ type: 'tracked-refresh', userId: A.id, label: 'off', refType: 'tracked_account', refId: ytFar.id, payload: { trackedAccountId: ytFar.id, scheduled: true } })).task;
  taskIds.push(so.id);
  done = await waitTask(so.id);
  check('scheduled run after the schedule was switched off → skipped (tracked.schedule_off)', done.status === 'success' && (done.result as any)?.code === 'tracked.schedule_off');

  // Cancel the future scheduled refreshes (they must not call YouTube with a dummy key).
  const pending = await db.select().from(schema.tasks).where(and(inArray(schema.tasks.refId, accountIds), inArray(schema.tasks.status, ['pending', 'scheduled'])));
  for (const t of pending) { const c = await http('POST', `/api/tasks/${t.id}/cancel`, T); if (c.status >= 400) console.log('   cancel', t.id, c.status, c.text.slice(0, 100)); }

  if (REAL_KEY) {
    // A real scheduled refresh: slot in the past → the task runs at once against the YouTube Data API.
    const real = await track(A.token, 'https://www.youtube.com/@YouTube');
    await http('PATCH', `/api/tracked-accounts/${real.id}`, A.token, { refreshIntervalHours: 24 });
    await db.update(TA).set({ nextRefreshAt: new Date(Math.floor(Date.now() / 1000) * 1000 - 1000) }).where(eq(TA.id, real.id));
    await tick();
    const [rt] = await tasksOf(real.id);
    const fin = rt ? await waitTask(rt.id) : null;
    const snaps = await db.select().from(schema.trackedAccountSnapshots).where(eq(schema.trackedAccountSnapshots.trackedAccountId, real.id));
    check('real key: scheduled refresh of @YouTube via the Data API succeeds and stores a snapshot', fin?.status === 'success' && snaps.length === 1 && snaps[0]!.source === 'api', fin?.error ?? '');
  }

  // Unconfigured API → skipped with the coded refusal.
  if (keyTouched) {
    await http('PUT', '/api/settings/youtube', T, { apiKey: null });
    await db.update(TA).set({ nextRefreshAt: new Date(slot.getTime() + 120_000) }).where(eq(TA.id, ytA.id));
    await tick();
    const a2 = await acct(ytA.id);
    check('API key not configured → skipped (tracked.youtube_no_api_key), no new task', a2.scheduleSkipCode === 'tracked.youtube_no_api_key' && (await tasksOf(ytA.id)).length === 1);
  } else console.log('- skipped: unconfigured-key check (a YouTube key is configured on this instance and YOUTUBE_TEST_API_KEY is unset)');

  // ================================================================ 趋势热点 (trending)
  const putSettings = (token: string, body: Record<string, unknown>) => http('PUT', '/api/trending/settings', token, body);
  const base = { regions: [] as string[], categoryId: null, intervalHours: 24, maxResults: 10, retentionDays: 30 };
  r = await putSettings(A.token, { ...base, regions: ['US'] });
  check('trending settings are admin only (403)', r.status === 403);
  r = await putSettings(T, { ...base, regions: ['USA'] });
  const r3 = await putSettings(T, { ...base, intervalHours: 5 });
  const r4 = await putSettings(T, { ...base, maxResults: 51 });
  check('invalid region / interval / maxResults → 400', r.status === 400 && r3.status === 400 && r4.status === 400);
  await putSettings(T, base);
  r = await http('POST', '/api/trending/refresh', T);
  check('refresh without regions → 400 trending.no_regions', r.status === 400 && r.body.code === 'trending.no_regions');
  r = await putSettings(T, { ...base, regions: ['us', 'in', 'US'] });
  check('regions upper-cased and deduplicated', r.status === 200 && JSON.stringify(r.body.settings.regions) === '["US","IN"]');
  const keyNow = (await http('GET', '/api/settings/youtube', T)).body.youtube.apiKeySet;
  if (!keyNow) {
    r = await http('GET', '/api/trending', A.token);
    check('page data without key: 200, configured=false, notice tracked.youtube_no_api_key (no crash)', r.status === 200 && r.body.configured === false && r.body.notice === 'tracked.youtube_no_api_key');
    r = await http('POST', '/api/trending/refresh', T);
    check('refresh now without key → 400 tracked.youtube_no_api_key', r.status === 400 && r.body.code === 'tracked.youtube_no_api_key');
    tk = await tick();
    check('tick without key: trending skipped with the code', tk.result.trending.skipped === 'tracked.youtube_no_api_key');
  }
  r = await http('POST', '/api/trending/refresh', A.token);
  check('refresh now is admin only (403)', r.status === 403);
  await putSettings(T, base); // no regions: the following ticks schedule no trending fetch

  // Seeded snapshots (fictional region ZZ) → rank changes computed by the API.
  const S = schema.trendingSnapshots; const I = schema.trendingItems;
  const day = 86400_000;
  const dayStart = Math.floor(Date.now() / day) * day;
  const seed = async (slotAt: number, captured: number, vids: [string, string, string[]][]) => {
    const [s] = await db.insert(S).values({ region: 'ZZ', slotAt: new Date(slotAt), capturedAt: new Date(captured), itemCount: vids.length }).returning();
    snapshotIds.push(s!.id);
    if (vids.length) await db.insert(I).values(vids.map(([v, title, tags], i) => ({ snapshotId: s!.id, rank: i + 1, videoId: `${v}${tag}`, title, channelTitle: 'Chan', views: 1000 - i, tags })));
    return s!;
  };
  const old = await seed(dayStart - 40 * day, dayStart - 40 * day, [['o', 'Old one', []]]);
  const prev = await seed(dayStart - 2 * day, dayStart - 2 * day + 60_000, [['a', 'Alpha', []], ['b', 'Bravo video', []], ['c', 'Charlie', []]]);
  const cur = await seed(dayStart - day, dayStart - day + 60_000, [['b', 'Bravo video', []], ['a', 'Alpha', ['MusicTag']], ['d', 'Delta', []]]);
  r = await http('GET', '/api/trending?region=zz', B.token);
  const it = (v: string) => r.body.items?.find((x: any) => x.videoId === `${v}${tag}`);
  check('user reads trending (any role); latest ZZ snapshot shown', r.status === 200 && r.body.snapshot?.id === cur.id && r.body.items.length === 3, `${r.status} ${r.body?.snapshot?.id}`);
  if (!(it('b')?.rankChange === 1)) console.log('   ', JSON.stringify({ prev: r.body.previous, items: r.body.items?.map((x: any) => [x.videoId, x.rank, x.prevRank, x.rankChange, x.isNew]) }));
  check('rank change vs previous snapshot: b +1, a −1, d new; previous reported',
    it('b')?.rankChange === 1 && it('a')?.rankChange === -1 && it('d')?.isNew === true && it('d')?.rankChange === null && r.body.previous?.id === prev.id);
  check('links only: watch URL per video', it('b')?.url === `https://www.youtube.com/watch?v=b${tag}`);
  check('history lists the region\'s snapshots (newest first)', r.body.history?.[0]?.id === cur.id && r.body.history.some((h: any) => h.id === old.id));
  const rq = await http('GET', `/api/trending?region=ZZ&q=${encodeURIComponent('bravo')}`, A.token);
  const rt2 = await http('GET', `/api/trending?region=ZZ&q=${encodeURIComponent('musictag')}`, A.token);
  check('filter q matches title and tags', rq.body.items?.length === 1 && rq.body.items[0].videoId === `b${tag}` && rt2.body.items?.length === 1 && rt2.body.items[0].videoId === `a${tag}`);
  const rp = await http('GET', `/api/trending?snapshotId=${prev.id}`, A.token);
  check('older snapshot by id: its own previous (40 days old) is used', rp.body.snapshot?.id === prev.id && rp.body.previous?.id === old.id && rp.body.items.every((x: any) => x.isNew === true));
  const r404 = await http('GET', '/api/trending?snapshotId=00000000-0000-0000-0000-000000000000', A.token);
  check('unknown snapshot → 404 trending.snapshot_not_found', r404.status === 404 && r404.body.code === 'trending.snapshot_not_found');
  const dash = await http('GET', '/api/dashboard?tz=UTC', A.token);
  check('dashboard: no trending widget any more (simplified 2026-11-19)', dash.status === 200 && !('trending' in (dash.body.widgets ?? {})), JSON.stringify(dash.body.order));

  // Retention via the tick (30 days): the 40-day-old snapshot goes, items cascade; recent ones stay.
  tk = await tick();
  const left = await db.select({ id: S.id }).from(S).where(inArray(S.id, snapshotIds));
  const leftItems = await db.select({ id: I.id }).from(I).where(eq(I.snapshotId, old.id));
  check('retention: snapshot older than retentionDays purged (items cascade), newer kept', tk.result.purged >= 1 && left.length === 2 && !left.some((x) => x.id === old.id) && leftItems.length === 0, `purged=${tk.result.purged}`);

  // Scheduled trending: one task per region per slot, idempotent.
  if (REAL_KEY) {
    await http('PUT', '/api/settings/youtube', T, { apiKey: REAL_KEY });
    await putSettings(T, { ...base, regions: ['US'] });
    r = await http('POST', '/api/trending/refresh', T);
    taskIds.push(...(r.body.taskIds ?? []));
    const fin = r.status === 202 ? await waitTask(r.body.taskIds[0]) : null;
    const g = await http('GET', '/api/trending?region=US', A.token);
    check('real key: refresh now fetches the US chart (10 videos, ranks 1..10, watch links)', fin?.status === 'success' && g.body.items?.length === 10
      && g.body.items.every((x: any, i: number) => x.rank === i + 1 && x.url.startsWith('https://www.youtube.com/watch?v=') && x.title), fin?.error ?? `${g.body.items?.length}`);
    tk = await tick();
    const t1 = await tick();
    const st = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'trending-refresh'), like(schema.tasks.idempotencyKey, 'US:%')));
    taskIds.push(...st.map((x) => x.id));
    for (const x of st) await waitTask(x.id);
    const slots = await db.select().from(S).where(and(eq(S.region, 'US'), eq(S.slotAt, new Date(st[0]?.payload ? (st[0].payload as any).slot : 0))));
    check('real key: scheduled trending task once per slot; manual + scheduled runs keep one snapshot per slot',
      tk.result.trending.queued + tk.result.trending.duplicate === 1 && t1.result.trending.duplicate === 1 && st.length === 1 && slots.length === 1, JSON.stringify(tk.result.trending));
    await http('PUT', '/api/settings/youtube', T, { apiKey: null });
  } else if (!keyWasSet) {
    keyTouched = true;
    await http('PUT', '/api/settings/youtube', T, { apiKey: DUMMY_KEY });
    await putSettings(T, { ...base, regions: ['US'] });
    tk = await tick();
    const t1 = await tick();
    const st = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'trending-refresh'), like(schema.tasks.idempotencyKey, 'US:%'), sql`${schema.tasks.createdAt} >= ${startedAt.toISOString()}::timestamptz`));
    taskIds.push(...st.map((x) => x.id));
    check('scheduled trending: one task per region per slot (second tick = duplicate)', tk.result.trending.queued === 1 && t1.result.trending.duplicate === 1 && st.length === 1, JSON.stringify([tk.result.trending, t1.result.trending]));
    const fin = st[0] ? await waitTask(st[0].id) : null;
    check('dummy key against the real YouTube API → task failed with tracked.youtube_key_invalid', fin?.status === 'failed' && fin.errorCode === 'tracked.youtube_key_invalid', `${fin?.status} ${fin?.errorCode}`);
    await http('PUT', '/api/settings/youtube', T, { apiKey: null });
  } else console.log('- skipped: scheduled trending fetch (a key is configured here and YOUTUBE_TEST_API_KEY is unset)');

  // ================================================================ audit
  await sleep(500);
  const acts = await sqlClient`select action, detail from audit_logs where at >= ${startedAt.toISOString()}::timestamptz and (action like 'comment.template_%' or action in ('tracked.update', 'trending.settings_update', 'trending.refresh', 'collection.run'))`;
  const have = new Set(acts.map((x) => x.action as string));
  const need = ['comment.template_create', 'comment.template_update', 'comment.template_delete', 'tracked.update', 'trending.settings_update', 'trending.refresh', 'collection.run'];
  check('audit actions recorded', need.every((x) => have.has(x)), [...have].sort().join(','));
  check('audit: template create records the persona (no kind); schedule change records the interval',
    acts.some((x) => x.action === 'comment.template_create' && !('kind' in (x.detail ?? {})) && x.detail?.persona === 'Fitness Coach')
      && acts.some((x) => x.action === 'tracked.update' && x.detail?.refreshIntervalHours === 6));
} catch (err) {
  check(`unexpected error: ${(err as Error).stack ?? (err as Error).message}`, false);
} finally {
  if (keyTouched) await http('PUT', '/api/settings/youtube', T, { apiKey: null });
  if (trendingRow) await db.update(schema.settings).set({ value: trendingRow.value }).where(eq(schema.settings.key, 'trending'));
  else await db.delete(schema.settings).where(eq(schema.settings.key, 'trending'));
  if (snapshotIds.length) await db.delete(schema.trendingSnapshots).where(inArray(schema.trendingSnapshots.id, snapshotIds));
  await db.delete(schema.trendingSnapshots).where(and(eq(schema.trendingSnapshots.region, 'ZZ')));
  if (templateIds.length) await db.delete(schema.commentTemplates).where(inArray(schema.commentTemplates.id, templateIds));
  if (publicPersonaIds.length) await db.delete(schema.personas).where(inArray(schema.personas.id, publicPersonaIds));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  if (accountIds.length) await db.delete(schema.tasks).where(inArray(schema.tasks.refId, accountIds));
  if (taskIds.length) await db.delete(schema.tasks).where(inArray(schema.tasks.id, taskIds));
  const leftA = await db.select().from(TA).where(inArray(TA.id, accountIds.length ? accountIds : ['00000000-0000-0000-0000-000000000000']));
  const leftT = await db.select().from(schema.commentTemplates).where(inArray(schema.commentTemplates.id, templateIds.length ? templateIds : ['00000000-0000-0000-0000-000000000000']));
  check('cleanup: test users, accounts, templates, snapshots and tasks removed', leftA.length === 0 && leftT.length === 0);
  await closeTaskQueues();
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
