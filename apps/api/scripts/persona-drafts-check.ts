/**
 * AI 草稿 against the real API, DB, Redis and the real Anthropic API. No mocks.
 * - Personas no longer carry daily AI settings (owner decision 2026-11-18): draftEnabled/draftsPerDay/draftOwnerId in
 *   POST/PATCH are ignored (LEGACY columns untouched), not returned; a persona with the legacy column set creates nothing.
 * - The prompt (buildUserMessage + loadExamples, no model call): 定位, the 发文风格 (tone preset + note, emoji, post
 *   length range, hashtags, audience, fixed opening/closing, notes; nothing of the 评论风格), shared topics + banned
 *   words, Language zh-CN, the persona's oldest 5 post examples (in its own scope; not comment examples, not other
 *   users' templates).
 * - AI settings (admin): key write-only (never echoed, sealed in the DB, not in audit), model/hour/workspace validation;
 *   no global on/off any more (removed 2026-11-18): GET never returns `enabled`, a stored `enabled: false` written into
 *   the row is ignored (preview, daily schedule and manual runs all reach the real API → ai.key_invalid), a PUT with
 *   `enabled` from an older page is accepted, ignored and drops the stored value;
 *   mapApiError turns the documented workspace errors into ai.workspace_required/_invalid/_not_found.
 * - 社交号 → AI 草稿 (GET/PUT /api/social/accounts/:id/ai-drafts): owner/admin, others 404; per day 1..10; switching on
 *   needs a persona (ai.account_no_persona) and an enabled platform; list items carry aiDraftsEnabled/aiDraftsPerDay; audit.
 * - AI测试 preview (POST /api/personas/:id/drafts/preview {topic?}): a pure style test: RBAC (other user 404, public
 *   persona as user 403), no key → 400 ai.not_configured, topic > 200 chars → 400, topic
 *   with a banned word → 400 persona.banned_word (not counted), a REAL call with an invalid key → 502 ai.key_invalid
 *   with no content, rate limit PREVIEW_LIMIT per persona per 10 min (429 ai.rate_limited {seconds, limit}), the former
 *   save endpoint POST …/drafts/save is gone (404), audit persona.draft_preview with requested model / ok / error code /
 *   topic given (boolean) and no texts.
 * - The prompt with a topic names it ("Requested topic …"), without one it doesn't.
 * - 「AI生成草稿」 (POST /api/social/accounts/:id/ai-drafts/generate {count?, topic?}): owner/admin (others 404), no key
 *   ai.not_configured, no persona ai.account_no_persona, platform.disabled, count 1..10, topic
 *   ≤ 200 + banned word persona.banned_word, 202 + an account-drafts task (payload trigger manual + count + topic,
 *   key account-drafts-manual:<id>:<uuid>, created by the caller) also when the daily switch is off, a second request
 *   within MANUAL_WINDOW_SEC → 429 ai.rate_limited {seconds}; the run reaches the REAL API with the invalid key → failed
 *   ai.key_invalid after 1 attempt; GET …/ai-drafts shows it as the last run (trigger manual); audit count + topic flag.
 * - 「AI生成草稿」 preview → edit → save (→ publish): POST …/ai-drafts/preview {topic?} (RBAC 404, ai.not_configured,
 *   ai.account_no_persona, platform.disabled, topic ≤ 200 + banned word, REAL invalid-key call → 502 ai.key_invalid and
 *   nothing written, PREVIEW_LIMIT per account → 429); POST …/ai-drafts/save (refusals: RBAC, persona, platform, banned
 *   word in body / translation, another user's media, translation not in the account language; content of the account
 *   owner, draft, zh-CN, tag ai-draft, target = the account, ai_generated via/accountId/topic/edited/model; a preview
 *   token (written into Redis like the preview does) gives served model/topic/edited false and is used up, another
 *   caller's is ignored; en account: translation row / needsTranslation; publish now on a PLACEHOLDER phone (adb port
 *   5588, inert) → publish_tasks.lang en + caption from the translation → device tried → operator publish.device_offline;
 *   no media → publish.error, draft kept; scheduled; admin on B's account); audit without texts.
 * - Daily schedule per social account (`account-drafts`): not before the hour, nothing without a
 *   key; one task per switched-on account with a persona per local day (count = its per day, owner = account owner),
 *   idempotent; skips disabled owners (ai.owner_disabled) and disabled platforms; switched-off accounts get none; the
 *   runs reach the real API with the invalid key and fail ai.key_invalid after 1 attempt (no key in payload/logs); the
 *   account's last run in GET …/ai-drafts; a task of a switched-off account ends skipped; a legacy `persona-drafts` task
 *   ends skipped (ai.moved_to_accounts).
 * - saveDrafts from a HAND-MADE structured result (no model): per account (target = that account) and for a persona's
 *   accounts (disabled platform skipped, needsTranslation), banned-word drafts dropped, suggested media, visibility.
 * - With ANTHROPIC_TEST_API_KEY (+ ANTHROPIC_TEST_WORKSPACE_ID): one REAL preview (with a topic).
 * Usage (from apps/api, API running with default ENABLED_PLATFORMS=instagram; never against an API you don't own):
 *   E2E_API=http://127.0.0.1:3000 npx tsx --env-file=../../.env scripts/persona-drafts-check.ts
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gte, inArray } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';
import { Redis } from 'ioredis';
import { config } from '../src/config.js';
import { db, schema, sqlClient } from '../src/db/index.js';
import {
  ACCOUNT_DRAFT_TASK, buildUserMessage, closeAiRedis, DRAFT_TAG, DRAFT_TASK, loadExamples, MANUAL_WINDOW_SEC, mapApiError, PREVIEW_LIMIT,
  saveDrafts, scheduleAccountDrafts, SYSTEM_PROMPT,
} from '../src/modules/ai/drafts.js';
import { closeTaskQueues, createTask } from '../src/modules/tasks/core.js';
import { withCaptcha } from './lib/login.js';
import { linkAccount } from './lib/social-link.js';

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
const fakeIds: string[] = [];
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
    check('prompt without a topic: no "Requested topic" line', !has('Requested topic'));
    const withTopic = buildUserMessage({ persona: row!, count: 2, day: '2026-11-18', examples: ex, recent: [], topic: '咖啡豆保存' });
    check('prompt with a topic: "Requested topic (every draft is about it, each from a different angle): 咖啡豆保存"',
      withTopic.includes('Requested topic (every draft is about it, each from a different angle): 咖啡豆保存') && SYSTEM_PROMPT.includes('requested topic'));
    check('system prompt: Chinese only, draft-only role', SYSTEM_PROMPT.includes('Write in Simplified Chinese (zh-CN)') && SYSTEM_PROMPT.includes('DRAFT'));
    const [pubRow] = await db.select().from(schema.personas).where(eq(schema.personas.id, pP.id));
    const exP = await loadExamples(pubRow!);
    check('prompt (public persona): only shared examples (not A\'s private one)', exP.length === 1 && exP[0]!.text === 'Shared brand example');
  }

  // ================================================================ AI settings (admin, key write-only)
  r = await http('GET', '/api/settings/ai', A.token);
  check('users cannot read the AI settings (403)', r.status === 403);
  const rOld = await http('PUT', '/api/settings/ai', T, { apiKey: null, enabled: true, model: 'claude-opus-5-5', hour: 6, workspaceId: null });
  r = await http('GET', '/api/settings/ai', T);
  check('defaults: no key, model claude-opus-5-5, hour 6; no `enabled` returned (global switch removed); an older page\'s PUT with enabled → 200',
    rOld.status === 200 && !('enabled' in rOld.body.ai) && r.status === 200 && r.body.ai.keySet === false && r.body.ai.model === 'claude-opus-5-5' && r.body.ai.hour === 6 && !('enabled' in r.body.ai),
    JSON.stringify(r.body.ai));
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
  r = await http('POST', `/api/social/accounts/${igA.id}/ai-drafts/generate`, A.token, {});
  check('AI生成草稿 without a key → 400 ai.not_configured', r.status === 400 && r.body.code === 'ai.not_configured', `${r.status} ${r.body?.code}`);
  r = await http('POST', `/api/social/accounts/${igA.id}/ai-drafts/preview`, A.token, {});
  check('account preview without a key → 400 ai.not_configured', r.status === 400 && r.body.code === 'ai.not_configured', `${r.status} ${r.body?.code}`);
  let sch = await scheduleAccountDrafts(localAt(23));
  check('schedule without a key: nothing, reason ai.not_configured', sch.reason === 'ai.not_configured' && sch.created === 0, JSON.stringify(sch));

  // ================================================================ AI测试 preview with an invalid key (real calls)
  r = await http('PUT', '/api/settings/ai', T, { apiKey: INVALID_KEY });
  // An older release's global switch, stored OFF directly in the row: it must be ignored from here on (every preview,
  // daily schedule and manual run below reaches the real API with the invalid key).
  await sqlClient`update settings set value = value || '{"enabled": false}'::jsonb where key = 'ai'`;
  const storedOff = async () => ((await db.select().from(schema.settings).where(eq(schema.settings.key, 'ai')))[0]?.value as any)?.enabled === false;
  const gs = await http('GET', '/api/settings/ai', T);
  check('a stored enabled:false (older release) is not returned by GET', await storedOff() && gs.status === 200 && !('enabled' in gs.body.ai), JSON.stringify(gs.body.ai));
  const stored = JSON.stringify((await db.select().from(schema.settings).where(eq(schema.settings.key, 'ai')))[0]?.value ?? {});
  check('key saved write-only: keySet, never echoed, sealed in the DB', r.body.ai.keySet === true && !r.text.includes(INVALID_KEY) && !gs.text.includes(INVALID_KEY) && !stored.includes(INVALID_KEY) && stored.includes('"apiKeyEnc":"v1:'));
  r = await http('POST', `/api/personas/${pA.id}/drafts/preview`, B.token);
  const rPub = await http('POST', `/api/personas/${pP.id}/drafts/preview`, A.token);
  check('preview: other user 404, public persona as user 403', r.status === 404 && rPub.status === 403, `${r.status} ${rPub.status}`);
  {
    const long = await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token, { topic: 'x'.repeat(201) });
    const bad = await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token, { topic: '最便宜的咖啡' });
    check('preview topic: > 200 chars → 400; banned word → 400 persona.banned_word {words} (before the model, not counted)',
      long.status === 400 && bad.status === 400 && bad.body.code === 'persona.banned_word' && bad.body.params?.words === '最便宜', `${long.status} ${bad.status} ${JSON.stringify(bad.body)}`);
    const saveGone = await http('POST', `/api/personas/${pA.id}/drafts/save`, A.token, { token: randomBytes(24).toString('base64url') });
    check('the former 「保存为草稿」 endpoint POST …/drafts/save is gone (404)', saveGone.status === 404, `${saveGone.status}`);
  }
  const before = await contentCount();
  const tStart = Date.now();
  r = await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token);
  const ms = Date.now() - tStart;
  check('REAL Anthropic call with an invalid key (stored enabled:false ignored): preview → 502 ai.key_invalid, synchronous', r.status === 502 && r.body.code === 'ai.key_invalid' && !r.text.includes(INVALID_KEY),
    `${r.status} ${r.body?.code} ${ms} ms`);
  const statuses: number[] = [];
  for (let k = 2; k <= PREVIEW_LIMIT; k++) statuses.push((await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token)).status);
  r = await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token);
  check(`rate limit: previews 2..${PREVIEW_LIMIT} still reach the API (502), #${PREVIEW_LIMIT + 1} → 429 ai.rate_limited {seconds, limit}`,
    statuses.every((s) => s === 502) && r.status === 429 && r.body.code === 'ai.rate_limited' && Number(r.body.params?.seconds) > 500 && r.body.params?.limit === PREVIEW_LIMIT,
    `${statuses.join()} ${r.status} ${JSON.stringify(r.body)}`);
  const rOther = await http('POST', `/api/personas/${pA2.id}/drafts/preview`, A.token, { topic: '咖啡豆保存' });
  check('rate limit is per persona (another persona, with a topic, still reaches the API)', rOther.status === 502 && rOther.body.code === 'ai.key_invalid', `${rOther.status}`);
  check('no content created by any preview', await contentCount() === before);
  r = await http('POST', `/api/personas/${pP.id}/drafts/preview`, T);
  check('preview as admin of the public persona with the stored enabled:false → reaches the API, 502 ai.key_invalid (no ai.disabled)', await storedOff() && r.status === 502 && r.body.code === 'ai.key_invalid', `${r.status} ${r.body?.code}`);

  // ================================================================ daily schedule per account (real calls, invalid key)
  sch = await scheduleAccountDrafts(localAt(3));
  check('before the configured hour (06:00): reason ai.not_due', sch.reason === 'ai.not_due' && sch.created === 0);
  check('the stored enabled:false is still in the row for the schedule and the manual runs below', await storedOff());
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
    && r.body.runs[0].created === null && r.body.runs[0].trigger === 'schedule' && rB.body.runs[0]?.id === sTasks.find((x) => x.refId === igB.id)!.id, JSON.stringify(r.body.runs));
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

  // ================================================================ 「AI生成草稿」 now (real calls, invalid key)
  {
    const gen = (id: string, token: string, body: unknown = {}) => http('POST', `/api/social/accounts/${id}/ai-drafts/generate`, token, body);
    const asB = await gen(igA.id, B.token);
    const noP = await gen(igA2.id, A.token);
    const yt = await gen(ytA!.id, A.token);
    check('AI生成草稿: other user 404 social.not_found; no persona 400 ai.account_no_persona; youtube 400 platform.disabled',
      asB.status === 404 && asB.body.code === 'social.not_found' && noP.status === 400 && noP.body.code === 'ai.account_no_persona' && yt.status === 400 && yt.body.code === 'platform.disabled',
      `${asB.status} ${noP.status}/${noP.body?.code} ${yt.status}/${yt.body?.code}`);
    const c0 = await gen(igAen.id, A.token, { count: 0 });
    const c11 = await gen(igAen.id, A.token, { count: 11 });
    const tLong = await gen(igAen.id, A.token, { topic: 'x'.repeat(201) });
    const tBan = await gen(igAen.id, A.token, { topic: 'ForbiddenWord 的保存方法' });
    check('AI生成草稿: count 0 / 11 → 400, topic > 200 → 400, topic with a banned word → 400 persona.banned_word (nothing queued, not rate limited)',
      c0.status === 400 && c11.status === 400 && tLong.status === 400 && tBan.status === 400 && tBan.body.code === 'persona.banned_word' && tBan.body.params?.words === 'forbiddenword',
      `${c0.status} ${c11.status} ${tLong.status} ${tBan.status} ${JSON.stringify(tBan.body)}`);
    const [enRow] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, igAen.id));
    const ok = await gen(igAen.id, A.token, { count: 2, topic: '  咖啡豆保存  ' });
    const again = await gen(igAen.id, A.token, {});
    check(`AI生成草稿 on an account with the daily switch OFF → 202 + task; again at once → 429 ai.rate_limited {seconds ≤ ${MANUAL_WINDOW_SEC}}`,
      enRow!.aiDraftsEnabled === false && ok.status === 202 && !!ok.body.task?.id && again.status === 429 && again.body.code === 'ai.rate_limited'
        && Number(again.body.params?.seconds) > MANUAL_WINDOW_SEC - 30 && Number(again.body.params?.seconds) <= MANUAL_WINDOW_SEC, `${ok.status} ${again.status} ${JSON.stringify(again.body)}`);
    const [mt] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, ok.body.task.id));
    check('task: account-drafts, refType social_account, created by the caller, payload {count 2, trigger manual, topic trimmed}, key account-drafts-manual:<id>:<uuid>',
      mt?.type === ACCOUNT_DRAFT_TASK && mt.refType === 'social_account' && mt.refId === igAen.id && mt.createdBy === A.id
        && (mt.payload as any).count === 2 && (mt.payload as any).trigger === 'manual' && (mt.payload as any).topic === '咖啡豆保存'
        && new RegExp(`^${ACCOUNT_DRAFT_TASK}-manual:${igAen.id}:[0-9a-f-]{36}$`).test(mt.idempotencyKey ?? ''), JSON.stringify(mt).slice(0, 400));
    const adm = await gen(igB.id, T, {});
    check('admin generates for B\'s account → 202 (task created by the admin, no topic in the payload)', adm.status === 202, `${adm.status} ${adm.text.slice(0, 120)}`);
    const [mtB] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, adm.body.task.id));
    check('admin task: created by the admin, count 1, no topic', mtB?.createdBy !== B.id && (mtB?.payload as any)?.count === 1 && !('topic' in (mtB?.payload as any)));
    const [d1, d2] = [await waitTask(mt!.id), await waitTask(mtB!.id)];
    const mlogs = JSON.stringify(await db.select().from(schema.taskLogs).where(inArray(schema.taskLogs.taskId, [mt!.id, mtB!.id])));
    check('manual runs reach the REAL API (not skipped although the daily switch is off) and fail ai.key_invalid once (not retried)',
      [d1, d2].every((x) => x.status === 'failed' && x.errorCode === 'ai.key_invalid' && x.attempts === 1), [d1, d2].map((x) => `${x.status}/${x.errorCode}/${x.attempts}`).join(' '));
    check('manual task logs: "drafts: requesting 2 …" with the topic, never the key', mlogs.includes('drafts: requesting 2 from claude-opus-5-5') && mlogs.includes('咖啡豆保存') && !mlogs.includes(INVALID_KEY) && !mlogs.includes('sk-ant'));
    r = await http('GET', `/api/social/accounts/${igAen.id}/ai-drafts`, A.token);
    check('GET ai-drafts: the manual run is the last run (trigger manual, failed ai.key_invalid)', r.body.runs[0]?.id === mt!.id && r.body.runs[0].trigger === 'manual' && r.body.runs[0].errorCode === 'ai.key_invalid',
      JSON.stringify(r.body.runs?.[0]));
    check('GET ai-drafts: ai = {keySet, hour} only (no enabled)', r.body.ai?.keySet === true && r.body.ai?.hour === 6 && !('enabled' in r.body.ai), JSON.stringify(r.body.ai));
  }
  {
    // An older page's PUT with enabled:false: accepted, ignored, and the stored legacy value is dropped on this save.
    const wasOff = await storedOff();
    const put = await http('PUT', '/api/settings/ai', T, { hour: 6, enabled: false });
    const row = (await db.select().from(schema.settings).where(eq(schema.settings.key, 'ai')))[0]?.value as Record<string, unknown>;
    check('PUT with enabled:false (older page) → 200, not returned, stored `enabled` dropped, key kept', wasOff && put.status === 200 && !('enabled' in put.body.ai) && put.body.ai.keySet === true
      && !('enabled' in row) && typeof row.apiKeyEnc === 'string', `${put.status} ${JSON.stringify(Object.keys(row))}`);
    const pv = await http('POST', `/api/personas/${pA2.id}/drafts/preview`, A.token);
    check('after that save a preview still reaches the API (502 ai.key_invalid)', pv.status === 502 && pv.body.code === 'ai.key_invalid', `${pv.status} ${pv.body?.code}`);
  }

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
  const SA = schema.socialAccounts;
  const personaAccs = await db.select({ id: SA.id, platform: SA.platform, lang: SA.lang }).from(SA).where(and(eq(SA.userId, A.id), eq(SA.personaId, pA.id)));
  const saved = await saveDrafts({
    accounts: personaAccs,
    persona: personaA!, ownerId: A.id, model: 'handmade-test-result', requestedModel: 'claude-opus-5-5', taskId: null,
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
  const savedB = await saveDrafts({ persona: personaP!, ownerId: B.id, accounts: [igBRow!], model: 'handmade-test-result', requestedModel: 'claude-opus-5-5', taskId: null, via: 'account', accountId: igB.id, topic: '咖啡豆保存',
    drafts: [{ title: '标题', body: '正文', hashtags: ['标签'], mediaTags: [] }] });
  const [bRow] = await db.select().from(schema.contents).where(eq(schema.contents.id, savedB.contentIds[0]!));
  const bTargets = await db.select().from(schema.contentTargets).where(eq(schema.contentTargets.contentId, bRow!.id));
  check('per account: draft of the account owner, target = exactly that account, via account, topic recorded', bRow?.userId === B.id && bTargets.length === 1 && bTargets[0]!.accountId === igB.id
    && bRow?.aiGenerated?.via === 'account' && bRow?.aiGenerated?.accountId === igB.id && bRow?.aiGenerated?.topic === '咖啡豆保存' && savedB.needsTranslation.length === 0);
  check('saveDrafts without a topic records none', !('topic' in ((await db.select().from(schema.contents).where(eq(schema.contents.id, saved.contentIds[0]!)))[0]!.aiGenerated ?? {})));

  // ================================================================ 「AI生成草稿」 = account preview → edit → save (→ publish)
  {
    const prev = (id: string, token: string, body: unknown = {}) => http('POST', `/api/social/accounts/${id}/ai-drafts/preview`, token, body);
    const save = (id: string, token: string, body: Record<string, unknown>) => http('POST', `/api/social/accounts/${id}/ai-drafts/save`, token, body);
    const asB = await prev(igA.id, B.token);
    const noP = await prev(igA2.id, A.token);
    const yt = await prev(ytA!.id, A.token);
    const tLong = await prev(igA.id, A.token, { topic: 'x'.repeat(201) });
    const tBan = await prev(igA.id, A.token, { topic: '最便宜的咖啡' });
    check('account preview: other user 404 social.not_found; no persona ai.account_no_persona; youtube platform.disabled; topic > 200 → 400; banned topic → persona.banned_word',
      asB.status === 404 && asB.body.code === 'social.not_found' && noP.status === 400 && noP.body.code === 'ai.account_no_persona' && yt.status === 400 && yt.body.code === 'platform.disabled'
        && tLong.status === 400 && tBan.status === 400 && tBan.body.code === 'persona.banned_word', `${asB.status} ${noP.body?.code} ${yt.body?.code} ${tLong.status} ${tBan.body?.code}`);
    const n0 = await contentCount();
    const pv = await prev(igA.id, A.token, { topic: '咖啡豆保存' });
    check('account preview: REAL Anthropic call with the invalid key → 502 ai.key_invalid, synchronous, key not echoed', pv.status === 502 && pv.body.code === 'ai.key_invalid' && !pv.text.includes(INVALID_KEY),
      `${pv.status} ${pv.body?.code}`);
    const sts: number[] = [];
    for (let k = 2; k <= PREVIEW_LIMIT; k++) sts.push((await prev(igA.id, A.token)).status);
    const lim = await prev(igA.id, A.token);
    const other = await prev(igAen.id, A.token);
    const adm = await prev(igB.id, T);
    check(`account preview rate limit: 2..${PREVIEW_LIMIT} reach the API (502), #${PREVIEW_LIMIT + 1} → 429 ai.rate_limited {seconds, limit}; per account (another → 502); admin on B's account → 502`,
      sts.every((s) => s === 502) && lim.status === 429 && lim.body.code === 'ai.rate_limited' && lim.body.params?.limit === PREVIEW_LIMIT && Number(lim.body.params?.seconds) > 500
        && other.status === 502 && adm.status === 502, `${sts.join()} ${lim.status} ${other.status} ${adm.status}`);
    check('account previews wrote nothing (no content, no stored preview)', await contentCount() === n0 && (await redis.keys('ai:account-preview:*')).every((k) => k.includes(':count:')));

    // save (no model needed: the person's edited text; a stored preview origin is written into Redis like the preview does)
    const [privB] = await db.insert(schema.mediaAssets).values({
      ownerType: 'user', ownerId: B.id, name: `b-private ${tag}`, fileName: 'b.jpg', storage: 'local', fileKey: `users/${B.id}/images/${randomUUID()}.jpg`,
      fileType: 'image', mimeType: 'image/jpeg', fileSize: 1000, width: 100, height: 100, checksum: `b${tag}`, status: 'ready',
    }).returning();
    mediaIds.push(privB!.id);
    const sB = await save(igA.id, B.token, { title: 't', body: 'b' });
    const sNoP = await save(igA2.id, A.token, { title: 't', body: 'b' });
    const sYt = await save(ytA!.id, A.token, { title: 't', body: 'b' });
    const sBan = await save(igA.id, A.token, { title: '标题', body: '这是最便宜的' });
    const sMedia = await save(igA.id, A.token, { title: '标题', body: '正文', mediaIds: [privB!.id] });
    const sLang = await save(igA.id, A.token, { title: '标题', body: '正文', translation: { lang: 'en', body: 'English' } });
    const sTrBan = await save(igAen.id, A.token, { title: '标题', body: '正文', translation: { lang: 'en', body: 'The cheapest ForbiddenWord' } });
    const sEmpty = await save(igA.id, A.token, { title: ' ', body: '正文' });
    check('save refusals: other user 404; no persona ai.account_no_persona; youtube platform.disabled; banned word in body / translation → persona.banned_word; another user\'s private media 404 media.not_found; translation not in the account language → ai.translation_lang_mismatch; empty title 400',
      sB.status === 404 && sNoP.body?.code === 'ai.account_no_persona' && sYt.body?.code === 'platform.disabled' && sBan.status === 400 && sBan.body.code === 'persona.banned_word'
        && sTrBan.body?.code === 'persona.banned_word' && sMedia.status === 404 && sMedia.body.code === 'media.not_found' && sLang.status === 400 && sLang.body.code === 'ai.translation_lang_mismatch' && sEmpty.status === 400,
      [sB, sNoP, sYt, sBan, sTrBan, sMedia, sLang, sEmpty].map((x) => `${x.status}/${x.body?.code}`).join(' '));
    check('refused saves wrote nothing', await contentCount() === n0);

    const draftBody = '今晚吃什么？\n改过的正文\n你们最爱哪道？\n\n#pasta';
    const s1 = await save(igA.id, A.token, { title: '我改的标题', body: draftBody, mediaIds: [img!.id], topic: '  咖啡豆保存 ', token: randomBytes(24).toString('base64url') });
    const c1 = s1.body?.content;
    const [row1] = c1 ? await db.select().from(schema.contents).where(eq(schema.contents.id, c1.id)) : [];
    const tg1 = c1 ? await db.select().from(schema.contentTargets).where(eq(schema.contentTargets.contentId, c1.id)) : [];
    const ai1 = row1?.aiGenerated as any;
    check('存草稿 (unknown token): 201 content of the account owner, stage draft, zh-CN, tag ai-draft, target = exactly the account, media kept, created by the caller, no publish',
      s1.status === 201 && s1.body.publish === null && row1?.userId === A.id && row1.stage === 'draft' && row1.status === 'draft' && row1.lang === 'zh-CN' && row1.body === draftBody
        && row1.title === '我改的标题' && row1.createdBy === A.id && c1.tags.includes(DRAFT_TAG) && c1.media.map((m: any) => m.id).join() === img!.id && tg1.length === 1 && tg1[0]!.accountId === igA.id,
      `${s1.status} ${s1.text.slice(0, 300)}`);
    check('ai_generated: via account, accountId, topic (trimmed), edited true, model = the settings model, persona, no task, no needsTranslation',
      ai1?.via === 'account' && ai1.accountId === igA.id && ai1.topic === '咖啡豆保存' && ai1.edited === true && ai1.model === 'claude-opus-5-5' && ai1.requestedModel === 'claude-opus-5-5'
        && ai1.personaId === pA.id && ai1.taskId === null && !('needsTranslation' in ai1), JSON.stringify(ai1));
    check('no publish task for 存草稿', (await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.contentId, c1.id))).length === 0);

    // a preview origin as stored by the preview (Redis key = sha256 of the token): used only for this account + caller
    const putPreview = async (accountId: string, userId: string) => {
      const token = randomBytes(24).toString('base64url');
      const value = { accountId, userId, personaId: pA.id, model: 'served-model-x', requestedModel: 'claude-opus-5-5', title: '原标题', text: '原正文', mediaTags: ['beach'], topic: '原主题', generatedAt: '2026-11-18T01:02:03.000Z' };
      await redis.set(`ai:account-preview:${createHash('sha256').update(token).digest('hex')}`, JSON.stringify(value), 'EX', 300);
      return token;
    };
    const tok = await putPreview(igA.id, A.id);
    const s2 = await save(igA.id, A.token, { title: '原标题', body: '原正文', token: tok, topic: '伪造主题' });
    const ai2 = (await db.select().from(schema.contents).where(eq(schema.contents.id, s2.body.content.id)))[0]?.aiGenerated as any;
    const left = await redis.exists(`ai:account-preview:${createHash('sha256').update(tok).digest('hex')}`);
    check('save with the preview\'s token, unchanged text: edited false, served model / topic / mediaTags / time from the preview (the body\'s topic ignored), token used up',
      s2.status === 201 && ai2?.edited === false && ai2.model === 'served-model-x' && ai2.topic === '原主题' && ai2.mediaTags.join() === 'beach' && ai2.generatedAt === '2026-11-18T01:02:03.000Z' && left === 0,
      `${s2.status} ${JSON.stringify(ai2)}`);
    const tokB = await putPreview(igA.id, B.id);
    const s3 = await save(igA.id, A.token, { title: '原标题', body: '原正文', token: tokB });
    const ai3 = (await db.select().from(schema.contents).where(eq(schema.contents.id, s3.body.content.id)))[0]?.aiGenerated as any;
    check('a token of another caller is ignored (settings model, edited true)', s3.status === 201 && ai3?.model === 'claude-opus-5-5' && ai3.edited === true && !('topic' in ai3), JSON.stringify(ai3));

    // the account language (en): the translation block
    const s4 = await save(igAen.id, A.token, { title: '中文标题', body: '中文正文' });
    const ai4 = (await db.select().from(schema.contents).where(eq(schema.contents.id, s4.body.content.id)))[0]?.aiGenerated as any;
    check('account in en without a translation: saved, needsTranslation [en], no translation row',
      s4.status === 201 && ai4?.needsTranslation?.join() === 'en' && (await db.select().from(schema.contentTranslations).where(eq(schema.contentTranslations.contentId, s4.body.content.id))).length === 0);

    // publish through distribute(): a PLACEHOLDER phone (inert row, adb port 5588, pinned online by a trigger like
    // device-publish-check) → the device method is tried, adb doesn't see the phone → operator.
    const PINNED = 'pdc-ai-pinned-online';
    await sqlClient.unsafe(`create or replace function pdc_ai_pin_online() returns trigger language plpgsql as $$
      begin if new.image = '${PINNED}' then new.status := 'running'; new.adb_state := 'device'; end if; return new; end $$`);
    await sqlClient.unsafe('drop trigger if exists pdc_ai_pin_online on instances');
    await sqlClient.unsafe('create trigger pdc_ai_pin_online before update on instances for each row execute function pdc_ai_pin_online()');
    const [fake] = await db.insert(schema.instances).values({ name: `pdcfake-${tag}`, status: 'running', adbState: 'device', image: PINNED, adbPort: 5588, spec: { width: 720, height: 1280, dpi: 320 } }).returning();
    fakeIds.push(fake!.id);
    await http('PUT', `/api/instances/${fake!.id}/grants`, T, { userIds: [A.id] });
    await linkAccount(igAen.id, fake!.id);
    const s5 = await save(igAen.id, A.token, {
      title: '中文标题', body: '中文正文 #coffee', mediaIds: [img!.id], translation: { lang: 'en', title: '', body: 'English caption #coffee' }, publish: { scheduledAt: null },
    });
    const c5 = s5.body?.content;
    const trs5 = c5 ? await db.select().from(schema.contentTranslations).where(eq(schema.contentTranslations.contentId, c5.id)) : [];
    const ai5 = c5 ? (await db.select().from(schema.contents).where(eq(schema.contents.id, c5.id)))[0]?.aiGenerated as any : null;
    check('立即发布 with an en translation: 201, translation row lang en (empty title = the Chinese title), no needsTranslation, one publish task',
      s5.status === 201 && trs5.length === 1 && trs5[0]!.lang === 'en' && trs5[0]!.title === '中文标题' && trs5[0]!.body === 'English caption #coffee' && !('needsTranslation' in (ai5 ?? {}))
        && s5.body.publish?.error === null && s5.body.publish?.tasks?.length === 1, `${s5.status} ${s5.text.slice(0, 400)}`);
    const pid = s5.body.publish?.tasks?.[0]?.id as string;
    const [pt5] = pid ? await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.id, pid)) : [];
    check('the publish task uses the account language: lang en, caption from the translation, feed, account igAen, owner A',
      pt5?.lang === 'en' && (pt5.caption ?? '').includes('English caption') && pt5.postType === 'feed' && pt5.accountId === igAen.id && pt5.userId === A.id, JSON.stringify(pt5).slice(0, 300));
    let d5: any = null;
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      d5 = (await http('GET', `/api/publish/tasks/${pid}`, A.token)).body;
      if (['awaiting_operator', 'failed'].includes(d5?.task?.status) && d5.runs.every((x: any) => ['success', 'failed', 'cancelled'].includes(x.status))) break;
      await sleep(1000);
    }
    const res5 = d5?.runs?.[d5.runs.length - 1]?.result;
    check('the run: device method tried on the placeholder phone, adb doesn\'t see it → operator (publish.device_offline); the content is no longer a draft',
      d5?.task?.status === 'awaiting_operator' && res5?.reasons?.device === 'publish.device_offline' && (await db.select().from(schema.contents).where(eq(schema.contents.id, c5.id)))[0]?.stage === 'ready',
      `${d5?.task?.status} ${JSON.stringify(res5)}`);

    const s6 = await save(igA.id, A.token, { title: '没有素材', body: '正文', publish: { scheduledAt: null } });
    const c6 = s6.body?.content;
    check('立即发布 refused by distribute (Instagram feed without media): 201, the draft is kept, publish.error with its code, no publish task',
      s6.status === 201 && typeof s6.body.publish?.error?.code === 'string' && s6.body.publish.error.code.startsWith('publish.') && s6.body.publish.tasks.length === 0
        && (await db.select().from(schema.contents).where(eq(schema.contents.id, c6.id)))[0]?.stage === 'draft'
        && (await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.contentId, c6.id))).length === 0, `${s6.status} ${JSON.stringify(s6.body?.publish)}`);
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const s7 = await save(igA.id, A.token, { title: '排程', body: '正文', mediaIds: [img!.id], publish: { scheduledAt: at } });
    const [pt7] = s7.body?.publish?.tasks?.[0] ? await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.id, s7.body.publish.tasks[0].id)) : [];
    check('排程发布: a publish task scheduled at the chosen time (account without a language: the Chinese source, lang zh-CN)',
      s7.status === 201 && pt7?.status === 'scheduled' && Math.abs(pt7.scheduledAt.getTime() - Date.parse(at)) < 1000 && pt7.lang === 'zh-CN', `${s7.status} ${pt7?.status} ${pt7?.scheduledAt?.toISOString()}`);
    if (pt7) await http('POST', `/api/publish/tasks/${pt7.id}/cancel`, A.token);
    const sAdm = await save(igB.id, T, { title: '管理员替 B 存', body: '正文' });
    const [rowAdm] = sAdm.body?.content ? await db.select().from(schema.contents).where(eq(schema.contents.id, sAdm.body.content.id)) : [];
    check('admin saves on B\'s account: content owned by B, created by the admin', sAdm.status === 201 && rowAdm?.userId === B.id && rowAdm.createdBy !== B.id, `${sAdm.status}`);
  }

  // ================================================================ audit
  await sleep(600);
  const audits = await db.select().from(schema.auditLogs).where(gte(schema.auditLogs.at, t0));
  const prev = audits.filter((a) => a.action === 'persona.draft_preview');
  const gens = audits.filter((a) => a.action === 'social.ai_drafts_generate');
  const accA = audits.filter((a) => a.action === 'social.ai_drafts');
  const all = JSON.stringify(audits);
  check('audit persona.draft_preview: requested model, ok false, error code ai.key_invalid / ai.rate_limited / ai.not_configured',
    prev.some((a) => (a.detail as any)?.errorCode === 'ai.key_invalid' && (a.detail as any)?.requestedModel === 'claude-opus-5-5' && (a.detail as any)?.ok === false)
      && prev.some((a) => (a.detail as any)?.errorCode === 'ai.rate_limited') && prev.some((a) => (a.detail as any)?.errorCode === 'ai.not_configured'), JSON.stringify(prev.map((a) => a.detail)).slice(0, 400));
  check('audit persona.draft_preview: topic given only as a boolean (never its text)',
    prev.some((a) => (a.detail as any)?.topic === true) && prev.some((a) => (a.detail as any)?.topic === false) && !JSON.stringify(prev).includes('咖啡豆') && !JSON.stringify(prev).includes('最便宜的'));
  check('audit social.ai_drafts_generate: account name, count, topic flag (never its text), refusals recorded too',
    gens.some((a) => a.ok && (a.detail as any)?.count === 2 && (a.detail as any)?.topic === true && (a.target ?? '').includes(`pd_ig_en_${tag}`))
      && gens.some((a) => a.ok && (a.detail as any)?.count === 1 && (a.detail as any)?.topic === false) && gens.some((a) => !a.ok)
      && !JSON.stringify(gens).includes('咖啡豆') && !JSON.stringify(gens).includes('ForbiddenWord'), JSON.stringify(gens.map((a) => [a.target, a.ok, a.detail])).slice(0, 400));
  {
    const ap = audits.filter((a) => a.action === 'social.ai_drafts_preview');
    const as = audits.filter((a) => a.action === 'social.ai_drafts_save');
    const txt = JSON.stringify([ap, as]);
    check('audit social.ai_drafts_preview: account name, topic flag, requested model, ok false + error code (key_invalid / rate_limited / not_configured), never texts',
      ap.some((a) => (a.detail as any)?.topic === true && (a.detail as any)?.errorCode === 'ai.key_invalid' && (a.detail as any)?.requestedModel === 'claude-opus-5-5' && (a.target ?? '').includes(`pd_ig_a_${tag}`))
        && ap.some((a) => (a.detail as any)?.errorCode === 'ai.rate_limited') && ap.some((a) => (a.detail as any)?.errorCode === 'ai.not_configured') && !txt.includes('咖啡豆') && !txt.includes('最便宜的咖啡'),
      JSON.stringify(ap.map((a) => a.detail)).slice(0, 300));
    check('audit social.ai_drafts_save: mode draft / now / scheduled, media count, content id, edited, translation, publish tasks / error code; never texts',
      as.some((a) => a.ok && (a.detail as any)?.mode === 'draft' && (a.detail as any)?.media === 1 && (a.detail as any)?.edited === true && typeof (a.detail as any)?.contentId === 'string')
        && as.some((a) => a.ok && (a.detail as any)?.mode === 'now' && (a.detail as any)?.translation === 'en' && (a.detail as any)?.publishTasks?.length === 1 && (a.detail as any)?.publishError === null)
        && as.some((a) => a.ok && (a.detail as any)?.mode === 'now' && String((a.detail as any)?.publishError).startsWith('publish.'))
        && as.some((a) => a.ok && (a.detail as any)?.mode === 'scheduled') && as.some((a) => !a.ok)
        && !txt.includes('改过的正文') && !txt.includes('English caption') && !txt.includes('我改的标题'), JSON.stringify(as.map((a) => [a.ok, a.detail])).slice(0, 500));
  }
  check('audit: no persona.draft_preview_save any more', !audits.some((a) => a.action === 'persona.draft_preview_save'));
  check('audit social.ai_drafts: enabled/perDay with the account name', accA.some((a) => (a.detail as any)?.enabled === true && (a.detail as any)?.perDay === 2 && (a.target ?? '').includes(`pd_ig_a_${tag}`)),
    JSON.stringify(accA.map((a) => [a.target, a.detail])).slice(0, 300));
  check('audit: the key never appears', !all.includes(INVALID_KEY));

  // ================================================================ optional: one real preview (with a topic)
  const realKey = process.env.ANTHROPIC_TEST_API_KEY;
  if (realKey) {
    await http('PUT', '/api/settings/ai', T, { apiKey: realKey, workspaceId: process.env.ANTHROPIC_TEST_WORKSPACE_ID || null });
    await resetPreviewLimit(pA.id);
    const n0 = await contentCount();
    const t1 = Date.now();
    const pv = await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token, { topic: '咖啡豆保存' });
    const p = pv.body?.preview;
    check('REAL preview: 200 with title/text/model/usage + topic, nothing stored', pv.status === 200 && !!p?.title && !!p?.text && !!p?.model && p.usage?.output > 0 && p.topic === '咖啡豆保存' && await contentCount() === n0,
      `${pv.status} ${pv.body?.code ?? ''} ${Date.now() - t1} ms model=${p?.model} fallback=${p?.fallback} usage=${JSON.stringify(p?.usage)} banned=${JSON.stringify(p?.banned)}`);
    if (p) console.log(`  preview: ${JSON.stringify(p.title)} — ${JSON.stringify(p.text.slice(0, 200))}`);
    check('REAL preview: response carries no key', !pv.text.includes(realKey));
  } else {
    console.log('- ANTHROPIC_TEST_API_KEY not set: no real generation (only the invalid-key calls reached the model API)');
  }
} finally {
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T).catch(() => undefined);
  if (publicPersonaIds.length) await db.delete(schema.personas).where(inArray(schema.personas.id, publicPersonaIds));
  if (sharedTemplateIds.length) await db.delete(schema.commentTemplates).where(inArray(schema.commentTemplates.id, sharedTemplateIds));
  if (mediaIds.length) await db.delete(schema.mediaAssets).where(inArray(schema.mediaAssets.id, mediaIds)).catch((e) => console.log(`cleanup media: ${e}`));
  if (fakeIds.length) await db.delete(schema.instances).where(inArray(schema.instances.id, fakeIds)).catch((e) => console.log(`cleanup devices: ${e}`));
  await sqlClient.unsafe('drop trigger if exists pdc_ai_pin_online on instances').catch(() => undefined);
  await sqlClient.unsafe('drop function if exists pdc_ai_pin_online()').catch(() => undefined);
  if (settingsBefore) await db.update(schema.settings).set({ value: settingsBefore }).where(eq(schema.settings.key, 'ai'));
  else await db.delete(schema.settings).where(eq(schema.settings.key, 'ai'));
  redis.disconnect();
  await closeAiRedis();
  await closeTaskQueues();
  await sqlClient.end();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
