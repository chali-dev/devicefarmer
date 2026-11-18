/**
 * 人设每日草稿 (AI drafts per persona) against the real API, DB, Redis and the real Anthropic API. No mocks.
 * - AI 草稿 settings in the persona form (POST/PATCH /api/personas): RBAC (personal: owner / admin, others 404; public:
 *   admin only, users 403), drafts per day 1..10, draft owner rules (public: required to switch on, must be an enabled
 *   user; personal: not settable), the old 内容设定 endpoints are gone (404), list shows draftEnabled/draftsPerDay and the
 *   draft owner only to managers.
 * - The prompt (buildUserMessage + loadExamples, no model call): 定位, tone preset + note, emoji, length range, topics,
 *   banned words, hashtags, audience, fixed opening/closing, notes, Language zh-CN, the persona's post examples (≤ 5,
 *   in its own scope, oldest first; not reply examples, not other users' templates).
 * - Last generation runs in GET /api/personas/:id (persona form; the list has no runs since 2026-11-18): newest first
 *   (trigger, status, error code), only for managers (owner/admin; public personas: admin), users get none.
 * - AI settings (admin): key write-only (never echoed, sealed in the DB, not in audit), model/hour validation.
 * - Without a key: the schedule creates nothing (reason ai.not_configured), "generate now" → 400 ai.not_configured.
 * - With an obviously invalid key: a real call to the Anthropic API fails the task as ai.key_invalid after ONE attempt,
 *   creates no content, and neither the task payload nor its logs contain the key. Rate limit 1 per persona per 10 min.
 * - Schedule: not before the configured hour, once per persona per local day (idempotent), skips personas whose draft
 *   owner is disabled, nothing when switched off.
 * - Writing drafts (saveDrafts) from a HAND-MADE structured result (no model involved): owner, zh-CN, ai-draft tag,
 *   ai_generated origin + needsTranslation (target accounts in other languages), targets = owner's accounts with the
 *   persona on enabled platforms only, fixed opening/closing added once, banned-word drafts dropped (also via the
 *   opening), hashtags appended, suggested media by tag, visibility to other users.
 * - Workspace ID setting (for keys not scoped to a workspace): format validated, set/cleared, shown (not secret), in
 *   the audit; mapApiError turns the API's documented workspace errors into ai.workspace_required/_invalid/_not_found.
 * - With ANTHROPIC_TEST_API_KEY set: one real generation (count 1) end to end. With a key that isn't scoped to a
 *   workspace and no ANTHROPIC_TEST_WORKSPACE_ID, the real call must fail as ai.workspace_required (1 attempt); with
 *   ANTHROPIC_TEST_WORKSPACE_ID it is sent as anthropic-workspace-id and the generation must succeed.
 * Usage (from apps/api, API running with default ENABLED_PLATFORMS=instagram):
 *   E2E_API=http://127.0.0.1:3000 npx tsx --env-file=../../.env scripts/persona-drafts-check.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, like } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import Anthropic from '@anthropic-ai/sdk';
import { Redis } from 'ioredis';
import { config } from '../src/config.js';
import { buildUserMessage, DRAFT_TAG, DRAFT_TASK, loadExamples, mapApiError, saveDrafts, schedulePersonaDrafts, SYSTEM_PROMPT } from '../src/modules/ai/drafts.js';
import { closeTaskQueues } from '../src/modules/tasks/core.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
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
async function waitTask(id: string, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
    if (t && ['success', 'failed', 'cancelled'].includes(t.status)) return t;
    await sleep(500);
  }
  throw new Error(`task ${id} did not finish`);
}

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('hex');
const userIds: string[] = [];
const publicPersonaIds: string[] = [];
const sharedTemplateIds: string[] = [];
const mediaIds: string[] = [];
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
const settingsBefore = (await db.select().from(schema.settings).where(eq(schema.settings.key, 'ai')))[0]?.value ?? null;
const INVALID_KEY = `sk-ant-api03-invalid-${'x'.repeat(40)}-${tag}`;
const localAt = (h: number) => { const d = new Date(); d.setHours(h, 30, 0, 0); return d; };

try {
  const mk = async (name: string) => {
    const r = await http('POST', '/api/users', T, { username: name, password: pw, role: 'user' });
    const id = r.body.user?.id ?? r.body.id; userIds.push(id);
    return { id, token: await login(name, pw) };
  };
  const A = await mk(`pda${tag}`);
  const B = await mk(`pdb${tag}`);
  const C = await mk(`pdc${tag}`);

  // ================================================================ AI 草稿 in the persona form: validation, RBAC
  const STYLE = {
    tone: 'warm', toneNote: '像邻家厨师一样温柔', emoji: 'low', length: 'high', topics: ['家常菜', 'weeknight dinners'],
    bannedWords: ['forbiddenword', '最便宜'], hashtags: ['#homecooking', 'dinner'], audience: '上班族', opening: '今晚吃什么？', closing: '你们最爱哪道？', notes: '不要推荐品牌',
  };
  const pA = (await http('POST', '/api/personas', A.token, { scope: 'mine', name: `Chef ${tag}`, description: '下班后 20 分钟的家常菜', style: STYLE })).body.persona;
  const pP = (await http('POST', '/api/personas', T, { scope: 'public', name: `Brand ${tag}` })).body.persona;
  const pQ = (await http('POST', '/api/personas', T, { scope: 'public', name: `Quiet ${tag}` })).body.persona;
  publicPersonaIds.push(pP.id, pQ.id);
  let r = await http('GET', `/api/personas/${pA.id}`, A.token);
  check('owner reads a personal persona (AI off, 4/day, draft owner = themselves, style stored)',
    r.status === 200 && r.body.persona.draftEnabled === false && r.body.persona.draftsPerDay === 4 && r.body.persona.draftOwnerName === `pda${tag}`
      && r.body.persona.style.tone === 'warm' && r.body.persona.style.hashtags.join() === 'homecooking,dinner', JSON.stringify(r.body?.persona ?? r.body).slice(0, 300));
  r = await http('GET', `/api/personas/${pA.id}/drafts`, A.token);
  const rOld = await http('PUT', `/api/personas/${pA.id}/drafts`, A.token, { draftsPerDay: 2 });
  check('old 内容设定 endpoints are gone (GET/PUT /api/personas/:id/drafts → 404)', r.status === 404 && rOld.status === 404, `${r.status} ${rOld.status}`);
  r = await http('GET', `/api/personas/${pA.id}`, B.token);
  const r2 = await http('PATCH', `/api/personas/${pA.id}`, B.token, { draftsPerDay: 2 });
  check('another user: 404 persona.not_found (read and write)', r.status === 404 && r.body.code === 'persona.not_found' && r2.status === 404);
  const r3 = await http('PATCH', `/api/personas/${pP.id}`, A.token, { draftsPerDay: 2 });
  r = await http('GET', `/api/personas/${pP.id}`, A.token);
  check('public persona: users may read it (no draft owner, no runs) but not change it (403)',
    r.status === 200 && !('draftOwnerId' in r.body.persona) && !('runs' in r.body.persona) && r.body.persona.writable === false && r3.status === 403 && r3.body.code === 'persona.admin_only');
  r = await http('PATCH', `/api/personas/${pA.id}`, T, { draftsPerDay: 3 });
  check('admin edits a user\'s personal persona', r.status === 200 && r.body.persona.draftsPerDay === 3);
  r = await http('PATCH', `/api/personas/${pA.id}`, A.token, { draftsPerDay: 0 });
  const r4 = await http('PATCH', `/api/personas/${pA.id}`, A.token, { draftsPerDay: 11 });
  check('drafts per day outside 1..10 → 400', r.status === 400 && r4.status === 400);
  r = await http('PATCH', `/api/personas/${pA.id}`, A.token, { style: { lang: 'en' } });
  check('the persona has no language any more (style.lang → 400, language belongs to the account)', r.status === 400, `${r.status}`);
  r = await http('PATCH', `/api/personas/${pA.id}`, A.token, { draftOwnerId: B.id });
  check('personal persona: draft owner not settable → 400 persona.draft_owner_personal', r.status === 400 && r.body.code === 'persona.draft_owner_personal');

  // examples (范例) = templates of the persona in its own scope
  const tpl = async (token: string, body: Record<string, unknown>) => (await http('POST', '/api/comment-templates', token, { text: 'Example caption text', ...body })).body.template;
  const sharedPost = await tpl(T, { kind: 'post', name: `shared ${tag}`, shared: true, personaId: pP.id, text: 'Shared brand example' }); sharedTemplateIds.push(sharedPost.id);
  const aPosts = [];
  for (let k = 1; k <= 6; k++) aPosts.push(await tpl(A.token, { kind: 'post', name: `a-post${k} ${tag}`, personaId: pA.id, text: `示例发文 ${k} ${tag}` }));
  const aReply = await tpl(A.token, { kind: 'comment', name: `a-reply ${tag}`, personaId: pA.id, text: `回复范例 ${tag}` });
  const aLoose = await tpl(A.token, { kind: 'post', name: `a-loose ${tag}`, text: `没有人设的发文 ${tag}` });
  const aOnPublic = await tpl(A.token, { kind: 'post', name: `a-pub ${tag}`, personaId: pP.id, text: `A 的私有发文用公共人设 ${tag}` });
  check('templates created (6 post + 1 reply example of pA, 1 without persona, 1 private on the public persona)', aPosts.every((x) => !!x?.id) && !!aReply?.id && !!aLoose?.id && !!aOnPublic?.id);

  // public persona: draft owner
  r = await http('PATCH', `/api/personas/${pP.id}`, T, { draftEnabled: true });
  check('public persona switched on without a draft owner → 400 persona.draft_owner_required', r.status === 400 && r.body.code === 'persona.draft_owner_required');
  r = await http('POST', '/api/personas', T, { scope: 'public', name: `On ${tag}`, draftEnabled: true });
  check('creating a public persona switched on without a draft owner → 400 persona.draft_owner_required', r.status === 400 && r.body.code === 'persona.draft_owner_required');
  await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, C.id));
  r = await http('PATCH', `/api/personas/${pP.id}`, T, { draftOwnerId: C.id });
  const r6 = await http('PATCH', `/api/personas/${pP.id}`, T, { draftOwnerId: randomUUID() });
  check('disabled / unknown user as draft owner → 400 persona.draft_owner_invalid', r.status === 400 && r.body.code === 'persona.draft_owner_invalid' && r6.status === 400 && r6.body.code === 'persona.draft_owner_invalid');
  r = await http('PATCH', `/api/personas/${pP.id}`, T, { draftEnabled: true, draftsPerDay: 2, draftOwnerId: B.id });
  const g1 = await http('GET', `/api/personas/${pP.id}`, T);
  check('admin switches a public persona on with an enabled draft owner', r.status === 200 && r.body.persona.draftEnabled && g1.body.persona.draftOwnerName === `pdb${tag}`);
  r = await http('PATCH', `/api/personas/${pP.id}`, T, { draftOwnerId: null });
  check('clearing the owner of a switched-on public persona → 400 persona.draft_owner_required', r.status === 400 && r.body.code === 'persona.draft_owner_required');
  // pQ: switched on with C as owner while C was enabled, then C disabled → the schedule skips it
  await db.update(schema.users).set({ disabled: false }).where(eq(schema.users.id, C.id));
  r = await http('PATCH', `/api/personas/${pQ.id}`, T, { draftEnabled: true, draftOwnerId: C.id });
  await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, C.id));
  check('public persona pQ switched on (owner C, disabled afterwards)', r.status === 200);
  r = await http('GET', '/api/personas?scope=public', A.token);
  const listed = (r.body.personas as any[]).find((p) => p.id === pP.id);
  const listedT = ((await http('GET', '/api/personas?scope=public', T)).body.personas as any[]).find((p) => p.id === pP.id);
  check('persona list: draftEnabled/draftsPerDay + style shown; draft owner only to managers (admin)',
    listed && listed.draftEnabled === true && listed.draftsPerDay === 2 && !!listed.style && !('draftOwnerId' in listed) && listedT?.draftOwnerId === B.id);

  // ================================================================ prompt construction (no model call)
  {
    const [row] = await db.select().from(schema.personas).where(eq(schema.personas.id, pA.id));
    const ex = await loadExamples(row!);
    const msg = buildUserMessage({ persona: row!, count: 3, day: '2026-11-18', examples: ex, recent: [{ title: '上周的汤', body: '番茄蛋汤做法' }] });
    const has = (x: string) => msg.includes(x);
    check('prompt: examples = the first 5 post examples of the persona (no reply example, no template without persona)',
      ex.length === 5 && ex.every((e, k) => e.text === `示例发文 ${k + 1} ${tag}`) && !has(`回复范例 ${tag}`) && !has(`没有人设的发文 ${tag}`) && !has(`示例发文 6 ${tag}`), ex.map((e) => e.text).join(' | '));
    check('prompt: 定位, tone preset + note, emoji, length range (high = 500–1500), Language zh-CN',
      has('Positioning: 下班后 20 分钟的家常菜') && has('Tone: warm — 像邻家厨师一样温柔') && has('Emoji: at most 1 emoji') && has('Length: 500 to 1500 characters') && has('Language: zh-CN'), msg.slice(0, 600));
    check('prompt: topics, banned words, hashtags (# stripped), audience, fixed opening/closing, notes, recent posts',
      has('- 家常菜') && has('- weeknight dinners') && has('- forbiddenword') && has('- 最便宜') && has('- homecooking') && has('Audience: 上班族')
        && has('Fixed opening line (added by the system): 今晚吃什么？') && has('Fixed closing line (added by the system): 你们最爱哪道？') && has('Notes: 不要推荐品牌') && has('上周的汤'));
    check('system prompt: Chinese only, draft-only role', SYSTEM_PROMPT.includes('Write in Simplified Chinese (zh-CN)') && SYSTEM_PROMPT.includes('DRAFT') && !SYSTEM_PROMPT.includes('BCP-47'));
    const [pubRow] = await db.select().from(schema.personas).where(eq(schema.personas.id, pP.id));
    const exP = await loadExamples(pubRow!);
    const msgP = buildUserMessage({ persona: pubRow!, count: 1, day: '2026-11-18', examples: exP, recent: [] });
    check('prompt (public persona, empty style): only shared examples (not A\'s private one), defaults casual / 2–4 emoji / 150–500',
      exP.length === 1 && exP[0]!.text === 'Shared brand example' && msgP.includes('Tone: casual — friendly and everyday') && msgP.includes('Emoji: 2 to 4 emoji') && msgP.includes('Length: 150 to 500 characters')
        && msgP.includes('Positioning: (none)') && !msgP.includes(`A 的私有发文用公共人设 ${tag}`));
  }

  // ================================================================ AI settings (admin, key write-only)
  r = await http('GET', '/api/settings/ai', A.token);
  check('users cannot read the AI settings (403)', r.status === 403);
  await http('PUT', '/api/settings/ai', T, { apiKey: null, enabled: true, model: 'claude-opus-5-5', hour: 6 });
  r = await http('GET', '/api/settings/ai', T);
  check('defaults: no key, model claude-opus-5-5, hour 6, on', r.status === 200 && r.body.ai.keySet === false && r.body.ai.model === 'claude-opus-5-5' && r.body.ai.hour === 6 && r.body.ai.enabled === true
    && r.body.models.join() === 'claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5');
  r = await http('POST', `/api/personas/${pA.id}/drafts/generate`, A.token);
  check('generate now without a key → 400 ai.not_configured', r.status === 400 && r.body.code === 'ai.not_configured', `${r.status} ${r.body?.code}`);
  await http('PATCH', `/api/personas/${pA.id}`, A.token, { draftEnabled: true, draftsPerDay: 2 });
  let sch = await schedulePersonaDrafts(localAt(23));
  const noKeyTasks = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, DRAFT_TASK), gte(schema.tasks.createdAt, t0)));
  check('schedule without a key: nothing created, reason ai.not_configured', sch.reason === 'ai.not_configured' && sch.created === 0 && noKeyTasks.length === 0, JSON.stringify(sch));
  r = await http('PUT', '/api/settings/ai', T, { model: 'gpt-x' });
  const r7 = await http('PUT', '/api/settings/ai', T, { hour: 24 });
  const r8 = await http('PUT', '/api/settings/ai', T, { apiKey: 'short' });
  const r9 = await http('PUT', '/api/settings/ai', A.token, { enabled: false });
  check('invalid model / hour / key format → 400; users 403', r.status === 400 && r7.status === 400 && r8.status === 400 && r9.status === 403);
  r = await http('PUT', '/api/settings/ai', T, { apiKey: INVALID_KEY, hour: 6 });
  const g = await http('GET', '/api/settings/ai', T);
  const stored = JSON.stringify((await db.select().from(schema.settings).where(eq(schema.settings.key, 'ai')))[0]?.value ?? {});
  check('key saved write-only: keySet true, never echoed, sealed in the DB',
    r.status === 200 && r.body.ai.keySet === true && !r.text.includes(INVALID_KEY) && !g.text.includes(INVALID_KEY) && !stored.includes(INVALID_KEY) && stored.includes('"apiKeyEnc":"v1:'));

  // ================================================================ workspace ID (keys not scoped to a workspace)
  {
    const bad = await http('PUT', '/api/settings/ai', T, { workspaceId: 'ws-123' });
    const okWs = await http('PUT', '/api/settings/ai', T, { workspaceId: 'wrkspc_01TestWorkspace0001' });
    const kept = await http('PUT', '/api/settings/ai', T, { hour: 6 });
    const cleared = await http('PUT', '/api/settings/ai', T, { workspaceId: '' });
    const userWs = await http('PUT', '/api/settings/ai', A.token, { workspaceId: 'wrkspc_01TestWorkspace0001' });
    check('workspace ID: wrong format 400, set/kept/cleared (\'\' clears), users 403, key still set',
      bad.status === 400 && okWs.status === 200 && okWs.body.ai.workspaceId === 'wrkspc_01TestWorkspace0001' && kept.body.ai.workspaceId === 'wrkspc_01TestWorkspace0001'
      && cleared.body.ai.workspaceId === null && userWs.status === 403 && cleared.body.ai.keySet === true, `${bad.status} ${okWs.status} ${JSON.stringify(cleared.body?.ai)}`);
    // The documented error bodies (Authentication → Select a workspace) as the SDK builds them from a real response.
    const mk = (status: number, type: string, message: string) => Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, undefined, new Headers());
    const codes = [
      mk(400, 'invalid_request_error', 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.'),
      mk(400, 'invalid_request_error', 'anthropic-workspace-id header must be a valid workspace ID.'),
      mk(404, 'not_found_error', 'Workspace `wrkspc_01X` not found.'),
      mk(400, 'invalid_request_error', 'max_tokens: Field required'),
    ].map((e) => (mapApiError(e) as Error & { code?: string }).code);
    check('mapApiError: workspace errors → ai.workspace_required / ai.workspace_invalid / ai.workspace_not_found, other 400 → ai.request_failed',
      codes.join() === 'ai.workspace_required,ai.workspace_invalid,ai.workspace_not_found,ai.request_failed', codes.join());
  }

  // ================================================================ real call with an invalid key
  r = await http('POST', `/api/personas/${pA.id}/drafts/generate`, B.token);
  const r10 = await http('POST', `/api/personas/${pP.id}/drafts/generate`, A.token);
  check('generate now: other user 404, public persona as user 403', r.status === 404 && r10.status === 403);
  r = await http('POST', `/api/personas/${pA.id}/drafts/generate`, A.token);
  check('generate now → 202 task', r.status === 202 && !!r.body.task?.id, `${r.status} ${r.text.slice(0, 120)}`);
  const manualId = r.body.task.id as string;
  r = await http('POST', `/api/personas/${pA.id}/drafts/generate`, A.token);
  check('second request within 10 min → 429 ai.rate_limited with seconds', r.status === 429 && r.body.code === 'ai.rate_limited' && Number(r.body.params?.seconds) > 500, `${r.status} ${JSON.stringify(r.body)}`);
  const mt = await waitTask(manualId);
  const mlogs = await db.select().from(schema.taskLogs).where(eq(schema.taskLogs.taskId, manualId));
  const logText = JSON.stringify(mlogs);
  check('real Anthropic call with an invalid key: task failed ai.key_invalid after 1 attempt (not retried)',
    mt.status === 'failed' && mt.errorCode === 'ai.key_invalid' && mt.attempts === 1, `${mt.status} ${mt.errorCode} attempts=${mt.attempts} ${mt.error}`);
  check('task payload and logs never contain the key; the log names the requested model',
    !JSON.stringify(mt.payload).includes(INVALID_KEY) && !logText.includes(INVALID_KEY) && !logText.includes('sk-ant') && logText.includes('drafts: requesting 1 from claude-opus-5-5'));
  let aDrafts = await db.select().from(schema.contents).where(and(eq(schema.contents.userId, A.id)));
  check('no content created by the failed run', aDrafts.length === 0);

  // ---- persona form: last runs (RBAC = managing the persona); the list carries none
  const runsOf = async (token: string, id: string) => {
    const res = await http('GET', `/api/personas/${id}`, token);
    return { status: res.status, runs: res.body?.persona?.runs as any[] | undefined, writable: res.body?.persona?.writable };
  };
  let lr = await runsOf(A.token, pA.id);
  const lrRun = lr.runs?.[0];
  check('form: owner sees the newest run of a personal persona (manual, failed ai.key_invalid, created null)',
    lrRun?.id === manualId && lrRun.trigger === 'manual' && lrRun.status === 'failed' && lrRun.errorCode === 'ai.key_invalid' && lrRun.created === null && !!lrRun.createdAt && !('payload' in lrRun),
    JSON.stringify(lrRun));
  const lrT = await runsOf(T, pA.id);
  const lrB = await runsOf(B.token, pA.id);
  check('form: admin sees the same run; another user gets 404', lrT.runs?.[0]?.id === manualId && lrB.status === 404);
  const lrPub = await runsOf(T, pP.id);
  const lrUserPub = await runsOf(A.token, pP.id);
  const listRow = ((await http('GET', '/api/personas?scope=mine', A.token)).body.personas as any[]).find((x) => x.id === pA.id);
  check('form: public persona without runs → [] for admin, no runs for users; the list has no lastDraftRun',
    Array.isArray(lrPub.runs) && lrPub.runs.length === 0 && lrUserPub.status === 200 && lrUserPub.runs === undefined && lrUserPub.writable === false && listRow && !('lastDraftRun' in listRow));

  // ================================================================ schedule (idempotent per local day)
  sch = await schedulePersonaDrafts(localAt(3));
  check('before the configured hour (06:00): reason ai.not_due', sch.reason === 'ai.not_due' && sch.created === 0);
  await http('PUT', '/api/settings/ai', T, { enabled: false });
  sch = await schedulePersonaDrafts(localAt(23));
  check('switched off: reason ai.disabled', sch.reason === 'ai.disabled' && sch.created === 0);
  r = await http('POST', `/api/personas/${pP.id}/drafts/generate`, T);
  check('generate now while switched off → 400 ai.disabled', r.status === 400 && r.body.code === 'ai.disabled');
  await http('PUT', '/api/settings/ai', T, { enabled: true });
  sch = await schedulePersonaDrafts(localAt(23));
  const mine = [pA.id, pP.id, pQ.id];
  let sTasks = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, DRAFT_TASK), inArray(schema.tasks.refId, mine), like(schema.tasks.idempotencyKey, `${DRAFT_TASK}:%:____-__-__`)));
  check('schedule: one task per switched-on persona (pA, pP), pQ skipped (owner disabled)',
    sTasks.length === 2 && sTasks.some((x) => x.refId === pA.id && (x.payload as any).count === 2) && sTasks.some((x) => x.refId === pP.id && x.createdBy === B.id)
    && sch.skipped.some((x) => x.personaId === pQ.id && x.code === 'persona.draft_owner_invalid'), JSON.stringify(sch));
  const again = await schedulePersonaDrafts(localAt(23));
  const sTasks2 = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, DRAFT_TASK), inArray(schema.tasks.refId, mine), like(schema.tasks.idempotencyKey, `${DRAFT_TASK}:%:____-__-__`)));
  check('schedule again the same day: nothing new (idempotent)', sTasks2.length === 2 && again.created === 0 && again.existing >= 2, JSON.stringify(again));
  const done = await Promise.all(sTasks.map((x) => waitTask(x.id)));
  check('scheduled runs reach the real API and fail ai.key_invalid once each', done.every((x) => x.status === 'failed' && x.errorCode === 'ai.key_invalid' && x.attempts === 1),
    done.map((x) => `${x.status}/${x.errorCode}/${x.attempts}`).join(' '));
  {
    const sA = sTasks.find((x) => x.refId === pA.id)!;
    const sP = sTasks.find((x) => x.refId === pP.id)!;
    const ra = (await runsOf(A.token, pA.id)).runs?.[0];
    const rp = (await runsOf(T, pP.id)).runs?.[0];
    const rq = (await runsOf(T, pQ.id)).runs ?? [];
    check('form after the schedule: newest run first (pA scheduled, not the older manual one), public pP for admin, pQ (skipped) none, users still none',
      ra?.id === sA.id && ra.trigger === 'schedule' && ra.status === 'failed' && rp?.id === sP.id && rp.trigger === 'schedule' && rq.length === 0
      && (await runsOf(A.token, pP.id)).runs === undefined, JSON.stringify({ ra, rp, rq }));
  }

  // ================================================================ writing drafts from a hand-made structured result (no model)
  const acc = async (token: string, handle: string, personaId: string | null) =>
    (await http('POST', '/api/social/accounts', token, { platform: 'instagram', handle: `${handle}_${tag}`, personaId })).body.account;
  const igA = await acc(A.token, 'pd_ig_a', pA.id);
  const igAen = (await http('POST', '/api/social/accounts', A.token, { platform: 'instagram', handle: `pd_ig_en_${tag}`, personaId: pA.id, lang: 'en' })).body.account;
  const igA2 = await acc(A.token, 'pd_ig_other', null);
  const igB = await acc(B.token, 'pd_ig_b', pP.id);
  const [ytA] = await db.insert(schema.socialAccounts).values({ userId: A.id, platform: 'youtube', handle: `pd_yt_${tag}`, personaId: pA.id }).returning();
  check('accounts: A instagram (persona), A instagram (persona, English), A instagram (none), A youtube (persona, platform disabled), B instagram (public persona)', !!igA?.id && !!igAen?.id && !!igA2?.id && !!igB?.id && !!ytA);
  // A public ready image tagged "Beach" (seeded directly: the upload pipeline is covered by media-check)
  const [img] = await db.insert(schema.mediaAssets).values({
    ownerType: 'public', ownerId: null, name: `beach ${tag}`, fileName: 'beach.jpg', storage: 'local', fileKey: `public/images/${randomUUID()}.jpg`,
    fileType: 'image', mimeType: 'image/jpeg', fileSize: 1000, width: 100, height: 100, checksum: tag, status: 'ready',
  }).returning();
  mediaIds.push(img!.id);
  await db.insert(schema.mediaTags).values({ name: `Beach${tag}` }).onConflictDoNothing();
  const [mt2] = await db.select().from(schema.mediaTags).where(eq(schema.mediaTags.name, `Beach${tag}`));
  await db.insert(schema.mediaAssetTags).values({ assetId: img!.id, tagId: mt2!.id });
  const [personaA] = await db.select().from(schema.personas).where(eq(schema.personas.id, pA.id));
  const saved = await saveDrafts({
    persona: personaA!, ownerId: A.id, model: 'handmade-test-result', requestedModel: 'claude-opus-5-5', taskId: null,
    drafts: [
      { title: 'Weeknight pasta', body: 'Five ingredients, one pan.', hashtags: ['#pasta', 'pasta', 'home cooking', 'dinner'], mediaTags: [`beach${tag}`, 'food'] },
      { title: 'Bad one', body: 'This has a ForbiddenWord inside.', hashtags: ['x'], mediaTags: [] },
      { title: 'Soup season', body: '今晚吃什么？\nWhich soup do you make first when it gets cold?', hashtags: [], mediaTags: ['soup'] },
    ],
  });
  check('saveDrafts: 2 written, the banned-word draft dropped, 2 targets, youtube account skipped (platform disabled), needs en',
    saved.contentIds.length === 2 && saved.dropped.length === 1 && saved.targets === 2 && saved.skippedAccounts === 1 && saved.needsTranslation.join() === 'en', JSON.stringify(saved));
  r = await http('GET', `/api/contents?tag=${DRAFT_TAG}`, A.token);
  const items = (r.body.items as any[]).filter((x) => saved.contentIds.includes(x.id));
  const pasta = items.find((x) => x.title === 'Weeknight pasta');
  check('drafts listed for the owner via the ai-draft tag filter: stage draft, lang zh-CN, tag, origin, needsTranslation [en]',
    items.length === 2 && items.every((x) => x.stage === 'draft' && x.status === 'draft' && x.lang === 'zh-CN' && x.tags.includes(DRAFT_TAG) && x.aiGenerated?.personaId === pA.id
      && x.aiGenerated?.model === 'handmade-test-result' && x.aiGenerated?.needsTranslation?.join() === 'en'));
  check('targets = only the owner\'s instagram accounts with the persona', items.every((x) => x.targets.map((t: any) => t.id).sort().join() === [igA.id, igAen.id].sort().join()));
  check('fixed opening/closing added once (not repeated when already there), hashtags appended once each (# stripped, spaces removed)',
    pasta?.body === '今晚吃什么？\nFive ingredients, one pan.\n你们最爱哪道？\n\n#pasta #homecooking #dinner'
      && items.find((x) => x.title === 'Soup season')?.body === '今晚吃什么？\nWhich soup do you make first when it gets cold?\n你们最爱哪道？', JSON.stringify(items.map((x) => x.body)));
  check('suggested media: the tagged ready image, only on the matching draft', pasta?.media.length === 1 && pasta.media[0].id === img!.id && items.find((x) => x.title === 'Soup season')?.media.length === 0);
  r = await http('GET', `/api/contents/${pasta.id}`, B.token);
  check('another user cannot see the drafts (404)', r.status === 404);
  const [personaP] = await db.select().from(schema.personas).where(eq(schema.personas.id, pP.id));
  const savedB = await saveDrafts({ persona: personaP!, ownerId: B.id, model: 'handmade-test-result', requestedModel: 'claude-opus-5-5', taskId: null,
    drafts: [{ title: '标题', body: '正文', hashtags: ['标签'], mediaTags: [] }] });
  const [bRow] = await db.select().from(schema.contents).where(eq(schema.contents.id, savedB.contentIds[0]!));
  const bTargets = await db.select().from(schema.contentTargets).where(eq(schema.contentTargets.contentId, bRow!.id));
  check('public persona: draft owned by the draft owner, zh-CN, targets the owner\'s account, no translation needed', bRow?.userId === B.id && bRow.lang === 'zh-CN' && bTargets.length === 1 && bTargets[0]!.accountId === igB.id
    && savedB.needsTranslation.length === 0 && !bRow.aiGenerated?.needsTranslation);

  // ================================================================ audit
  await sleep(500);
  const audits = await db.select().from(schema.auditLogs).where(gte(schema.auditLogs.at, t0));
  const ai = audits.filter((a) => a.action === 'settings.ai');
  const ps = audits.filter((a) => a.action === 'persona.update' || a.action === 'persona.create');
  check('audit: settings.ai records the workspace ID (not secret)', ai.some((a) => (a.detail as any)?.workspaceId === 'wrkspc_01TestWorkspace0001'));
  check('audit: settings.ai entries without the key (set flag only)', ai.length >= 3 && !JSON.stringify(audits).includes(INVALID_KEY) && ai.some((a) => (a.detail as any)?.set === true));
  check('audit: persona create/update with field names only (no style texts)', ps.length >= 5 && ps.every((a) => !JSON.stringify(a.detail).includes('forbiddenword') && !JSON.stringify(a.detail).includes('上班族'))
    && ps.some((a) => ((a.detail as any)?.fields ?? []).includes('style')) && ps.some((a) => (a.detail as any)?.draftEnabled === true));
  check('audit: persona.draft_generate recorded', audits.some((a) => a.action === 'persona.draft_generate'));

  // ================================================================ optional: one real generation
  const realKey = process.env.ANTHROPIC_TEST_API_KEY;
  if (realKey) {
    const realWs = process.env.ANTHROPIC_TEST_WORKSPACE_ID || null;
    const redis = new Redis(config.REDIS_URL);
    await http('PUT', '/api/settings/ai', T, { apiKey: realKey, workspaceId: null });
    await db.update(schema.personas).set({ style: personaA!.style }).where(eq(schema.personas.id, pP.id));
    const generate = async () => {
      await redis.del(`ai:drafts:manual:${pP.id}`);
      const g = await http('POST', `/api/personas/${pP.id}/drafts/generate`, T);
      return waitTask(g.body.task.id, 240_000);
    };
    let rt = await generate();
    if (rt.status === 'failed' && rt.errorCode === 'ai.workspace_required') {
      check('REAL call, key not scoped to a workspace, no workspace ID: failed ai.workspace_required after 1 attempt, no content',
        rt.attempts === 1 && !(rt.result as any)?.contentIds, `${rt.error}`);
      if (realWs) {
        await http('PUT', '/api/settings/ai', T, { workspaceId: realWs });
        rt = await generate();
      } else {
        console.log('- ANTHROPIC_TEST_WORKSPACE_ID not set: the key needs a workspace ID, no real generation');
      }
    }
    if (rt.errorCode !== 'ai.workspace_required') {
      const res = rt.result as any;
      const rows = res?.contentIds ? await db.select().from(schema.contents).where(inArray(schema.contents.id, res.contentIds)) : [];
      check('REAL generation with ANTHROPIC_TEST_API_KEY: success, 1 draft for the draft owner with origin', rt.status === 'success' && rows.length === 1 && rows[0]!.userId === B.id && !!rows[0]!.aiGenerated?.model,
        `${rt.status} ${rt.errorCode ?? ''} ${rt.status === 'failed' ? rt.error : ''} served=${res?.servedModel} fallback=${res?.fallback} usage=${JSON.stringify(res?.usage)}`);
      if (rows[0]) console.log(`  draft: ${JSON.stringify(rows[0].title)} — ${JSON.stringify(rows[0].body.slice(0, 160))}`);
    }
    const rlogs = JSON.stringify(await db.select().from(schema.taskLogs).where(eq(schema.taskLogs.taskId, rt.id)));
    check('REAL generation: logs carry no key', !rlogs.includes(realKey));
    redis.disconnect();
  } else {
    console.log('- ANTHROPIC_TEST_API_KEY not set: no real generation (only the invalid-key call reached the model API)');
  }
} finally {
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T).catch(() => undefined);
  if (publicPersonaIds.length) await db.delete(schema.personas).where(inArray(schema.personas.id, publicPersonaIds));
  if (sharedTemplateIds.length) await db.delete(schema.commentTemplates).where(inArray(schema.commentTemplates.id, sharedTemplateIds));
  if (mediaIds.length) await db.delete(schema.mediaAssets).where(inArray(schema.mediaAssets.id, mediaIds));
  if (settingsBefore) await db.update(schema.settings).set({ value: settingsBefore }).where(eq(schema.settings.key, 'ai'));
  else await db.delete(schema.settings).where(eq(schema.settings.key, 'ai'));
  await closeTaskQueues();
  await sqlClient.end();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
