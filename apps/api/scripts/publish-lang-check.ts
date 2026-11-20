/**
 * 发文语言 (publishing in the account's language) through the real HTTP API, DB, task centre and media processing.
 * No mocks, no devices (the accounts have none; every task is scheduled a day ahead, so no run starts).
 * - Each target account gets the content's translation in its 账号语言 (title/body/platform caption), else the Chinese
 *   source: account without language, account in the source language, language without a translation (fallback).
 * - publish_tasks.lang records the language of the snapshot; the "distributed" log carries lang/accountLang/langFallback.
 * - No per-account texts (2026-11-19): a target with a caption is a 400, every account gets the content's text in its
 *   language; snapshots don't follow later edits of the translation or the account language.
 * - Older content whose source is not Chinese: an account in that language gets the source, a zh-CN account the
 *   Chinese translation, another language falls back to the source.
 * - 中文原稿可留空 (2026-11-20): empty title → 内部名称 fallback, a translation without a title, an account that would
 *   publish the empty Chinese source while another language has text → 400 publish.text_missing (stories and media-only
 *   contents still go).
 * Usage (from apps/api, API running; default ENABLED_PLATFORMS is enough):
 *   E2E_API=http://127.0.0.1:3000 npx tsx --env-file=../../.env scripts/publish-lang-check.ts
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { db, schema, sqlClient } from '../src/db/index.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http<T = any>(method: string, p: string, token: string, body?: unknown) {
  const res = await fetch(API + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
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
const pw = randomBytes(12).toString('hex');
const userIds: string[] = [];
const ptIds: string[] = [];

try {
  // ---------------------------------------------------------------- setup: user, accounts with languages, one image
  const u = await http('POST', '/api/users', T, { username: `plc-${tag}`, password: pw, role: 'user' });
  const uid: string = u.body.user?.id ?? u.body.id; userIds.push(uid);
  const A = await login(`plc-${tag}`, pw);
  const acc = async (name: string, lang?: string) => {
    const r = await http('POST', '/api/social/accounts', A, { platform: 'instagram', handle: `plc_${tag}_${name}`, ...(lang ? { lang } : {}) });
    if (r.status !== 201) throw new Error(`account ${name}: ${r.status} ${r.text}`);
    return r.body.account as { id: string; handle: string; lang: string | null };
  };
  const en = await acc('en', 'en'); const hi = await acc('hi', 'hi'); const none = await acc('none'); const zh = await acc('zh', 'zh-CN'); const pt = await acc('pt', 'pt-BR');
  const fd = new FormData();
  fd.append('scope', 'mine');
  fd.append('file', new Blob([new Uint8Array(await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 30, g: 90, b: 160 } } }).png().toBuffer())], { type: 'image/png' }), `plc-${tag}.png`);
  const up = await http('POST', '/api/media/upload', A, fd);
  const img: string = up.body.item.id;
  for (let i = 0; i < 180 && (await http('GET', `/api/media/${img}`, A)).body.item.status !== 'ready'; i++) await sleep(500);
  check('setup: 5 accounts (en, hi, none, zh-CN, pt-BR), 1 image ready', [en, hi, none, zh, pt].every((a) => a.id) && (await http('GET', `/api/media/${img}`, A)).body.item.status === 'ready');

  // ---------------------------------------------------------------- content in Chinese + en/hi translations
  const mk = async (title: string) => {
    const r = await http('POST', '/api/contents', A, { title, body: '中文正文', mediaIds: [img], platformHints: { instagram: { caption: '中文IG' } }, stage: 'ready' });
    if (r.status !== 201) throw new Error(`content: ${r.status} ${r.text}`);
    const id: string = r.body.content.id;
    await http('PUT', `/api/contents/${id}/translations/en`, A, { title: 'EN title', body: 'EN body', platformHints: { instagram: { caption: 'EN IG caption' } } });
    await http('PUT', `/api/contents/${id}/translations/hi`, A, { title: 'HI title', body: 'HI body' });
    return id;
  };
  const c1 = await mk(`plc-${tag} one`);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  let r = await http('POST', `/api/contents/${c1}/distribute`, A, { targets: [en, hi, none, zh, pt].map((a) => ({ accountId: a.id, scheduledAt: tomorrow })) });
  const created = (r.body.created ?? []) as any[];
  created.forEach((x) => ptIds.push(x.id));
  const byAcc = (id: string) => created.find((x) => x.accountId === id);
  check('distribute: 5 tasks scheduled', r.status === 201 && created.length === 5 && created.every((x) => x.status === 'scheduled'), r.text.slice(0, 200));
  check('en account → English translation (its Instagram caption), lang en', byAcc(en.id)?.lang === 'en' && byAcc(en.id)?.caption === 'EN IG caption', JSON.stringify(byAcc(en.id)));
  check('hi account → Hindi translation (body: no Instagram caption in that language), lang hi', byAcc(hi.id)?.lang === 'hi' && byAcc(hi.id)?.caption === 'HI body', JSON.stringify(byAcc(hi.id)));
  check('account without language → Chinese source, lang zh-CN', byAcc(none.id)?.lang === 'zh-CN' && byAcc(none.id)?.caption === '中文IG');
  check('zh-CN account → Chinese source, lang zh-CN', byAcc(zh.id)?.lang === 'zh-CN' && byAcc(zh.id)?.caption === '中文IG');
  check('pt-BR account without a pt-BR translation → falls back to the Chinese source (not refused), lang zh-CN', byAcc(pt.id)?.lang === 'zh-CN' && byAcc(pt.id)?.caption === '中文IG');
  const logs = await db.select().from(schema.publishLogs).where(and(inArray(schema.publishLogs.publishTaskId, created.map((x) => x.id)), eq(schema.publishLogs.message, 'distributed')));
  const logOf = (id: string) => logs.find((l) => l.publishTaskId === byAcc(id)?.id)?.data as any;
  check('distributed log: lang, accountLang and langFallback (translation_missing / account_no_lang / null)',
    logOf(pt.id)?.langFallback === 'translation_missing' && logOf(pt.id)?.accountLang === 'pt-BR' && logOf(none.id)?.langFallback === 'account_no_lang'
    && logOf(en.id)?.langFallback === null && logOf(en.id)?.lang === 'en', JSON.stringify(logs.map((l) => l.data)));
  const detail = await http('GET', `/api/publish/tasks/${byAcc(en.id).id}`, A);
  check('publish task detail returns lang', detail.status === 200 && detail.body.task.lang === 'en');

  // ---------------------------------------------------------------- snapshots don't follow later edits
  await http('PUT', `/api/contents/${c1}/translations/en`, A, { title: 'EN title v2', body: 'EN body v2', platformHints: { instagram: { caption: 'EN IG v2' } } });
  await http('PUT', `/api/social/accounts/${zh.id}`, A, { lang: 'en' });
  const [s1] = await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.id, byAcc(en.id).id));
  const [s2] = await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.id, byAcc(zh.id).id));
  check('snapshot unchanged after editing the translation / the account language', s1?.caption === 'EN IG caption' && s1?.lang === 'en' && s2?.caption === '中文IG' && s2?.lang === 'zh-CN');

  // ---------------------------------------------------------------- no per-account texts (owner 2026-11-19)
  const c2 = await mk(`plc-${tag} two`);
  r = await http('POST', `/api/contents/${c2}/distribute`, A, { targets: [{ accountId: en.id, caption: 'hand-written for en', scheduledAt: tomorrow }, { accountId: hi.id, scheduledAt: tomorrow }] });
  check('a per-account caption in a target → 400 (strict), nothing created', r.status === 400
    && (await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.contentId, c2))).length === 0, r.text.slice(0, 160));
  r = await http('POST', `/api/contents/${c2}/distribute`, A, { targets: [{ accountId: en.id, scheduledAt: tomorrow }, { accountId: hi.id, scheduledAt: tomorrow }] });
  const c2t = (r.body.created ?? []) as any[];
  c2t.forEach((x) => ptIds.push(x.id));
  const o1 = c2t.find((x) => x.accountId === en.id); const o2 = c2t.find((x) => x.accountId === hi.id);
  check("every account gets the content's text in its language (en translation, Hindi translation)", o1?.caption === 'EN IG caption' && o1?.lang === 'en' && o2?.caption === 'HI body' && o2?.lang === 'hi',
    JSON.stringify([o1, o2].map((x) => x && { c: x.caption, l: x.lang })));

  // ---------------------------------------------------------------- 中文原稿可留空 (owner 2026-11-20)
  r = await http('POST', '/api/contents', A, { title: '', body: '', mediaIds: [img], stage: 'ready' });
  const c3: string = r.body.content?.id;
  check('a content without title and Chinese text is created (内部名称 fallback 未命名内容)', r.status === 201 && r.body.content.title === '未命名内容', r.text.slice(0, 160));
  r = await http('PUT', `/api/contents/${c3}/translations/en`, A, { body: 'Only English' });
  check('a translation without a title is saved (title "")', r.status === 201 && r.body.translation.title === '', r.text.slice(0, 160));
  r = await http('POST', `/api/contents/${c3}/distribute`, A, { targets: [{ accountId: en.id, scheduledAt: tomorrow }] });
  (r.body.created ?? []).forEach((x: any) => ptIds.push(x.id));
  const c3en = (r.body.created ?? [])[0];
  check('en account → English text (lang en)', r.status === 201 && c3en?.caption === 'Only English' && c3en?.lang === 'en', r.text.slice(0, 200));
  const zh3 = await acc('zh3', 'zh-CN'); // `zh` was switched to en above
  for (const [name, a] of [['zh-CN account', zh3], ['account without language', none], ['pt-BR account (no translation)', pt]] as const) {
    r = await http('POST', `/api/contents/${c3}/distribute`, A, { targets: [{ accountId: a.id, scheduledAt: tomorrow }] });
    check(`${name} with an empty Chinese source → 400 publish.text_missing, nothing created`, r.status === 400 && r.body?.code === 'publish.text_missing' && r.body?.params?.account === a.handle,
      `${r.status} ${r.text.slice(0, 160)}`);
  }
  r = await http('POST', `/api/contents/${c3}/distribute`, A, { targets: [{ accountId: hi.id, scheduledAt: tomorrow, postType: 'story' }] });
  (r.body.created ?? []).forEach((x: any) => ptIds.push(x.id));
  check('a story (no caption) to the hi account still goes', r.status === 201, r.text.slice(0, 160));
  r = await http('POST', '/api/contents', A, { title: 'media only', mediaIds: [img], stage: 'ready' });
  const c4: string = r.body.content?.id;
  r = await http('POST', `/api/contents/${c4}/distribute`, A, { targets: [{ accountId: none.id, scheduledAt: tomorrow }] });
  (r.body.created ?? []).forEach((x: any) => ptIds.push(x.id));
  check('a content without any text anywhere (media only) still publishes', r.status === 201, r.text.slice(0, 160));
  r = await http('PUT', `/api/contents/${c4}`, A, { title: '', body: 'First line\nsecond' });
  check('PUT with an empty title → name from the first line', r.status === 200 && r.body.content.title === 'First line', r.text.slice(0, 160));

  // ---------------------------------------------------------------- older content with an English source
  const [old] = await db.insert(schema.contents).values({ userId: uid, title: `plc-${tag} old`, body: 'English source body', lang: 'en', stage: 'ready', status: 'ready', platformHints: {} }).returning();
  await http('PUT', `/api/contents/${old!.id}`, A, { mediaIds: [img] });
  await http('PUT', `/api/contents/${old!.id}/translations/zh-CN`, A, { title: '中文版', body: '中文译文正文' });
  const enNow = await acc('en2', 'en'); const zhNow = await acc('zh2', 'zh-CN');
  r = await http('POST', `/api/contents/${old!.id}/distribute`, A, { targets: [enNow, zhNow, hi].map((a) => ({ accountId: a.id, scheduledAt: tomorrow })) });
  const ot = (r.body.created ?? []) as any[];
  ot.forEach((x) => ptIds.push(x.id));
  const oo = (id: string) => ot.find((x) => x.accountId === id);
  check('older English content: en account → source (lang en), zh-CN account → Chinese translation, hi → source fallback',
    oo(enNow.id)?.lang === 'en' && oo(enNow.id)?.caption === 'English source body' && oo(zhNow.id)?.lang === 'zh-CN' && oo(zhNow.id)?.caption === '中文译文正文'
    && oo(hi.id)?.lang === 'en' && oo(hi.id)?.caption === 'English source body', JSON.stringify(ot.map((x) => [x.lang, x.caption])));

  // ---------------------------------------------------------------- old rows: lang null stays readable
  const [legacyRow] = await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.id, byAcc(en.id).id));
  await db.update(schema.publishTasks).set({ lang: null }).where(eq(schema.publishTasks.id, legacyRow!.id));
  const lr = await http('GET', `/api/publish/tasks?contentId=${c1}&limit=10`, A);
  check('tasks from before (lang null) are listed with lang null', lr.status === 200 && lr.body.items.some((x: any) => x.id === legacyRow!.id && x.lang === null));
} catch (err) {
  check('unexpected error', false, (err as Error).stack ?? String(err));
} finally {
  if (ptIds.length) await db.delete(schema.tasks).where(and(eq(schema.tasks.refType, 'publish'), inArray(schema.tasks.refId, ptIds)));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  const left = await db.select({ id: schema.publishTasks.id }).from(schema.publishTasks).where(inArray(schema.publishTasks.id, ptIds.length ? ptIds : ['00000000-0000-0000-0000-000000000000']));
  check('cleanup: user, contents, accounts and publish tasks removed', left.length === 0);
  await sqlClient.end();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
