/**
 * 多语言内容 (content translations) test against the real API and DB. No mocks, no external services
 * (translations are written by people; there is no translation provider).
 * - Language settings: admin-only GET/PUT /api/settings/languages, validation + canonical codes, read by everyone via
 *   GET /api/contents/languages; new contents get the default source language.
 * - Translations CRUD: PUT creates (201) / replaces (200), list + detail include them, DELETE (204, then 404),
 *   same-as-source refused, changing the source language to a translated language refused, text-only hints.
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
const [langRow] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'content.languages'));
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

  // ---------------------------------------------------------------- language settings
  check('settings/languages: user 403', (await http('GET', '/api/settings/languages', A.token)).status === 403);
  check('settings/languages: user PUT 403', (await http('PUT', '/api/settings/languages', A.token, { languages: ['en'], defaultSource: 'en' })).status === 403);
  const bad = await http('PUT', '/api/settings/languages', T, { languages: ['en', 'not a lang!'], defaultSource: 'en' });
  check('settings/languages: invalid code 400', bad.status === 400, bad.text.slice(0, 120));
  const put = await http('PUT', '/api/settings/languages', T, { languages: ['EN', 'hi', 'pt-br', 'en'], defaultSource: 'zh-cn' });
  check('settings/languages: canonical, deduped, default source included',
    put.status === 200 && JSON.stringify(put.body.languages.languages) === JSON.stringify(['zh-CN', 'en', 'hi', 'pt-BR']) && put.body.languages.defaultSource === 'zh-CN',
    JSON.stringify(put.body?.languages));
  const pub = await http('GET', '/api/contents/languages', A.token);
  check('contents/languages readable by users', pub.status === 200 && pub.body.languages.includes('hi') && pub.body.defaultSource === 'zh-CN' && !('updatedAt' in pub.body));

  // ---------------------------------------------------------------- contents with a source language
  const c1 = (await http('POST', '/api/contents', A.token, { title: `trchk ${tag} one`, body: '原文正文' })).body.content;
  contentIds.push(c1.id);
  check('new content gets the default source language', c1.lang === 'zh-CN' && Array.isArray(c1.translations) && c1.translations.length === 0, c1.lang);
  const c2 = (await http('POST', '/api/contents', A.token, { title: `trchk ${tag} two`, lang: 'en' })).body.content;
  contentIds.push(c2.id);
  check('explicit source language kept', c2.lang === 'en');
  const c3 = (await http('POST', '/api/contents', A.token, { title: `trchk ${tag} three`, lang: null })).body.content;
  contentIds.push(c3.id);
  check('source language may be unset (null)', c3.lang === null);

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
  check('translation title required', empty.status === 400);
  const badLang = await http('PUT', `/api/contents/${c1.id}/translations/x_y`, A.token, { title: 'x' });
  check('invalid language code 400', badLang.status === 400);
  const same = await http('PUT', `/api/contents/${c1.id}/translations/zh-cn`, A.token, { title: 'x' });
  check('same as source language refused', same.status === 400 && same.body?.code === 'content.translation_same_lang', same.body?.code);
  const moveSrc = await http('PUT', `/api/contents/${c1.id}`, A.token, { lang: 'hi' });
  check('source language cannot move onto a translated language', moveSrc.status === 409 && moveSrc.body?.code === 'content.lang_has_translation', moveSrc.body?.code);
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
  check('?lang=en → source en + translated en', new Set(fEn.body.items.map((x: any) => x.id)).size === 2 && fEn.body.items.every((x: any) => [c1.id, c2.id].includes(x.id)));
  check('?lang invalid 400', (await lst('&lang=__')).status === 400);

  // delete
  const d1 = await http('DELETE', `/api/contents/${c1.id}/translations/hi`, A.token);
  check('DELETE translation 204', d1.status === 204);
  const d2 = await http('DELETE', `/api/contents/${c1.id}/translations/hi`, A.token);
  check('DELETE again 404 coded', d2.status === 404 && d2.body?.code === 'content.translation_not_found');
  const moved = await http('PUT', `/api/contents/${c1.id}`, A.token, { lang: 'hi' });
  check('source language may move once the version is removed', moved.status === 200 && moved.body.content.lang === 'hi');
  await http('PUT', `/api/contents/${c1.id}`, A.token, { lang: 'zh-CN' });

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
  check('audit: language settings recorded', allAudit.some((a) => a.action === 'settings.languages' && a.status === 200));

  // ---------------------------------------------------------------- cascade
  const before = (await db.select().from(schema.contentTranslations).where(eq(schema.contentTranslations.contentId, c1.id))).length;
  const del = await http('DELETE', `/api/contents/${c1.id}`, A.token);
  const after = (await db.select().from(schema.contentTranslations).where(eq(schema.contentTranslations.contentId, c1.id))).length;
  check('content delete cascades its translations', del.status === 204 && before === 1 && after === 0, `${before} → ${after}`);
} catch (err) {
  check('unexpected error', false, (err as Error).stack ?? String(err));
} finally {
  if (contentIds.length) await db.delete(schema.contents).where(inArray(schema.contents.id, contentIds));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  if (langRow) await db.update(schema.settings).set({ value: langRow.value }).where(eq(schema.settings.key, 'content.languages'));
  else await db.delete(schema.settings).where(eq(schema.settings.key, 'content.languages'));
  await sqlClient.end();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
