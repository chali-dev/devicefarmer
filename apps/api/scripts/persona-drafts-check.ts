/**
 * AI 草稿 against the real API, DB, Redis and the real Anthropic API. No mocks.
 * - Personas no longer carry daily AI settings (owner decision 2026-11-18): draftEnabled/draftsPerDay/draftOwnerId in
 *   POST/PATCH are ignored (LEGACY columns untouched), not returned; a persona with the legacy column set creates nothing.
 * - The prompt (buildUserMessage + loadExamples, no model call): 定位, the 发文风格 (tone preset + note, emoji, post
 *   length range, hashtags, audience, fixed opening/closing, notes; nothing of the 评论风格), shared topics + banned
 *   words, Language zh-CN, the persona's oldest 5 post examples (in its own scope; not comment examples, not other
 *   users' templates).
 * - AI settings (admin): key write-only (never echoed, sealed in the DB, not in audit), model/hour/workspace validation;
 *   mapApiError turns the documented workspace errors into ai.workspace_required/_invalid/_not_found.
 * - 社交号 → AI 草稿 (GET/PUT /api/social/accounts/:id/ai-drafts): owner/admin, others 404; per day 1..10; switching on
 *   needs a persona (ai.account_no_persona) and an enabled platform; list items carry aiDraftsEnabled/aiDraftsPerDay; audit.
 * - AI测试 preview (POST /api/personas/:id/drafts/preview): RBAC (other user 404, public persona as user 403), no key →
 *   400 ai.not_configured, switched off → 400 ai.disabled, a REAL call with an invalid key → 502 ai.key_invalid with no
 *   token and no content, rate limit PREVIEW_LIMIT per persona per 10 min (429 ai.rate_limited {seconds, limit}), audit
 *   persona.draft_preview with requested model / ok / error code and no texts.
 * - Saving a preview (POST …/drafts/save {token}): tokens are written into Redis BY THIS SCRIPT with storePreview (a
 *   hand-made draft, NOT model output): another user's token (admin) / other persona → 400 ai.preview_invalid and the
 *   token stays usable; save → 201 one draft of the current user by the saveDrafts rules (fixed lines, hashtags, tag,
 *   via preview, targets = the user's accounts with the persona on enabled platforms, needsTranslation); reuse / expired /
 *   unknown → 400 ai.preview_expired; banned word → 400 ai.preview_banned, nothing written; audit without texts/token.
 * - Daily schedule per social account (`account-drafts`): not before the hour, nothing when switched off or without a
 *   key; one task per switched-on account with a persona per local day (count = its per day, owner = account owner),
 *   idempotent; skips disabled owners (ai.owner_disabled) and disabled platforms; switched-off accounts get none; the
 *   runs reach the real API with the invalid key and fail ai.key_invalid after 1 attempt (no key in payload/logs); the
 *   account's last run in GET …/ai-drafts; a task of a switched-off account ends skipped; a legacy `persona-drafts` task
 *   ends skipped (ai.moved_to_accounts).
 * - saveDrafts from a HAND-MADE structured result (no model): per account (target = that account) and for a persona's
 *   accounts (disabled platform skipped, needsTranslation), banned-word drafts dropped, suggested media, visibility.
 * - With ANTHROPIC_TEST_API_KEY (+ ANTHROPIC_TEST_WORKSPACE_ID): one REAL preview and its save.
 * Usage (from apps/api, API running with default ENABLED_PLATFORMS=instagram; never against an API you don't own):
 *   E2E_API=http://127.0.0.1:3000 npx tsx --env-file=../../.env scripts/persona-drafts-check.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gte, inArray } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';
import { Redis } from 'ioredis';
import { config } from '../src/config.js';
import { db, schema, sqlClient } from '../src/db/index.js';
import {
  ACCOUNT_DRAFT_TASK, buildUserMessage, closePreviewStore, DRAFT_TAG, DRAFT_TASK, loadExamples, mapApiError, personaAccounts, PREVIEW_LIMIT,
  saveDrafts, scheduleAccountDrafts, storePreview, SYSTEM_PROMPT,
} from '../src/modules/ai/drafts.js';
import { closeTaskQueues, createTask } from '../src/modules/tasks/core.js';
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
const localAt = (h: number, plusDays = 0) => { const d = new Date(); d.setDate(d.getDate() + plusDays); d.setHours(h, 30, 0, 0); return d; };
const redis = new Redis(config.REDIS_URL);
const contentCount = async () => Number((await sqlClient`select count(*)::int n from contents`)[0]!.n);
const resetPreviewLimit = (personaId: string) => redis.del(`ai:preview:count:${personaId}`);

try {
  const mk = async (name: string) => {
    const r = await http('POST', '/api/users', T, { username: name, password: pw, role: 'user' });
    const id = r.body.user?.id ?? r.body.id; userIds.push(id);
    return { id, token: await login(name, pw) };
  };
  const A = await mk(`pda${tag}`);
  const B = await mk(`pdb${tag}`);
  const C = await mk(`pdc${tag}`);

  // ================================================================ personas: no daily AI settings any more
  const STYLE = {
    topics: ['家常菜', 'weeknight dinners'], bannedWords: ['forbiddenword', '最便宜'],
    post: { tone: 'warm', toneNote: '像邻家厨师一样温柔', emoji: 'low', length: 'high', hashtags: ['#homecooking', 'dinner'], audience: '上班族', opening: '今晚吃什么？', closing: '你们最爱哪道？', notes: '不要推荐品牌' },
    comment: { tone: 'funny', toneNote: '评论区抖机灵', emoji: 'high', length: 'low' },
  };
  const pA = (await http('POST', '/api/personas', A.token, { scope: 'mine', name: `Chef ${tag}`, description: '下班后 20 分钟的家常菜', style: STYLE, draftEnabled: true, draftsPerDay: 9 })).body.persona;
  const pA2 = (await http('POST', '/api/personas', A.token, { scope: 'mine', name: `Other ${tag}` })).body.persona;
  const pP = (await http('POST', '/api/personas', T, { scope: 'public', name: `Brand ${tag}` })).body.persona;
  publicPersonaIds.push(pP.id);
  let r = await http('PATCH', `/api/personas/${pP.id}`, T, { description: '品牌', draftEnabled: true, draftOwnerId: B.id, draftsPerDay: 2 });
  const [rowA] = await db.select().from(schema.personas).where(eq(schema.personas.id, pA.id));
  const [rowP] = await db.select().from(schema.personas).where(eq(schema.personas.id, pP.id));
  const g = await http('GET', `/api/personas/${pA.id}`, A.token);
  check('personas: legacy draftEnabled/draftsPerDay/draftOwnerId ignored on POST/PATCH (columns untouched), not in responses',
    !!pA?.id && r.status === 200 && rowA!.draftEnabled === false && rowA!.draftsPerDay === 4 && rowP!.draftEnabled === false && rowP!.draftOwnerId === null
      && !('draftEnabled' in pA) && !('draftEnabled' in g.body.persona) && !('runs' in g.body.persona), `${r.status} ${JSON.stringify(g.body?.persona).slice(0, 200)}`);
  // a persona still switched on in the LEGACY column (as an older release could leave it): must not generate anything
  await db.update(schema.personas).set({ draftEnabled: true, draftsPerDay: 3 }).where(eq(schema.personas.id, pA.id));
  r = await http('POST', `/api/personas/${pA.id}/drafts/generate`, A.token);
  check('old "generate now" endpoint is gone (404)', r.status === 404, `${r.status}`);

  const tpl = async (token: string, body: Record<string, unknown>) => (await http('POST', '/api/comment-templates', token, { text: 'Example caption text', ...body })).body.template;
  const sharedPost = await tpl(T, { kind: 'post', name: `shared ${tag}`, shared: true, personaId: pP.id, text: 'Shared brand example' }); sharedTemplateIds.push(sharedPost.id);
  for (let k = 1; k <= 6; k++) await tpl(A.token, { kind: 'post', name: `a-post${k} ${tag}`, personaId: pA.id, text: `示例发文 ${k} ${tag}` });
  await tpl(A.token, { kind: 'comment', name: `a-reply ${tag}`, personaId: pA.id, text: `回复范例 ${tag}` });
  await tpl(A.token, { kind: 'post', name: `a-pub ${tag}`, personaId: pP.id, text: `A 的私有发文用公共人设 ${tag}` });

  // ================================================================ prompt construction (no model call)
  {
    const [row] = await db.select().from(schema.personas).where(eq(schema.personas.id, pA.id));
    const ex = await loadExamples(row!);
    const msg = buildUserMessage({ persona: row!, count: 3, day: '2026-11-18', examples: ex, recent: [{ title: '上周的汤', body: '番茄蛋汤做法' }] });
    const has = (x: string) => msg.includes(x);
    check('prompt: examples = the oldest 5 post examples of the persona (no comment example)',
      ex.length === 5 && ex.every((e, k) => e.text === `示例发文 ${k + 1} ${tag}`) && !has(`回复范例 ${tag}`) && !has(`示例发文 6 ${tag}`), ex.map((e) => e.text).join(' | '));
    check('prompt: 定位 + the 发文风格 (tone preset + note, emoji, post length range high = 500–1500), Language zh-CN',
      has('Positioning: 下班后 20 分钟的家常菜') && has('Tone: warm — 像邻家厨师一样温柔') && has('Emoji: at most 1 emoji') && has('Length: 500 to 1500 characters') && has('Language: zh-CN'), msg.slice(0, 600));
    check('prompt: nothing of the 评论风格', !has('funny') && !has('评论区抖机灵') && !has('plenty of emoji') && !has('4 to 30'));
    check('prompt: topics, banned words, hashtags (# stripped), audience, fixed opening/closing, notes, recent posts',
      has('- 家常菜') && has('- weeknight dinners') && has('- forbiddenword') && has('- 最便宜') && has('- homecooking') && has('Audience: 上班族')
        && has('Fixed opening line (added by the system): 今晚吃什么？') && has('Fixed closing line (added by the system): 你们最爱哪道？') && has('Notes: 不要推荐品牌') && has('上周的汤'));
    check('system prompt: Chinese only, draft-only role', SYSTEM_PROMPT.includes('Write in Simplified Chinese (zh-CN)') && SYSTEM_PROMPT.includes('DRAFT'));
    const [pubRow] = await db.select().from(schema.personas).where(eq(schema.personas.id, pP.id));
    const exP = await loadExamples(pubRow!);
    check('prompt (public persona): only shared examples (not A\'s private one)', exP.length === 1 && exP[0]!.text === 'Shared brand example');
  }

  // ================================================================ AI settings (admin, key write-only)
  r = await http('GET', '/api/settings/ai', A.token);
  check('users cannot read the AI settings (403)', r.status === 403);
  await http('PUT', '/api/settings/ai', T, { apiKey: null, enabled: true, model: 'claude-opus-5-5', hour: 6, workspaceId: null });
  r = await http('GET', '/api/settings/ai', T);
  check('defaults: no key, model claude-opus-5-5, hour 6, on', r.status === 200 && r.body.ai.keySet === false && r.body.ai.model === 'claude-opus-5-5' && r.body.ai.hour === 6 && r.body.ai.enabled === true);
  const r7 = await http('PUT', '/api/settings/ai', T, { hour: 24 });
  const r8 = await http('PUT', '/api/settings/ai', T, { apiKey: 'short' });
  const r9 = await http('PUT', '/api/settings/ai', A.token, { enabled: false });
  const rm = await http('PUT', '/api/settings/ai', T, { model: 'gpt-x' });
  check('invalid model / hour / key format → 400; users 403', rm.status === 400 && r7.status === 400 && r8.status === 400 && r9.status === 403);
  {
    const bad = await http('PUT', '/api/settings/ai', T, { workspaceId: 'ws-123' });
    const okWs = await http('PUT', '/api/settings/ai', T, { workspaceId: 'wrkspc_01TestWorkspace0001' });
    const cleared = await http('PUT', '/api/settings/ai', T, { workspaceId: '' });
    check('workspace ID: wrong format 400, set, cleared', bad.status === 400 && okWs.body.ai.workspaceId === 'wrkspc_01TestWorkspace0001' && cleared.body.ai.workspaceId === null);
    const mkErr = (status: number, type: string, message: string) => Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, undefined, new Headers());
    const codes = [
      mkErr(400, 'invalid_request_error', 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.'),
      mkErr(400, 'invalid_request_error', 'anthropic-workspace-id header must be a valid workspace ID.'),
      mkErr(404, 'not_found_error', 'Workspace `wrkspc_01X` not found.'),
      mkErr(400, 'invalid_request_error', 'max_tokens: Field required'),
    ].map((e) => (mapApiError(e) as Error & { code?: string }).code);
    check('mapApiError: workspace errors → ai.workspace_required / _invalid / _not_found, other 400 → ai.request_failed',
      codes.join() === 'ai.workspace_required,ai.workspace_invalid,ai.workspace_not_found,ai.request_failed', codes.join());
  }

  // ================================================================ accounts + 社交号 → AI 草稿
  const acc = async (token: string, handle: string, personaId: string | null, lang?: string) =>
    (await http('POST', '/api/social/accounts', token, { platform: 'instagram', handle: `${handle}_${tag}`, personaId, ...(lang ? { lang } : {}) })).body.account;
  const igA = await acc(A.token, 'pd_ig_a', pA.id);
  const igAen = await acc(A.token, 'pd_ig_en', pA.id, 'en');
  const igA2 = await acc(A.token, 'pd_ig_none', null);
  const igB = await acc(B.token, 'pd_ig_b', pP.id);
  const igC = await acc(C.token, 'pd_ig_c', pP.id);
  const [ytA] = await db.insert(schema.socialAccounts).values({ userId: A.id, platform: 'youtube', handle: `pd_yt_${tag}`, personaId: pA.id }).returning();
  check('accounts: A ig (pA), A ig (pA, en), A ig (no persona), B ig (public), C ig (public), A youtube (platform disabled)',
    [igA, igAen, igA2, igB, igC].every((x) => !!x?.id) && !!ytA);
  r = await http('GET', `/api/social/accounts/${igA.id}/ai-drafts`, A.token);
  check('GET ai-drafts: off, 4 per day, persona pA, no runs', r.status === 200 && r.body.enabled === false && r.body.perDay === 4 && r.body.personaId === pA.id && r.body.runs.length === 0 && r.body.ai.keySet === false,
    JSON.stringify(r.body));
  const rb = await http('GET', `/api/social/accounts/${igA.id}/ai-drafts`, B.token);
  const rbp = await http('PUT', `/api/social/accounts/${igA.id}/ai-drafts`, B.token, { enabled: true });
  check('another user: 404 social.not_found (read and write)', rb.status === 404 && rb.body.code === 'social.not_found' && rbp.status === 404);
  r = await http('PUT', `/api/social/accounts/${igA2.id}/ai-drafts`, A.token, { enabled: true });
  check('account without persona → 400 ai.account_no_persona', r.status === 400 && r.body.code === 'ai.account_no_persona', `${r.status} ${r.body?.code}`);
  r = await http('PUT', `/api/social/accounts/${ytA!.id}/ai-drafts`, A.token, { enabled: true });
  check('account on a disabled platform → 400 platform.disabled', r.status === 400 && r.body.code === 'platform.disabled', `${r.status} ${r.body?.code}`);
  const r0 = await http('PUT', `/api/social/accounts/${igA.id}/ai-drafts`, A.token, { perDay: 0 });
  const r11 = await http('PUT', `/api/social/accounts/${igA.id}/ai-drafts`, A.token, { perDay: 11 });
  check('per day outside 1..10 → 400', r0.status === 400 && r11.status === 400);
  r = await http('PUT', `/api/social/accounts/${igA.id}/ai-drafts`, A.token, { enabled: true, perDay: 2 });
  const rT = await http('PUT', `/api/social/accounts/${igB.id}/ai-drafts`, T, { enabled: true, perDay: 3 });
  const rC = await http('PUT', `/api/social/accounts/${igC.id}/ai-drafts`, C.token, { enabled: true });
  check('owner switches on (2/day), admin switches on B\'s account (3/day), C on (4/day)', r.status === 200 && r.body.enabled && r.body.perDay === 2 && rT.status === 200 && rT.body.perDay === 3 && rC.status === 200,
    `${r.status} ${rT.status} ${rC.status}`);
  const listA = (await http('GET', '/api/social/accounts', A.token)).body.items as any[];
  check('account list carries aiDraftsEnabled / aiDraftsPerDay', listA.find((x) => x.id === igA.id)?.aiDraftsEnabled === true && listA.find((x) => x.id === igA.id)?.aiDraftsPerDay === 2
    && listA.find((x) => x.id === igA2.id)?.aiDraftsEnabled === false);
  await db.update(schema.socialAccounts).set({ aiDraftsEnabled: true }).where(eq(schema.socialAccounts.id, ytA!.id)); // e.g. switched on before the platform was disabled
  await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, C.id));

  // ================================================================ no key
  r = await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token);
  check('preview without a key → 400 ai.not_configured', r.status === 400 && r.body.code === 'ai.not_configured', `${r.status} ${r.body?.code}`);
  let sch = await scheduleAccountDrafts(localAt(23));
  check('schedule without a key: nothing, reason ai.not_configured', sch.reason === 'ai.not_configured' && sch.created === 0, JSON.stringify(sch));

  // ================================================================ AI测试 preview with an invalid key (real calls)
  r = await http('PUT', '/api/settings/ai', T, { apiKey: INVALID_KEY });
  const gs = await http('GET', '/api/settings/ai', T);
  const stored = JSON.stringify((await db.select().from(schema.settings).where(eq(schema.settings.key, 'ai')))[0]?.value ?? {});
  check('key saved write-only: keySet, never echoed, sealed in the DB', r.body.ai.keySet === true && !r.text.includes(INVALID_KEY) && !gs.text.includes(INVALID_KEY) && !stored.includes(INVALID_KEY) && stored.includes('"apiKeyEnc":"v1:'));
  r = await http('POST', `/api/personas/${pA.id}/drafts/preview`, B.token);
  const rPub = await http('POST', `/api/personas/${pP.id}/drafts/preview`, A.token);
  check('preview: other user 404, public persona as user 403', r.status === 404 && rPub.status === 403, `${r.status} ${rPub.status}`);
  const before = await contentCount();
  const tStart = Date.now();
  r = await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token);
  const ms = Date.now() - tStart;
  check('REAL Anthropic call with an invalid key: preview → 502 ai.key_invalid, no token, synchronous', r.status === 502 && r.body.code === 'ai.key_invalid' && !r.body.token && !r.text.includes(INVALID_KEY),
    `${r.status} ${r.body?.code} ${ms} ms`);
  const statuses: number[] = [];
  for (let k = 2; k <= PREVIEW_LIMIT; k++) statuses.push((await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token)).status);
  r = await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token);
  check(`rate limit: previews 2..${PREVIEW_LIMIT} still reach the API (502), #${PREVIEW_LIMIT + 1} → 429 ai.rate_limited {seconds, limit}`,
    statuses.every((s) => s === 502) && r.status === 429 && r.body.code === 'ai.rate_limited' && Number(r.body.params?.seconds) > 500 && r.body.params?.limit === PREVIEW_LIMIT,
    `${statuses.join()} ${r.status} ${JSON.stringify(r.body)}`);
  const rOther = await http('POST', `/api/personas/${pA2.id}/drafts/preview`, A.token);
  check('rate limit is per persona (another persona still reaches the API)', rOther.status === 502 && rOther.body.code === 'ai.key_invalid', `${rOther.status}`);
  check('no content created by any preview', await contentCount() === before);
  await http('PUT', '/api/settings/ai', T, { enabled: false });
  r = await http('POST', `/api/personas/${pP.id}/drafts/preview`, T);
  check('preview while AI is switched off → 400 ai.disabled', r.status === 400 && r.body.code === 'ai.disabled');
  sch = await scheduleAccountDrafts(localAt(23));
  check('schedule while switched off: reason ai.disabled', sch.reason === 'ai.disabled' && sch.created === 0);
  await http('PUT', '/api/settings/ai', T, { enabled: true });

  // ================================================================ save a preview (tokens written here, NOT model output)
  const hand = { title: 'Weeknight pasta', body: 'Five ingredients, one pan.', hashtags: ['#pasta', 'pasta', 'home cooking'], mediaTags: ['food'] };
  const rec = (userId: string, personaId: string, draft = hand) => ({ userId, personaId, draft, model: 'handmade-test-result', requestedModel: 'claude-opus-5-5', fallback: false, generatedAt: new Date().toISOString() });
  {
    const { token } = await storePreview(rec(A.id, pA.id));
    const asB = await http('POST', `/api/personas/${pA.id}/drafts/save`, B.token, { token });
    const asAdmin = await http('POST', `/api/personas/${pA.id}/drafts/save`, T, { token });
    const otherPersona = await http('POST', `/api/personas/${pA2.id}/drafts/save`, A.token, { token });
    check('save: other user 404; admin with A\'s token → 400 ai.preview_invalid; A on another persona → 400 ai.preview_invalid',
      asB.status === 404 && asAdmin.status === 400 && asAdmin.body.code === 'ai.preview_invalid' && otherPersona.status === 400 && otherPersona.body.code === 'ai.preview_invalid',
      `${asB.status} ${asAdmin.status}/${asAdmin.body?.code} ${otherPersona.status}/${otherPersona.body?.code}`);
    const ok = await http('POST', `/api/personas/${pA.id}/drafts/save`, A.token, { token });
    check('save with own token → 201 (the refused attempts did not use it up)', ok.status === 201 && !!ok.body.contentId && ok.body.targets === 2 && ok.body.needsTranslation.join() === 'en', `${ok.status} ${ok.text.slice(0, 200)}`);
    const again = await http('POST', `/api/personas/${pA.id}/drafts/save`, A.token, { token });
    const unknown = await http('POST', `/api/personas/${pA.id}/drafts/save`, A.token, { token: randomBytes(24).toString('base64url') });
    const short = await storePreview(rec(A.id, pA.id), 1);
    await sleep(1500);
    const expired = await http('POST', `/api/personas/${pA.id}/drafts/save`, A.token, { token: short.token });
    check('reuse / unknown / expired (TTL) token → 400 ai.preview_expired',
      [again, unknown, expired].every((x) => x.status === 400 && x.body.code === 'ai.preview_expired'), [again, unknown, expired].map((x) => `${x.status}/${x.body?.code}`).join(' '));
    const c = (await http('GET', `/api/contents/${ok.body.contentId}`, A.token)).body;
    const item = c.content ?? c;
    check('saved draft = saveDrafts rules: owner A, zh-CN, stage draft, tag ai-draft, fixed lines + hashtags once, via preview, no task',
      item.userId === A.id && item.lang === 'zh-CN' && item.stage === 'draft' && item.tags?.includes(DRAFT_TAG)
        && item.body === '今晚吃什么？\nFive ingredients, one pan.\n你们最爱哪道？\n\n#pasta #homecooking' && item.aiGenerated?.via === 'preview' && item.aiGenerated?.taskId === null
        && item.aiGenerated?.model === 'handmade-test-result' && item.aiGenerated?.needsTranslation?.join() === 'en', JSON.stringify(item).slice(0, 400));
    check('saved draft targets = A\'s instagram accounts with the persona (youtube skipped, no-persona account not)',
      (item.targets ?? []).map((x: any) => x.id).sort().join() === [igA.id, igAen.id].sort().join(), JSON.stringify(item.targets));
    const bt = await storePreview(rec(A.id, pA.id, { ...hand, body: 'This has a ForbiddenWord inside.' }));
    const n0 = await contentCount();
    const banned = await http('POST', `/api/personas/${pA.id}/drafts/save`, A.token, { token: bt.token });
    check('banned word in the stored preview → 400 ai.preview_banned {words}, nothing written', banned.status === 400 && banned.body.code === 'ai.preview_banned' && banned.body.params?.words === 'forbiddenword' && await contentCount() === n0,
      `${banned.status} ${JSON.stringify(banned.body)}`);
    const pt = await storePreview(rec((await db.select().from(schema.users).where(eq(schema.users.username, process.env.ADMIN_USERNAME!)))[0]!.id, pP.id, { ...hand, body: '公共人设预览' }));
    const pub = await http('POST', `/api/personas/${pP.id}/drafts/save`, T, { token: pt.token });
    check('admin saves a preview of a public persona → draft of the admin (no accounts with the persona → 0 targets)', pub.status === 201 && pub.body.targets === 0, `${pub.status} ${pub.text.slice(0, 160)}`);
  }

  // ================================================================ daily schedule per account (real calls, invalid key)
  sch = await scheduleAccountDrafts(localAt(3));
  check('before the configured hour (06:00): reason ai.not_due', sch.reason === 'ai.not_due' && sch.created === 0);
  sch = await scheduleAccountDrafts(localAt(23));
  const mineAcc = [igA.id, igAen.id, igA2.id, igB.id, igC.id, ytA!.id];
  const accTasks = async () => db.select().from(schema.tasks).where(and(eq(schema.tasks.type, ACCOUNT_DRAFT_TASK), inArray(schema.tasks.refId, mineAcc), gte(schema.tasks.createdAt, t0)));
  let sTasks = await accTasks();
  const legacy = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, DRAFT_TASK), gte(schema.tasks.createdAt, t0)));
  check('schedule: one task per switched-on account with a persona (igA 2/day owner A, igB 3/day owner B); igA2/igAen off; C disabled and youtube skipped',
    sTasks.length === 2 && sTasks.some((x) => x.refId === igA.id && (x.payload as any).count === 2 && x.createdBy === A.id) && sTasks.some((x) => x.refId === igB.id && (x.payload as any).count === 3 && x.createdBy === B.id)
      && sch.skipped.some((x) => x.accountId === igC.id && x.code === 'ai.owner_disabled') && sch.skipped.some((x) => x.accountId === ytA!.id && x.code === 'platform.disabled'),
    JSON.stringify(sch));
  check('the legacy persona switch (pA.draft_enabled = true in the DB) creates no persona-drafts task', legacy.length === 0);
  check('idempotency key account-drafts:<accountId>:<local date>', sTasks.every((x) => new RegExp(`^${ACCOUNT_DRAFT_TASK}:${x.refId}:\\d{4}-\\d{2}-\\d{2}$`).test(x.idempotencyKey ?? '')), sTasks.map((x) => x.idempotencyKey).join());
  const again = await scheduleAccountDrafts(localAt(23));
  check('schedule again the same day: nothing new (idempotent)', (await accTasks()).length === 2 && again.created === 0 && again.existing === 2, JSON.stringify(again));
  const done = await Promise.all(sTasks.map((x) => waitTask(x.id)));
  const logs = JSON.stringify(await db.select().from(schema.taskLogs).where(inArray(schema.taskLogs.taskId, sTasks.map((x) => x.id))));
  check('daily runs reach the real API and fail ai.key_invalid once each (not retried)', done.every((x) => x.status === 'failed' && x.errorCode === 'ai.key_invalid' && x.attempts === 1),
    done.map((x) => `${x.status}/${x.errorCode}/${x.attempts}`).join(' '));
  check('task payload/logs never contain the key; the log names the count and model', !JSON.stringify(done.map((x) => x.payload)).includes(INVALID_KEY) && !logs.includes(INVALID_KEY) && !logs.includes('sk-ant')
    && logs.includes('drafts: requesting 2 from claude-opus-5-5') && logs.includes('drafts: requesting 3 from claude-opus-5-5'));
  r = await http('GET', `/api/social/accounts/${igA.id}/ai-drafts`, A.token);
  const rB = await http('GET', `/api/social/accounts/${igB.id}/ai-drafts`, T);
  check('GET ai-drafts: the account\'s last run (failed ai.key_invalid), admin sees B\'s', r.body.runs[0]?.id === sTasks.find((x) => x.refId === igA.id)!.id && r.body.runs[0].status === 'failed' && r.body.runs[0].errorCode === 'ai.key_invalid'
    && r.body.runs[0].created === null && rB.body.runs[0]?.id === sTasks.find((x) => x.refId === igB.id)!.id, JSON.stringify(r.body.runs));
  // switched off → no task the next day; a task of a switched-off account ends as a skipped no-op
  await http('PUT', `/api/social/accounts/${igB.id}/ai-drafts`, B.token, { enabled: false });
  const next = await scheduleAccountDrafts(localAt(23, 1));
  const nextTasks = (await accTasks()).filter((x) => !sTasks.some((y) => y.id === x.id));
  check('next day after B switched off: only igA gets a task', next.created === 1 && nextTasks.length === 1 && nextTasks[0]!.refId === igA.id, JSON.stringify(next));
  await waitTask(nextTasks[0]!.id);
  const off = await createTask({ type: ACCOUNT_DRAFT_TASK, userId: B.id, refType: 'social_account', refId: igB.id, payload: { accountId: igB.id, count: 1, day: '2026-11-18' }, idempotencyKey: `check-off:${tag}` });
  const offT = await waitTask(off.task.id);
  check('a queued task of a switched-off account ends success, skipped ai.account_drafts_off (no model call)', offT.status === 'success' && (offT.result as any)?.skipped === 'ai.account_drafts_off', `${offT.status} ${JSON.stringify(offT.result)}`);
  const lg = await createTask({ type: DRAFT_TASK, userId: A.id, refType: 'persona', refId: pA.id, payload: { personaId: pA.id, count: 1, day: '2026-11-18', trigger: 'schedule' }, idempotencyKey: `check-legacy:${tag}` });
  const lgT = await waitTask(lg.task.id);
  check('a legacy persona-drafts task (older release) ends skipped ai.moved_to_accounts', lgT.status === 'success' && (lgT.result as any)?.skipped === 'ai.moved_to_accounts', `${lgT.status} ${JSON.stringify(lgT.result)}`);

  // ================================================================ saveDrafts from a hand-made structured result (no model)
  await db.insert(schema.mediaTags).values({ name: `Beach${tag}` }).onConflictDoNothing();
  const [img] = await db.insert(schema.mediaAssets).values({
    ownerType: 'public', ownerId: null, name: `beach ${tag}`, fileName: 'beach.jpg', storage: 'local', fileKey: `public/images/${randomUUID()}.jpg`,
    fileType: 'image', mimeType: 'image/jpeg', fileSize: 1000, width: 100, height: 100, checksum: tag, status: 'ready',
  }).returning();
  mediaIds.push(img!.id);
  const [mt2] = await db.select().from(schema.mediaTags).where(eq(schema.mediaTags.name, `Beach${tag}`));
  await db.insert(schema.mediaAssetTags).values({ assetId: img!.id, tagId: mt2!.id });
  const [personaA] = await db.select().from(schema.personas).where(eq(schema.personas.id, pA.id));
  const saved = await saveDrafts({
    persona: personaA!, ownerId: A.id, accounts: await personaAccounts(A.id, pA.id), model: 'handmade-test-result', requestedModel: 'claude-opus-5-5', taskId: null,
    drafts: [
      { title: 'Weeknight pasta', body: 'Five ingredients, one pan.', hashtags: ['#pasta', 'pasta', 'home cooking', 'dinner'], mediaTags: [`beach${tag}`, 'food'] },
      { title: 'Bad one', body: 'This has a ForbiddenWord inside.', hashtags: ['x'], mediaTags: [] },
      { title: 'Soup season', body: '今晚吃什么？\nWhich soup do you make first when it gets cold?', hashtags: [], mediaTags: ['soup'] },
    ],
  });
  check('saveDrafts (persona accounts): 2 written, banned one dropped, 2 targets, youtube skipped, needs en',
    saved.contentIds.length === 2 && saved.dropped.length === 1 && saved.targets === 2 && saved.skippedAccounts === 1 && saved.needsTranslation.join() === 'en', JSON.stringify(saved));
  const items = ((await http('GET', `/api/contents?tag=${DRAFT_TAG}`, A.token)).body.items as any[]).filter((x) => saved.contentIds.includes(x.id));
  const pasta = items.find((x) => x.title === 'Weeknight pasta');
  check('fixed opening/closing added once, hashtags appended once each',
    pasta?.body === '今晚吃什么？\nFive ingredients, one pan.\n你们最爱哪道？\n\n#pasta #homecooking #dinner'
      && items.find((x) => x.title === 'Soup season')?.body === '今晚吃什么？\nWhich soup do you make first when it gets cold?\n你们最爱哪道？', JSON.stringify(items.map((x) => x.body)));
  check('suggested media: the tagged ready image, only on the matching draft', pasta?.media.length === 1 && pasta.media[0].id === img!.id && items.find((x) => x.title === 'Soup season')?.media.length === 0);
  r = await http('GET', `/api/contents/${pasta.id}`, B.token);
  check('another user cannot see the drafts (404)', r.status === 404);
  const [personaP] = await db.select().from(schema.personas).where(eq(schema.personas.id, pP.id));
  const [igBRow] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, igB.id));
  const savedB = await saveDrafts({ persona: personaP!, ownerId: B.id, accounts: [igBRow!], model: 'handmade-test-result', requestedModel: 'claude-opus-5-5', taskId: null, via: 'account', accountId: igB.id,
    drafts: [{ title: '标题', body: '正文', hashtags: ['标签'], mediaTags: [] }] });
  const [bRow] = await db.select().from(schema.contents).where(eq(schema.contents.id, savedB.contentIds[0]!));
  const bTargets = await db.select().from(schema.contentTargets).where(eq(schema.contentTargets.contentId, bRow!.id));
  check('per account: draft of the account owner, target = exactly that account, via account', bRow?.userId === B.id && bTargets.length === 1 && bTargets[0]!.accountId === igB.id
    && bRow.aiGenerated?.via === 'account' && bRow.aiGenerated?.accountId === igB.id && savedB.needsTranslation.length === 0);

  // ================================================================ audit
  await sleep(600);
  const audits = await db.select().from(schema.auditLogs).where(gte(schema.auditLogs.at, t0));
  const prev = audits.filter((a) => a.action === 'persona.draft_preview');
  const saves = audits.filter((a) => a.action === 'persona.draft_preview_save');
  const accA = audits.filter((a) => a.action === 'social.ai_drafts');
  const all = JSON.stringify(audits);
  check('audit persona.draft_preview: requested model, ok false, error code ai.key_invalid / ai.rate_limited / ai.not_configured',
    prev.some((a) => (a.detail as any)?.errorCode === 'ai.key_invalid' && (a.detail as any)?.requestedModel === 'claude-opus-5-5' && (a.detail as any)?.ok === false)
      && prev.some((a) => (a.detail as any)?.errorCode === 'ai.rate_limited') && prev.some((a) => (a.detail as any)?.errorCode === 'ai.not_configured'), JSON.stringify(prev.map((a) => a.detail)).slice(0, 400));
  check('audit persona.draft_preview_save: content id + model, failures with their code, no texts, no token',
    saves.some((a) => a.ok && !!(a.detail as any)?.contentId && (a.detail as any)?.model === 'handmade-test-result') && saves.some((a) => !a.ok)
      && !JSON.stringify(saves).includes('Five ingredients') && !JSON.stringify(saves).includes('"token"'), JSON.stringify(saves.map((a) => a.detail)).slice(0, 300));
  check('audit social.ai_drafts: enabled/perDay with the account name', accA.some((a) => (a.detail as any)?.enabled === true && (a.detail as any)?.perDay === 2 && (a.target ?? '').includes(`pd_ig_a_${tag}`)),
    JSON.stringify(accA.map((a) => [a.target, a.detail])).slice(0, 300));
  check('audit: the key never appears', !all.includes(INVALID_KEY));

  // ================================================================ optional: one real preview + save
  const realKey = process.env.ANTHROPIC_TEST_API_KEY;
  if (realKey) {
    await http('PUT', '/api/settings/ai', T, { apiKey: realKey, workspaceId: process.env.ANTHROPIC_TEST_WORKSPACE_ID || null });
    await resetPreviewLimit(pA.id);
    const n0 = await contentCount();
    const t1 = Date.now();
    const pv = await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token);
    const p = pv.body?.preview;
    check('REAL preview: 200 with title/text/model/usage, nothing stored', pv.status === 200 && !!p?.title && !!p?.text && !!p?.model && p.usage?.output > 0 && await contentCount() === n0,
      `${pv.status} ${pv.body?.code ?? ''} ${Date.now() - t1} ms model=${p?.model} fallback=${p?.fallback} usage=${JSON.stringify(p?.usage)} banned=${JSON.stringify(p?.banned)}`);
    if (p) console.log(`  preview: ${JSON.stringify(p.title)} — ${JSON.stringify(p.text.slice(0, 200))}`);
    if (pv.status === 200 && !p.banned.length) {
      const sv = await http('POST', `/api/personas/${pA.id}/drafts/save`, A.token, { token: pv.body.token });
      check('REAL preview saved → 201 one draft', sv.status === 201 && await contentCount() === n0 + 1, `${sv.status}`);
    }
    check('REAL preview: response carries no key', !pv.text.includes(realKey));
  } else {
    console.log('- ANTHROPIC_TEST_API_KEY not set: no real generation (only the invalid-key calls reached the model API)');
  }
} finally {
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T).catch(() => undefined);
  // the admin's saved preview draft of the public persona (test users' contents go with the users)
  await sqlClient`delete from contents where ai_generated->>'personaName' = ${`Brand ${tag}`}`;
  if (publicPersonaIds.length) await db.delete(schema.personas).where(inArray(schema.personas.id, publicPersonaIds));
  if (sharedTemplateIds.length) await db.delete(schema.commentTemplates).where(inArray(schema.commentTemplates.id, sharedTemplateIds));
  if (mediaIds.length) await db.delete(schema.mediaAssets).where(inArray(schema.mediaAssets.id, mediaIds));
  if (settingsBefore) await db.update(schema.settings).set({ value: settingsBefore }).where(eq(schema.settings.key, 'ai'));
  else await db.delete(schema.settings).where(eq(schema.settings.key, 'ai'));
  redis.disconnect();
  await closePreviewStore();
  await closeTaskQueues();
  await sqlClient.end();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
