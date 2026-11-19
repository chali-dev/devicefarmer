/**
 * AI 草稿 against the real API, DB, Redis and the real Anthropic API. No mocks.
 * - Personas carry no daily AI settings (owner decision 2026-11-18): draftEnabled/draftsPerDay/draftOwnerId in POST/PATCH
 *   are stripped and not returned.
 * - The prompt (buildUserMessage + loadExamples, no model call): 定位, the persona's one style (tone preset + note,
 *   emoji, post length range, hashtags, audience, notes, topics, banned words; no fixed opening/closing since
 *   2026-11-19), Language zh-CN, the persona's oldest 5 范例 of its one list (in its own scope; not other users'
 *   templates). composeDraft adds no fixed lines.
 * - AI settings (admin): key write-only (never echoed, sealed in the DB, not in audit), model/workspace validation;
 *   no global on/off and no daily hour any more (removed 2026-11-18): GET returns neither `enabled` nor `hour`, a PUT
 *   with them is stripped (nothing stored); the settings.ai audit has no hour; mapApiError turns the documented workspace errors into ai.workspace_required/_invalid/_not_found.
 * - No daily drafts any more (owner decision 2026-11-18, 「这个定时功能不要了；让用户手动生成」): with a key set the drafts
 *   module exports no scheduler, the hourly collection run and the system maintenance create no account-drafts /
 *   persona-drafts task; account list items carry no aiDrafts* fields (columns dropped).
 * - The removed endpoints GET/PUT /api/social/accounts/:id/ai-drafts and POST …/ai-drafts/generate are 404.
 * - AI测试 preview (POST /api/personas/:id/drafts/preview {topic?}): a pure style test: RBAC (other user 404, public
 *   persona as user 403), no key → 400 ai.not_configured, topic > 200 chars → 400, topic
 *   with a banned word → 400 persona.banned_word (not counted), a REAL call with an invalid key → 502 ai.key_invalid
 *   with no content, rate limit PREVIEW_LIMIT per persona per 10 min (429 ai.rate_limited {seconds, limit}), the former
 *   save endpoint POST …/drafts/save is gone (404), audit persona.draft_preview with requested model / ok / error code /
 *   topic given (boolean) and no texts.
 * - The prompt (Chinese since 2026-11-19) = the 自定义 template filled in: 「本次主题：<topic>」 (empty without one).
 * - 「AI生成草稿」 preview → edit → save (→ publish): POST …/ai-drafts/preview {topic?} (RBAC 404, ai.not_configured,
 *   ai.account_no_persona, platform.disabled, topic ≤ 200 + banned word, REAL invalid-key call → 502 ai.key_invalid and
 *   nothing written, PREVIEW_LIMIT per account → 429); POST …/ai-drafts/save (refusals: RBAC, persona, platform, banned
 *   word in body / translation, another user's media, translation not in the account language; content of the account
 *   owner, draft, zh-CN, tag ai-draft, target = the account, ai_generated via/accountId/topic/edited/model; a preview
 *   token (written into Redis like the preview does) gives served model/topic/edited false and is used up, another
 *   caller's is ignored; en account: translation row / needsTranslation; publish now on a PLACEHOLDER phone (adb port
 *   5588, inert) → publish_tasks.lang en + caption from the translation → device tried → operator publish.device_offline;
 *   no media → publish.error, draft kept; scheduled; admin on B's account); audit without texts.
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
  buildPromptTemplate, buildUserMessage, closeAiRedis, composeDraft, renderPrompt, DRAFT_TAG, loadExamples, mapApiError, PREVIEW_LIMIT, SYSTEM_PROMPT,
} from '../src/modules/ai/drafts.js';
import * as draftsModule from '../src/modules/ai/drafts.js';
import { closeTaskQueues } from '../src/modules/tasks/core.js';
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
    tone: 'warm', toneNote: '像邻家厨师一样温柔', emoji: 'low', length: 'high', hashtags: ['#homecooking', 'dinner'], audience: '上班族', notes: '不要推荐品牌',
  };
  const pA = (await http('POST', '/api/personas', A.token, { scope: 'mine', name: `Chef ${tag}`, description: '下班后 20 分钟的家常菜', style: STYLE, draftEnabled: true, draftsPerDay: 9 })).body.persona;
  const pA2 = (await http('POST', '/api/personas', A.token, { scope: 'mine', name: `Other ${tag}` })).body.persona;
  const pP = (await http('POST', '/api/personas', T, { scope: 'public', name: `Brand ${tag}` })).body.persona;
  publicPersonaIds.push(pP.id);
  let r = await http('PATCH', `/api/personas/${pP.id}`, T, { description: '品牌', draftEnabled: true, draftOwnerId: B.id, draftsPerDay: 2 });
  const g = await http('GET', `/api/personas/${pA.id}`, A.token);
  const [dCols] = await sqlClient<{ n: number }[]>`select count(*)::int as n from information_schema.columns where table_name = 'personas' and column_name like 'draft%'`;
  check('personas: draftEnabled/draftsPerDay/draftOwnerId stripped on POST/PATCH, not in responses, columns dropped',
    !!pA?.id && r.status === 200 && dCols!.n === 0 && !('draftEnabled' in pA) && !('draftEnabled' in g.body.persona) && !('runs' in g.body.persona), `${r.status} ${dCols!.n} ${JSON.stringify(g.body?.persona).slice(0, 200)}`);
  r = await http('POST', `/api/personas/${pA.id}/drafts/generate`, A.token);
  check('old "generate now" endpoint is gone (404)', r.status === 404, `${r.status}`);

  const tpl = async (token: string, body: Record<string, unknown>) => (await http('POST', '/api/comment-templates', token, { text: 'Example caption text', ...body })).body.template;
  const sharedPost = await tpl(T, { name: `shared ${tag}`, shared: true, personaId: pP.id, text: 'Shared brand example' }); sharedTemplateIds.push(sharedPost.id);
  // one list of 范例 (2026-11-19): the oldest one is a reply, then 6 post texts
  await tpl(A.token, { name: `a-reply ${tag}`, personaId: pA.id, text: `回复范例 ${tag}` });
  for (let k = 1; k <= 6; k++) await tpl(A.token, { name: `a-post${k} ${tag}`, personaId: pA.id, text: `示例发文 ${k} ${tag}` });
  await tpl(A.token, { name: `a-pub ${tag}`, personaId: pP.id, text: `A 的私有发文用公共人设 ${tag}` });

  // ================================================================ prompt construction (no model call)
  {
    const [row] = await db.select().from(schema.personas).where(eq(schema.personas.id, pA.id));
    const ex = await loadExamples(row!);
    const msg = buildUserMessage({ persona: row!, count: 3, day: '2026-11-18', examples: ex, recent: [{ title: '上周的汤', body: '番茄蛋汤做法' }] });
    const has = (x: string) => msg.includes(x);
    check('prompt: examples = the oldest 5 范例 of the persona\'s one list (the reply included, the 5th and 6th post text not)',
      ex.length === 5 && ex[0]!.text === `回复范例 ${tag}` && ex.slice(1).every((e, k) => e.text === `示例发文 ${k + 1} ${tag}`) && has(`回复范例 ${tag}`) && !has(`示例发文 5 ${tag}`), ex.map((e) => e.text).join(' | '));
    check('prompt: 定位 + the style (tone preset + note, emoji, post length range high = 500–1500), Language zh-CN',
      has('定位：下班后 20 分钟的家常菜') && has('语气：温暖治愈（像邻家厨师一样温柔）') && has('表情：最多 1 个') && has('字数：500 到 1500 字') && has('语言：简体中文（zh-CN）') && ['【本次要求】', '【人设】', '【风格】', '【范例】', '【最近发过】'].every(has), msg.slice(0, 600));
    check('prompt: topics, banned words, hashtags (# stripped), audience, notes, recent posts; no fixed opening/closing lines',
      has('- 家常菜') && has('- weeknight dinners') && has('- forbiddenword') && has('- 最便宜') && has('- homecooking') && has('写给谁：上班族')
        && has('备注：不要推荐品牌') && has('上周的汤') && !has('固定开头') && !has('固定结尾') && !SYSTEM_PROMPT.includes('固定开头'));
    const cd = composeDraft({ title: 't', body: '正文', hashtags: ['#a'], mediaTags: [] }, row!);
    check('composeDraft adds no fixed lines (body + hashtag line only)', cd.body === '正文' && cd.text === '正文\n\n#a', JSON.stringify(cd));
    check('prompt without a topic: 【本次主题】 with an empty 本次主题： + the choose-yourself hint', has('【本次主题】\n本次主题：\n（每篇都围绕这个主题写，每篇换个角度；主题空着就从常聊话题里自己选）'));
    const withTopic = buildUserMessage({ persona: row!, count: 2, day: '2026-11-18', examples: ex, recent: [], topic: '咖啡豆保存' });
    check('prompt with a topic: 【本次主题】 本次主题：咖啡豆保存 + the different-angle line',
      withTopic.includes('【本次主题】\n本次主题：咖啡豆保存\n（每篇都围绕这个主题写，每篇换个角度；主题空着就从常聊话题里自己选）') && SYSTEM_PROMPT.includes('如果给了本次主题'));
    const tplVars = { topic: '咖啡豆保存', date: '2026-11-18', count: '2', examples: '', recent_posts: '' };
    const exVars = buildUserMessage({ persona: row!, count: 2, day: '2026-11-18', examples: [], recent: [], topic: '咖啡豆保存' });
    check('generated 人设提示词 = the 自定义 template with its placeholders filled (what the 提示词 tab previews client-side)',
      renderPrompt(buildPromptTemplate(row!).user, { ...tplVars, examples: '（无）', recent_posts: '（无）' }) === exVars
        && renderPrompt(buildPromptTemplate(row!).user, { ...tplVars, topic: '', examples: '（无）', recent_posts: '（无）' }) === buildUserMessage({ persona: row!, count: 2, day: '2026-11-18', examples: [], recent: [] }));
    check('system prompt in Chinese: Chinese only, draft-only role, never published, banned words, no invented facts, JSON field names kept', ['【你的任务】', '【必须遵守】', '【输出格式】', '用简体中文写', '只是草稿', '不要说帖子已经发了', '禁用词一个都不能用', '不编造事实', '联系方式'].every((x) => SYSTEM_PROMPT.includes(x)) && ['title：', 'body：', 'hashtags：', 'mediaTags：'].every((x) => SYSTEM_PROMPT.includes(x)) && !/[A-Za-z]{4,} [a-z]{3,} [a-z]{3,}/.test(SYSTEM_PROMPT) && !has('(none)'));
    const [pubRow] = await db.select().from(schema.personas).where(eq(schema.personas.id, pP.id));
    const exP = await loadExamples(pubRow!);
    check('prompt (public persona): only shared examples (not A\'s private one)', exP.length === 1 && exP[0]!.text === 'Shared brand example');
  }

  // ================================================================ AI settings (admin, key write-only)
  r = await http('GET', '/api/settings/ai', A.token);
  check('users cannot read the AI settings (403)', r.status === 403);
  const rOld = await http('PUT', '/api/settings/ai', T, { apiKey: null, enabled: true, model: 'claude-opus-5-5', hour: 6, workspaceId: null });
  const rowOld = (await db.select().from(schema.settings).where(eq(schema.settings.key, 'ai')))[0]?.value as Record<string, unknown>;
  r = await http('GET', '/api/settings/ai', T);
  check('defaults: no key, model claude-opus-5-5; neither `enabled` nor `hour` returned; a PUT with enabled + hour → 200, both stripped (not stored)',
    rOld.status === 200 && !('enabled' in rOld.body.ai) && !('hour' in rOld.body.ai) && r.status === 200 && r.body.ai.keySet === false && r.body.ai.model === 'claude-opus-5-5'
      && !('hour' in r.body.ai) && !('enabled' in r.body.ai) && !('hour' in rowOld) && !('enabled' in rowOld),
    `${JSON.stringify(r.body.ai)} stored ${JSON.stringify(rowOld)}`);
  const r8 = await http('PUT', '/api/settings/ai', T, { apiKey: 'short' });
  const r9 = await http('PUT', '/api/settings/ai', A.token, { enabled: false });
  const rm = await http('PUT', '/api/settings/ai', T, { model: 'gpt-x' });
  check('invalid model / key format → 400; users 403', rm.status === 400 && r8.status === 400 && r9.status === 403);
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
  {
    const g1 = await http('GET', `/api/social/accounts/${igA.id}/ai-drafts`, A.token);
    const p1 = await http('PUT', `/api/social/accounts/${igA.id}/ai-drafts`, A.token, { enabled: true, perDay: 7 });
    check('the removed GET/PUT …/ai-drafts (daily switch of older pages) → 404', g1.status === 404 && p1.status === 404, `${g1.status} ${p1.status}`);
  }
  const listA = (await http('GET', '/api/social/accounts', A.token)).body.items as any[];
  check('account list items carry no aiDraftsEnabled / aiDraftsPerDay', listA.length >= 3 && listA.every((x) => !('aiDraftsEnabled' in x) && !('aiDraftsPerDay' in x)));
  await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, C.id));

  // ================================================================ no key
  r = await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token);
  check('preview without a key → 400 ai.not_configured', r.status === 400 && r.body.code === 'ai.not_configured', `${r.status} ${r.body?.code}`);
  r = await http('POST', `/api/social/accounts/${igA.id}/ai-drafts/generate`, A.token, {});
  check('the task-based POST …/ai-drafts/generate is gone (404)', r.status === 404, `${r.status} ${r.text.slice(0, 120)}`);
  r = await http('POST', `/api/social/accounts/${igA.id}/ai-drafts/preview`, A.token, {});
  check('account preview without a key → 400 ai.not_configured', r.status === 400 && r.body.code === 'ai.not_configured', `${r.status} ${r.body?.code}`);

  // ================================================================ AI测试 preview with an invalid key (real calls)
  r = await http('PUT', '/api/settings/ai', T, { apiKey: INVALID_KEY });
  const gs = await http('GET', '/api/settings/ai', T);
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
  check('REAL Anthropic call with an invalid key: preview → 502 ai.key_invalid, synchronous', r.status === 502 && r.body.code === 'ai.key_invalid' && !r.text.includes(INVALID_KEY),
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
  check('preview as admin of the public persona → reaches the API, 502 ai.key_invalid', r.status === 502 && r.body.code === 'ai.key_invalid', `${r.status} ${r.body?.code}`);

  // ================================================================ no daily drafts (key set)
  const mineAcc = [igA.id, igAen.id, igA2.id, igB.id, igC.id, ytA!.id];
  const accTasks = async () => db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'account-drafts'), inArray(schema.tasks.refId, mineAcc), gte(schema.tasks.createdAt, t0)));
  check('the drafts module exports no scheduler (scheduleAccountDrafts / requestAccountDrafts / saveDrafts gone)',
    !('scheduleAccountDrafts' in draftsModule) && !('requestAccountDrafts' in draftsModule) && !('saveDrafts' in draftsModule));
  {
    const col = await http('POST', '/api/collection/run', T);
    const mt = await http('POST', '/api/system/maintenance', T);
    await sleep(3000);
    const legacyP = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'persona-drafts'), gte(schema.tasks.createdAt, t0)));
    check('key set: the hourly collection run and the system maintenance create no account-drafts / persona-drafts task',
      col.status < 300 && mt.status < 300 && (await accTasks()).length === 0 && legacyP.length === 0, `${col.status} ${mt.status}`);
  }
  {
    // A PUT with enabled:false / hour (fields of older pages): stripped, nothing stored.
    const put = await http('PUT', '/api/settings/ai', T, { hour: 6, enabled: false });
    const row = (await db.select().from(schema.settings).where(eq(schema.settings.key, 'ai')))[0]?.value as Record<string, unknown>;
    check('PUT with enabled:false + hour → 200, not returned, not stored, key kept', put.status === 200 && !('enabled' in put.body.ai) && put.body.ai.keySet === true
      && !('enabled' in row) && !('hour' in row) && typeof row.apiKeyEnc === 'string', `${put.status} ${JSON.stringify(Object.keys(row))}`);
    const pv = await http('POST', `/api/personas/${pA2.id}/drafts/preview`, A.token);
    check('after that save a preview still reaches the API (502 ai.key_invalid)', pv.status === 502 && pv.body.code === 'ai.key_invalid', `${pv.status} ${pv.body?.code}`);
  }

  // ================================================================ a tagged public image (suggested media / content media)
  await db.insert(schema.mediaTags).values({ name: `Beach${tag}` }).onConflictDoNothing();
  const [img] = await db.insert(schema.mediaAssets).values({
    ownerType: 'public', ownerId: null, name: `beach ${tag}`, fileName: 'beach.jpg', storage: 'local', fileKey: `public/images/${randomUUID()}.jpg`,
    fileType: 'image', mimeType: 'image/jpeg', fileSize: 1000, width: 100, height: 100, checksum: tag, status: 'ready',
  }).returning();
  mediaIds.push(img!.id);
  const [mt2] = await db.select().from(schema.mediaTags).where(eq(schema.mediaTags.name, `Beach${tag}`));
  await db.insert(schema.mediaAssetTags).values({ assetId: img!.id, tagId: mt2!.id });
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

  check('over the whole run: no account-drafts task for the test accounts',
    (await accTasks()).length === 0, `${(await accTasks()).length}`);

  // ================================================================ audit
  await sleep(600);
  const audits = await db.select().from(schema.auditLogs).where(gte(schema.auditLogs.at, t0));
  const prev = audits.filter((a) => a.action === 'persona.draft_preview');
  const all = JSON.stringify(audits);
  check('audit persona.draft_preview: requested model, ok false, error code ai.key_invalid / ai.rate_limited / ai.not_configured',
    prev.some((a) => (a.detail as any)?.errorCode === 'ai.key_invalid' && (a.detail as any)?.requestedModel === 'claude-opus-5-5' && (a.detail as any)?.ok === false)
      && prev.some((a) => (a.detail as any)?.errorCode === 'ai.rate_limited') && prev.some((a) => (a.detail as any)?.errorCode === 'ai.not_configured'), JSON.stringify(prev.map((a) => a.detail)).slice(0, 400));
  check('audit persona.draft_preview: topic given only as a boolean (never its text)',
    prev.some((a) => (a.detail as any)?.topic === true) && prev.some((a) => (a.detail as any)?.topic === false) && !JSON.stringify(prev).includes('咖啡豆') && !JSON.stringify(prev).includes('最便宜的'));
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
  check('audit: no social.ai_drafts (legacy PUT not audited) and no social.ai_drafts_generate (endpoint gone) in this run',
    !audits.some((a) => a.action === 'social.ai_drafts' || a.action === 'social.ai_drafts_generate'));
  check('audit settings.ai: no hour in the detail', audits.filter((a) => a.action === 'settings.ai').length > 0 && audits.filter((a) => a.action === 'settings.ai').every((a) => !('hour' in ((a.detail as any) ?? {}))));
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
