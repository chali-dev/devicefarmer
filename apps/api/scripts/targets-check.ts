/**
 * 账号人设 + 发布目标 against the real API and DB. No mocks.
 * - Account persona rules: public persona ok, the owner's personal persona ok, another user's personal persona → 400
 *   persona.account_not_allowed (create, update, batch); list filter personaId / none, personaName in items; batch
 *   "set-persona" (incl. clear); persona delete → accounts 未设人设; no persona merge (404); account logs (names, from → to); audit.
 * - Content targets (content_targets): owner's accounts only (others' → 404), an admin editing a user's content may only use
 *   that user's accounts (400 content.target_not_owner), disabled-platform accounts refused (400 platform.disabled),
 *   order kept and duplicates dropped, deleting an account drops it from targets, deleting the content cascades.
 * - Bulk by persona (分组 were removed; personas are the grouping): the picker expands a persona to concrete ids from the
 *   account list (`?personaId=`); the server stores only those ids (a later persona change does not change the targets).
 * - RBAC/isolation: another user's content 404, another user's accounts never appear.
 * - 人设禁用词 on contents (400 persona.banned_word with the words): create/update texts (title, body, platform captions,
 *   case-insensitive) with a target account whose persona bans them, adding such a target to existing text, a
 *   translation, an AI draft's own persona without targets, and distribution (a word added to the persona after saving;
 *   a per-target caption is a 400 since there are no per-account texts); stage-only updates are not blocked; clean texts pass.
 * Usage (from apps/api, API running with the default ENABLED_PLATFORMS=instagram):
 *   E2E_API=http://127.0.0.1:3000 npx tsx --env-file=../../.env scripts/targets-check.ts
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
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
const SA = schema.socialAccounts;
const P = schema.personas;

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('hex');
const userIds: string[] = [];
const startedAt = new Date();

try {
  const mk = async (name: string) => {
    const r = await http('POST', '/api/users', T, { username: name, password: pw, role: 'user' });
    const id = r.body.user?.id ?? r.body.id; userIds.push(id);
    return { id, token: await login(name, pw) };
  };
  const A = await mk(`tga${tag}`);
  const B = await mk(`tgb${tag}`);
  const acc = async (token: string, handle: string, extra: Record<string, unknown> = {}) =>
    http('POST', '/api/social/accounts', token, { platform: 'instagram', handle: `${handle}_${tag}`, ...extra });
  const persona = async (token: string, body: Record<string, unknown>) => (await http('POST', '/api/personas', token, body)).body.persona;

  const pub = await persona(T, { scope: 'public', name: `健身教练 ${tag}` });
  const pub2 = await persona(T, { scope: 'public', name: `美食 ${tag}` });
  const aOwn = await persona(A.token, { scope: 'mine', name: `A-mine ${tag}` });
  const bOwn = await persona(B.token, { scope: 'mine', name: `B-mine ${tag}` });
  check('setup: public + personal personas', !!pub?.id && !!pub2?.id && !!aOwn?.id && !!bOwn?.id);

  // ================================================================ account persona rules
  let r = await acc(A.token, 'a1', { personaId: pub.id });
  const a1 = r.body.account;
  check('create account with a public persona (personaName in item)', r.status === 201 && a1.personaId === pub.id && a1.personaName === pub.name, `${r.status} ${r.body?.code}`);
  r = await acc(A.token, 'a2', { personaId: aOwn.id });
  const a2 = r.body.account;
  check('create account with the owner\'s personal persona', r.status === 201 && a2.personaId === aOwn.id);
  r = await acc(A.token, 'a3', { personaId: bOwn.id });
  check('another user\'s personal persona → 400 persona.account_not_allowed', r.status === 400 && r.body.code === 'persona.account_not_allowed', `${r.status} ${r.body?.code}`);
  r = await acc(T, 'a3x', { ownerId: A.id, personaId: bOwn.id });
  check('admin creating for A with B\'s persona → 400 as well', r.status === 400 && r.body.code === 'persona.account_not_allowed');
  r = await acc(A.token, 'a3');
  const a3 = r.body.account;
  const a4 = (await acc(A.token, 'a4')).body.account;
  const b1 = (await acc(B.token, 'b1', { personaId: bOwn.id })).body.account;
  check('accounts without persona / for B', a3?.personaId === null && a4?.id && b1?.personaId === bOwn.id);

  r = await http('PUT', `/api/social/accounts/${a3.id}`, A.token, { personaId: bOwn.id });
  check('update to another user\'s persona → 400', r.status === 400 && r.body.code === 'persona.account_not_allowed');
  r = await http('PUT', `/api/social/accounts/${a3.id}`, A.token, { personaId: aOwn.id });
  check('update persona', r.status === 200 && r.body.account.personaId === aOwn.id && r.body.account.personaName === aOwn.name);
  r = await http('PUT', `/api/social/accounts/${a3.id}`, A.token, { personaId: pub.id });
  r = await http('PUT', `/api/social/accounts/${a3.id}`, A.token, { personaId: null });
  check('clear persona', r.status === 200 && r.body.account.personaId === null);
  r = await http('GET', `/api/social/accounts/${a3.id}/logs`, A.token);
  const pl = (r.body.logs as any[]).filter((x) => x.field === 'persona').reverse();
  check('account logs record persona changes with names (from → to)',
    pl.length === 3 && pl[0].fromValue === null && pl[0].toValue === aOwn.name && pl[1].fromValue === aOwn.name && pl[1].toValue === pub.name && pl[2].toValue === null,
    pl.map((x) => `${x.fromValue}→${x.toValue}`).join(' | '));

  // list filters
  const ids = (x: any) => ((x.body.items ?? []) as any[]).map((i) => i.id).sort().join();
  r = await http('GET', `/api/social/accounts?personaId=${pub.id}&pageSize=200`, A.token);
  check('filter personaId', ids(r) === [a1.id].sort().join(), ids(r));
  r = await http('GET', `/api/social/accounts?personaId=none&pageSize=200`, A.token);
  check('filter personaId=none (未设人设)', ids(r) === [a3.id, a4.id].sort().join());

  // batch set-persona
  r = await http('POST', '/api/social/accounts/batch', A.token, { ids: [a3.id, a4.id, a1.id], action: 'set-persona', personaId: pub2.id });
  const after = await db.select().from(SA).where(inArray(SA.id, [a1.id, a3.id, a4.id]));
  check('batch set-persona (3 accounts, changed 3)', r.status === 200 && r.body.changed === 3 && after.every((x) => x.personaId === pub2.id), JSON.stringify(r.body));
  r = await http('POST', '/api/social/accounts/batch', A.token, { ids: [a3.id], action: 'set-persona', personaId: bOwn.id });
  check('batch set-persona with another user\'s persona → 400', r.status === 400 && r.body.code === 'persona.account_not_allowed');
  r = await http('POST', '/api/social/accounts/batch', T, { ids: [a3.id, b1.id], action: 'set-persona', personaId: aOwn.id });
  check('admin batch: A\'s personal persona on a B account → 400', r.status === 400 && r.body.code === 'persona.account_not_allowed');
  r = await http('POST', '/api/social/accounts/batch', T, { ids: [a3.id, b1.id], action: 'set-persona', personaId: pub.id });
  check('admin batch: public persona across owners', r.status === 200 && r.body.changed === 2);
  r = await http('POST', '/api/social/accounts/batch', A.token, { ids: [a3.id, b1.id], action: 'set-persona', personaId: null });
  check('batch with another user\'s account → 404', r.status === 404 && r.body.code === 'social.not_found');
  r = await http('POST', '/api/social/accounts/batch', A.token, { ids: [a4.id], action: 'set-persona' });
  check('batch set-persona without personaId → 400', r.status === 400 && r.body.code === 'social.batch_persona_required');
  r = await http('POST', '/api/social/accounts/batch', A.token, { ids: [a4.id], action: 'set-persona', personaId: null });
  check('batch clear persona', r.status === 200 && r.body.changed === 1);
  r = await http('GET', `/api/social/accounts/${a3.id}/logs`, A.token);
  check('batch writes persona log rows', (r.body.logs as any[]).some((x) => x.field === 'persona' && x.fromValue === pub2.name && x.toValue === pub.name));

  // persona delete / merge
  await http('PUT', `/api/social/accounts/${a2.id}`, A.token, { personaId: aOwn.id });
  const aOther = await persona(A.token, { scope: 'mine', name: `A-other ${tag}` });
  await http('PUT', `/api/social/accounts/${a4.id}`, A.token, { personaId: aOther.id });
  r = await http('POST', `/api/personas/${aOther.id}/merge`, A.token, { into: aOwn.id });
  const [a4row] = await db.select().from(SA).where(eq(SA.id, a4.id));
  check('personas cannot be merged any more (POST …/merge → 404, account keeps its persona)', r.status === 404 && a4row?.personaId === aOther.id, `${r.status}`);
  await http('PUT', `/api/social/accounts/${a4.id}`, A.token, { personaId: aOwn.id });
  r = await http('DELETE', `/api/personas/${aOwn.id}`, A.token);
  const rows = await db.select().from(SA).where(inArray(SA.id, [a2.id, a4.id]));
  check('persona delete → accounts 未设人设 (persona_id null)', r.status === 204 && rows.every((x) => x.personaId === null));
  r = await http('GET', `/api/social/accounts/${a2.id}/logs`, A.token);
  check('persona delete is logged on the account', (r.body.logs as any[]).some((x) => x.field === 'persona' && x.fromValue === aOwn.name && x.toValue === null && x.message === 'persona deleted'));

  // ================================================================ content targets
  // a personal persona for the bulk pick (what a group used to be)
  const g = await persona(A.token, { scope: 'mine', name: `G ${tag}` });
  await http('POST', '/api/social/accounts/batch', A.token, { ids: [a1.id, a2.id], action: 'set-persona', personaId: g.id });
  // disabled-platform account (YouTube is off by default): inserted directly, as the API refuses to create it
  const [yt] = await db.insert(SA).values({ userId: A.id, platform: 'youtube', handle: `yt_${tag}`, createdBy: A.id }).returning();

  const content = async (token: string, body: Record<string, unknown>) => http('POST', '/api/contents', token, { title: `tg ${tag}`, ...body });
  r = await content(A.token, { targetIds: [a3.id, a1.id, a3.id] });
  const c1 = r.body.content;
  check('create content with targets: order kept, duplicates dropped', r.status === 201 && c1.targets.map((x: any) => x.id).join() === [a3.id, a1.id].join(), `${r.status} ${r.body?.code}`);
  check('target items carry handle, platform, persona and device (null = 未关联设备)',
    c1.targets[0].handle === a3.handle && c1.targets[0].platform === 'instagram' && c1.targets[0].personaId === pub.id && c1.targets[0].instance === null);
  r = await content(A.token, { targetIds: [b1.id] });
  check('another user\'s account as target → 404 social.not_found', r.status === 404 && r.body.code === 'social.not_found');
  r = await content(A.token, { targetIds: [yt!.id] });
  check('disabled-platform account → 400 platform.disabled', r.status === 400 && r.body.code === 'platform.disabled', `${r.status} ${r.body?.code}`);
  r = await content(T, { ownerId: A.id, targetIds: [b1.id] });
  check('admin creating A\'s content with B\'s account → 400 content.target_not_owner', r.status === 400 && r.body.code === 'content.target_not_owner');
  r = await content(T, { ownerId: A.id, targetIds: [a4.id] });
  const c2 = r.body.content;
  check('admin creating A\'s content with A\'s account', r.status === 201 && c2.userId === A.id && c2.targets[0]?.id === a4.id);
  r = await http('PUT', `/api/contents/${c2.id}`, T, { targetIds: [b1.id] });
  check('admin updating A\'s content with B\'s account → 400', r.status === 400 && r.body.code === 'content.target_not_owner');

  // bulk by persona: the client expands from the account list and sends concrete ids
  const byGroup = ((await http('GET', `/api/social/accounts?personaId=${g.id}&pageSize=200`, A.token)).body.items as any[]).map((x) => x.id);
  const byPersona = ((await http('GET', `/api/social/accounts?personaId=${pub.id}&pageSize=200`, A.token)).body.items as any[]).map((x) => x.id);
  check('persona expansion lists the right accounts (two personas)', byGroup.sort().join() === [a1.id, a2.id].sort().join() && byPersona.join() === a3.id);
  const expanded = [...new Set([...c1.targets.map((x: any) => x.id), ...byGroup, ...byPersona])];
  r = await http('PUT', `/api/contents/${c1.id}`, A.token, { targetIds: expanded });
  check('update targets with the expanded ids', r.status === 200 && r.body.content.targets.length === 3);
  await http('POST', '/api/social/accounts/batch', A.token, { ids: [a4.id], action: 'set-persona', personaId: g.id });
  r = await http('GET', `/api/contents/${c1.id}`, A.token);
  check('targets are concrete ids (giving an account the persona later does not add it)', r.body.content.targets.length === 3 && !r.body.content.targets.some((x: any) => x.id === a4.id));
  r = await http('PUT', `/api/contents/${c1.id}`, A.token, { title: `tg ${tag} renamed` });
  check('update without targetIds keeps targets', r.body.content.targets.length === 3);
  r = await http('GET', `/api/contents?q=${tag}&pageSize=100`, A.token);
  check('list items carry targets', (r.body.items as any[]).find((x) => x.id === c1.id)?.targets.length === 3);

  // RBAC / isolation
  r = await http('GET', `/api/contents/${c1.id}`, B.token);
  const r2 = await http('PUT', `/api/contents/${c1.id}`, B.token, { targetIds: [b1.id] });
  check('another user: content detail / update → 404', r.status === 404 && r2.status === 404);

  // account delete removes it from targets; content delete cascades
  r = await http('DELETE', `/api/social/accounts/${a2.id}`, A.token);
  r = await http('GET', `/api/contents/${c1.id}`, A.token);
  check('deleting an account drops it from targets', r.body.content.targets.length === 2 && !r.body.content.targets.some((x: any) => x.id === a2.id));
  r = await http('PUT', `/api/contents/${c1.id}`, A.token, { targetIds: [] });
  check('clear targets', r.status === 200 && r.body.content.targets.length === 0);
  await http('PUT', `/api/contents/${c1.id}`, A.token, { targetIds: [a1.id] });
  r = await http('DELETE', `/api/contents/${c1.id}`, A.token);
  const left = await db.select().from(schema.contentTargets).where(eq(schema.contentTargets.contentId, c1.id));
  check('content delete cascades to content_targets', r.status === 204 && left.length === 0);

  // ================================================================ 人设禁用词 on contents
  {
    const ban = await persona(A.token, { scope: 'mine', name: `ban ${tag}`, style: { bannedWords: ['最便宜', 'Free'] } });
    const a5 = (await acc(A.token, 'a5', { personaId: ban.id })).body.account;
    const n0 = (await db.select().from(schema.contents).where(eq(schema.contents.userId, A.id))).length;
    r = await content(A.token, { body: '全网最便宜的蛋白粉', targetIds: [a5.id] });
    const r2b = await content(A.token, { body: 'ok', platformHints: { instagram: { caption: 'FREE gift today' } }, targetIds: [a5.id] });
    const r3b = await content(A.token, { title: `免费? Free ${tag}`, body: 'ok', targetIds: [a5.id] });
    const n1 = (await db.select().from(schema.contents).where(eq(schema.contents.userId, A.id))).length;
    check('create: body / caption (case-insensitive) / title with a banned word of a target\'s persona → 400 persona.banned_word, nothing stored',
      r.status === 400 && r.body.code === 'persona.banned_word' && r.body.params?.words === '最便宜' && r.body.params?.persona === `ban ${tag}`
        && r2b.status === 400 && r2b.body.params?.words === 'Free' && r3b.status === 400 && n0 === n1, `${r.status} ${JSON.stringify(r.body)} ${r2b.status} ${r3b.status}`);
    const c3 = (await content(A.token, { body: '今天练腿', targetIds: [a5.id] })).body.content;
    const c4 = (await content(A.token, { body: '全网最便宜' })).body.content;
    check('clean text with the target, and the banned text without any persona target, are saved', !!c3?.id && !!c4?.id);
    r = await http('PUT', `/api/contents/${c3.id}`, A.token, { body: '今天练腿，最便宜的健身房' });
    const r4b = await http('PUT', `/api/contents/${c4.id}`, A.token, { targetIds: [a5.id] });
    const r5b = await http('PUT', `/api/contents/${c4.id}`, A.token, { stage: 'ready' });
    check('update: banned text → 400; adding a target whose persona bans existing text → 400; a stage-only update passes',
      r.status === 400 && r.body.code === 'persona.banned_word' && r4b.status === 400 && r4b.body.code === 'persona.banned_word' && r5b.status === 200, `${r.status} ${r4b.status} ${r5b.status}`);
    r = await http('PUT', `/api/contents/${c3.id}/translations/en`, A.token, { title: 't', body: 'Free shipping' });
    const r6b = await http('PUT', `/api/contents/${c3.id}/translations/en`, A.token, { title: 't', body: 'Leg day' });
    check('translation with a banned word → 400, clean translation saved', r.status === 400 && r.body.code === 'persona.banned_word' && [200, 201].includes(r6b.status), `${r.status} ${r6b.status}`);
    // an AI draft: its own persona counts even without targets
    const [draft] = await db.insert(schema.contents).values({ userId: A.id, title: `ai ${tag}`, body: 'x', lang: 'zh-CN', stage: 'draft', status: 'draft', platformHints: {},
      aiGenerated: { model: 'm', requestedModel: 'm', personaId: ban.id, personaName: ban.name, taskId: null, generatedAt: new Date().toISOString(), mediaTags: [] } }).returning();
    r = await http('PUT', `/api/contents/${draft!.id}`, A.token, { body: 'AI 写的：最便宜' });
    check('AI draft without targets: its persona\'s banned words apply', r.status === 400 && r.body.code === 'persona.banned_word', `${r.status}`);
    // distribution: a word added to the persona after saving (no per-account texts any more: an older body's caption
    // override is a 400 before any word check)
    const pt0 = (await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.contentId, c3.id))).length;
    r = await http('POST', `/api/contents/${c3.id}/distribute`, A.token, { targets: [{ accountId: a5.id, caption: 'free stuff' }] });
    await http('PATCH', `/api/personas/${ban.id}`, A.token, { style: { bannedWords: ['最便宜', 'Free', '练腿'] } });
    const r7b = await http('POST', `/api/contents/${c3.id}/distribute`, A.token, { targets: [{ accountId: a5.id }] });
    const pt1 = (await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.contentId, c3.id))).length;
    check('distribute: a per-target caption → 400 (strict, not a word check); a word added to the persona after saving → 400 (words 练腿); no publish task',
      r.status === 400 && r.body.code !== 'persona.banned_word' && r7b.status === 400 && r7b.body.params?.words === '练腿' && pt0 === 0 && pt1 === 0, `${r.status} ${r7b.status} ${r7b.text.slice(0, 200)}`);
  }

  // ================================================================ audit
  await sleep(500);
  const acts = await sqlClient`select action, detail from audit_logs where at >= ${startedAt.toISOString()}::timestamptz and (action like 'social.%' or action like 'content.%')`;
  check('audit: account update records personaId', acts.some((x) => x.action === 'social.account_update' && x.detail?.personaId === pub.id));
  check('audit: batch set-persona recorded', acts.some((x) => x.action === 'social.batch.set-persona' && x.detail?.personaId === pub2.id && x.detail?.count === 3));
  check('audit: content update records targetIds', acts.some((x) => x.action === 'content.update' && Array.isArray(x.detail?.targetIds) && x.detail.targetIds.length === 3));
} catch (err) {
  check(`unexpected error: ${(err as Error).stack ?? (err as Error).message}`, false);
} finally {
  for (const id of userIds) {
    await db.delete(schema.contents).where(eq(schema.contents.userId, id));
    await http('DELETE', `/api/users/${id}`, T);
  }
  await db.delete(P).where(and(eq(P.ownerType, 'public'), inArray(P.name, [`健身教练 ${tag}`, `美食 ${tag}`])));
  const leftU = await db.select().from(schema.users).where(inArray(schema.users.id, userIds.length ? userIds : ['00000000-0000-0000-0000-000000000000']));
  check('cleanup: test users (cascading accounts, personas) and public personas removed', leftU.length === 0);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
