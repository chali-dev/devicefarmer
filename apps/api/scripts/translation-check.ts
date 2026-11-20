/**
 * 多语言内容 (content translations) test against the real API and DB. No mocks, no external services
 * (translations are written by people; there is no translation provider).
 * - Language model (2026-11-18): Chinese (zh-CN) is the fixed source; 配置语系 = languages bound to social accounts.
 *   GET /api/contents/languages per viewer (users: own accounts; admins: all or ?ownerId=), the old admin setting
 *   /api/settings/languages is gone (404); new contents are zh-CN, another source
 *   language is refused (content.source_lang_fixed); older contents keep theirs read-only (a missing one may become
 *   zh-CN); personas have no language (style.lang refused, 2026-11-18): AI drafts are Chinese, accounts carry the language.
 * - Translations CRUD: PUT creates (201) / replaces (200), list + detail include them, DELETE (204, then 404),
 *   same-as-source refused, text-only hints.
 * - RBAC/isolation: another user gets 404 on every translation route; admin can manage a user's content.
 * - List: language chips (`translations`) and the `?lang=` filter (source or translation).
 * - Cascade: deleting the content removes its translations.
 * - Audit: translation saves/deletes are recorded with the language only, never the translated text.
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:3114 npx tsx --env-file=../../.env scripts/translation-check.ts
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gte, inArray, like } from 'drizzle-orm';
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

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('hex');
const userIds: string[] = [];
const contentIds: string[] = [];
const personaIds: string[] = [];
const startedAt = new Date();
const SECRET_TEXT = `译文机密-${tag}-नमस्ते`;

try {
  const mk = async (name: string) => {
    const r = await http('POST', '/api/users', T, { username: name, password: pw, role: 'user' });
    const id = r.body.user?.id ?? r.body.id; userIds.push(id);
    return { id, token: await login(name, pw) };
  };
  const A = await mk(`trchk-a-${tag}`);
  const B = await mk(`trchk-b-${tag}`);

  // ---------------------------------------------------------------- language model (zh-CN source + account languages)
  check('settings/languages removed (admin GET/PUT 404)', (await http('GET', '/api/settings/languages', T)).status === 404
    && (await http('PUT', '/api/settings/languages', T, { languages: ['en'], defaultSource: 'en' })).status === 404);
  const accA = await http('POST', '/api/social/accounts', A.token, { platform: 'instagram', handle: `trchk_a_${tag}`, lang: 'EN' });
  const accA2 = await http('POST', '/api/social/accounts', A.token, { platform: 'instagram', handle: `trchk_a2_${tag}`, lang: 'zh-cn' });
  const accB = await http('POST', '/api/social/accounts', B.token, { platform: 'instagram', handle: `trchk_b_${tag}`, lang: 'pt-br' });
  check('account languages canonicalised (EN → en, zh-cn → zh-CN, pt-br → pt-BR)', accA.body.account?.lang === 'en' && accA2.body.account?.lang === 'zh-CN' && accB.body.account?.lang === 'pt-BR',
    `${accA.status} ${accA.body.account?.lang} ${accA2.body.account?.lang} ${accB.body.account?.lang}`);
  const lA = (await http('GET', '/api/contents/languages', A.token)).body;
  check('contents/languages (user): zh-CN source + own accounts\' languages only (not B\'s, not the legacy list)',
    lA.source === 'zh-CN' && JSON.stringify(lA.configured) === JSON.stringify(['en']) && JSON.stringify(lA.languages) === JSON.stringify(['zh-CN', 'en']), JSON.stringify(lA));
  const lAx = (await http('GET', `/api/contents/languages?ownerId=${B.id}`, A.token)).body;
  check('contents/languages: a user cannot ask for another owner (ownerId ignored)', JSON.stringify(lAx.configured) === JSON.stringify(['en']), JSON.stringify(lAx));
  const lT = (await http('GET', '/api/contents/languages', T)).body;
  const lTB = (await http('GET', `/api/contents/languages?ownerId=${B.id}`, T)).body;
  check('contents/languages (admin): all accounts\' languages; ?ownerId → that owner\'s', ['en', 'pt-BR'].every((l) => lT.configured.includes(l)) && !lT.configured.includes('zh-CN')
    && JSON.stringify(lTB.configured) === JSON.stringify(['pt-BR']), `${JSON.stringify(lT.configured)} ${JSON.stringify(lTB.configured)}`);

  // ---------------------------------------------------------------- contents: Chinese source, older ones read-only
  const c1 = (await http('POST', '/api/contents', A.token, { title: `trchk ${tag} one`, body: '原文正文' })).body.content;
  contentIds.push(c1.id);
  check('new content: source zh-CN (not the legacy defaultSource fr)', c1.lang === 'zh-CN' && Array.isArray(c1.translations) && c1.translations.length === 0, c1.lang);
  const cEn = await http('POST', '/api/contents', A.token, { title: `trchk ${tag} en`, lang: 'en' });
  check('another source language on create → 400 content.source_lang_fixed', cEn.status === 400 && cEn.body?.code === 'content.source_lang_fixed', `${cEn.status} ${cEn.body?.code}`);
  const cZh = await http('POST', '/api/contents', A.token, { title: `trchk ${tag} zh`, lang: 'zh-cn' });
  if (cZh.body?.content) contentIds.push(cZh.body.content.id);
  check('explicit zh-CN on create is fine', cZh.status === 201 && cZh.body.content.lang === 'zh-CN');
  // older contents (before 2026-11-18): another source language, or none
  const [c2] = await db.insert(schema.contents).values({ userId: A.id, title: `trchk ${tag} two`, body: 'English source', lang: 'en', stage: 'draft', status: 'draft', platformHints: {} }).returning();
  const [c3] = await db.insert(schema.contents).values({ userId: A.id, title: `trchk ${tag} three`, body: '旧内容', lang: null, stage: 'draft', status: 'draft', platformHints: {} }).returning();
  contentIds.push(c2!.id, c3!.id);
  const keep2 = await http('PUT', `/api/contents/${c2!.id}`, A.token, { title: `trchk ${tag} two`, lang: 'en' });
  const move2 = await http('PUT', `/api/contents/${c2!.id}`, A.token, { lang: 'zh-CN' });
  check('older content keeps its source language: saving it unchanged ok, changing it → 400 content.source_lang_fixed',
    keep2.status === 200 && keep2.body.content.lang === 'en' && move2.status === 400 && move2.body?.code === 'content.source_lang_fixed', `${keep2.status} ${move2.status} ${move2.body?.code}`);
  const zhTr = await http('PUT', `/api/contents/${c2!.id}/translations/zh-CN`, A.token, { title: '中文版', body: '中文正文' });
  check('older English content can get a Chinese translation', zhTr.status === 201);
  const set3 = await http('PUT', `/api/contents/${c3!.id}`, A.token, { lang: 'zh-CN' });
  const bad3 = await http('PUT', `/api/contents/${c1.id}`, A.token, { lang: null });
  check('a content without source language may be declared zh-CN; clearing a source → 400', set3.status === 200 && set3.body.content.lang === 'zh-CN' && bad3.status === 400, `${set3.status} ${bad3.status}`);

  // ---------------------------------------------------------------- personas have no language any more (2026-11-18)
  const pA = await http('POST', '/api/personas', A.token, { name: `trchk persona ${tag}`, scope: 'mine' });
  if (pA.body?.persona) personaIds.push(pA.body.persona.id);
  const langStyle = await http('PATCH', `/api/personas/${pA.body.persona.id}`, A.token, { style: { lang: 'en' } });
  const oldBrief = await http('PUT', `/api/personas/${pA.body.persona.id}/drafts`, A.token, { brief: { lang: 'en' } });
  check('personas carry no language (the account does): style.lang → 400, the old 内容设定 endpoint → 404, AI drafts are always zh-CN',
    pA.status === 201 && langStyle.status === 400 && oldBrief.status === 404 && !('lang' in pA.body.persona.style), `${pA.status} ${langStyle.status} ${oldBrief.status}`);

  // ---------------------------------------------------------------- CRUD
  const p1 = await http('PUT', `/api/contents/${c1.id}/translations/EN`, A.token, {
    title: `English ${SECRET_TEXT}`, body: `Body ${SECRET_TEXT}`, platformHints: { instagram: { caption: `IG ${SECRET_TEXT}` }, youtube: { title: 'YT title' } },
  });
  check('PUT creates a translation (201, canonical lang)', p1.status === 201 && p1.body.translation.lang === 'en' && p1.body.translation.platformHints.instagram.caption.startsWith('IG'), `${p1.status} ${p1.text.slice(0, 120)}`);
  const p2 = await http('PUT', `/api/contents/${c1.id}/translations/en`, A.token, { title: 'English v2' });
  check('PUT replaces (200; omitted body/hints reset)', p2.status === 200 && p2.body.translation.title === 'English v2' && p2.body.translation.body === '' && Object.keys(p2.body.translation.platformHints).length === 0);
  await http('PUT', `/api/contents/${c1.id}/translations/en`, A.token, { title: `English ${SECRET_TEXT}`, body: `Body ${SECRET_TEXT}`, platformHints: { instagram: { caption: `IG ${SECRET_TEXT}` } } });
  const p3 = await http('PUT', `/api/contents/${c1.id}/translations/hi`, A.token, { title: 'हिंदी शीर्षक', body: 'हिंदी पाठ' });
  check('second language', p3.status === 201);
  const rows = await db.select().from(schema.contentTranslations).where(eq(schema.contentTranslations.contentId, c1.id));
  check('one row per (content, lang)', rows.length === 2 && new Set(rows.map((r) => r.lang)).size === 2);
  const privacy = await http('PUT', `/api/contents/${c1.id}/translations/en`, A.token, { title: 'x', platformHints: { youtube: { privacy: 'public' } } });
  check('translation hints are text only (privacy refused)', privacy.status === 400);
  const empty = await http('PUT', `/api/contents/${c1.id}/translations/en`, A.token, { title: '  ' });
  check('an empty translation (no title, no text) → 400', empty.status === 400);
  const noTitle = await http('PUT', `/api/contents/${c1.id}/translations/en`, A.token, { body: `Body ${SECRET_TEXT}` });
  check('translation without a title (text only) → 200, title ""', noTitle.status === 200 && noTitle.body.translation.title === '', `${noTitle.status} ${noTitle.text.slice(0, 120)}`);
  await http('PUT', `/api/contents/${c1.id}/translations/en`, A.token, { title: `English ${SECRET_TEXT}`, body: `Body ${SECRET_TEXT}`, platformHints: { instagram: { caption: `IG ${SECRET_TEXT}` } } });
  const badLang = await http('PUT', `/api/contents/${c1.id}/translations/x_y`, A.token, { title: 'x' });
  check('invalid language code 400', badLang.status === 400);
  const same = await http('PUT', `/api/contents/${c1.id}/translations/zh-cn`, A.token, { title: 'x' });
  check('same as source language refused', same.status === 400 && same.body?.code === 'content.translation_same_lang', same.body?.code);
  const unchanged = await http('PUT', `/api/contents/${c1.id}`, A.token, { lang: 'zh-CN', title: `trchk ${tag} one` });
  check('saving with the same source language is fine', unchanged.status === 200 && unchanged.body.content.lang === 'zh-CN');

  const detail = await http('GET', `/api/contents/${c1.id}`, A.token);
  check('detail includes translations (sorted)', detail.status === 200 && detail.body.translations.map((x: any) => x.lang).join(',') === 'en,hi' && detail.body.content.translations.join(',') === 'en,hi');
  const list = await http('GET', `/api/contents/${c1.id}/translations`, A.token);
  check('GET translations', list.status === 200 && list.body.translations.length === 2 && !('contentId' in list.body.translations[0]) && !('id' in list.body.translations[0]));

  // list chips + filter
  const lst = (q: string, tok = A.token) => http('GET', `/api/contents?q=${encodeURIComponent(`trchk ${tag}`)}${q}`, tok);
  const all = await lst('');
  check('list items carry translation languages', all.body.items.find((x: any) => x.id === c1.id)?.translations.join(',') === 'en,hi');
  const fHi = await lst('&lang=hi');
  check('?lang=hi → content with a Hindi version only', fHi.body.items.map((x: any) => x.id).join() === c1.id, fHi.body.items.map((x: any) => x.title).join());
  const fEn = await lst('&lang=EN');
  check('?lang=en → source en (older content) + translated en', new Set(fEn.body.items.map((x: any) => x.id)).size === 2 && fEn.body.items.every((x: any) => [c1.id, c2!.id].includes(x.id)));
  check('?lang invalid 400', (await lst('&lang=__')).status === 400);

  // delete
  const d1 = await http('DELETE', `/api/contents/${c1.id}/translations/hi`, A.token);
  check('DELETE translation 204', d1.status === 204);
  const d2 = await http('DELETE', `/api/contents/${c1.id}/translations/hi`, A.token);
  check('DELETE again 404 coded', d2.status === 404 && d2.body?.code === 'content.translation_not_found');

  // ---------------------------------------------------------------- RBAC / isolation
  const routes: [string, string, unknown?][] = [
    ['GET', `/api/contents/${c1.id}/translations`],
    ['PUT', `/api/contents/${c1.id}/translations/fr`, { title: 'x' }],
    ['DELETE', `/api/contents/${c1.id}/translations/en`],
  ];
  const codes = await Promise.all(routes.map(([m, p, b]) => http(m, p, B.token, b).then((r) => r.status)));
  check('other user: 404 on every translation route', codes.every((s) => s === 404), codes.join(','));
  check('other user: nothing written', (await db.select().from(schema.contentTranslations).where(eq(schema.contentTranslations.lang, 'fr'))).length === 0);
  check('other user: no chips leak through the list', !(await http('GET', `/api/contents?lang=en&q=${encodeURIComponent(`trchk ${tag}`)}`, B.token)).body.items.length);
  const adm = await http('PUT', `/api/contents/${c1.id}/translations/pt-BR`, T, { title: 'Português' });
  check('admin manages a user\'s translations', adm.status === 201);
  check('admin delete', (await http('DELETE', `/api/contents/${c1.id}/translations/pt-BR`, T)).status === 204);

  // ---------------------------------------------------------------- audit: language only, no texts
  await sleep(500);
  const audit = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, startedAt), like(schema.auditLogs.action, 'content.translation_%')));
  check('audit: translation saves and deletes recorded', audit.some((a) => a.action === 'content.translation_save') && audit.some((a) => a.action === 'content.translation_delete'), `${audit.length} entries`);
  const allAudit = await db.select().from(schema.auditLogs).where(gte(schema.auditLogs.at, startedAt));
  check('audit: translated text never stored', !JSON.stringify(allAudit).includes(SECRET_TEXT) && !JSON.stringify(allAudit).includes('हिंदी'));
  check('audit: translation detail is the language only', audit.every((a) => Object.keys(a.detail as object).every((k) => k === 'lang' || k === 'error')), JSON.stringify(audit[0]?.detail));

  // ---------------------------------------------------------------- cascade
  const before = (await db.select().from(schema.contentTranslations).where(eq(schema.contentTranslations.contentId, c1.id))).length;
  const del = await http('DELETE', `/api/contents/${c1.id}`, A.token);
  const after = (await db.select().from(schema.contentTranslations).where(eq(schema.contentTranslations.contentId, c1.id))).length;
  check('content delete cascades its translations', del.status === 204 && before === 1 && after === 0, `${before} → ${after}`);
} catch (err) {
  check('unexpected error', false, (err as Error).stack ?? String(err));
} finally {
  if (contentIds.length) await db.delete(schema.contents).where(inArray(schema.contents.id, contentIds));
  if (personaIds.length) await db.delete(schema.personas).where(inArray(schema.personas.id, personaIds));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  await sqlClient.end();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
