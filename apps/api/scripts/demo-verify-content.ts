/**
 * Verifies 内容中心 (素材库 / 话术库 / 内容管理 / 趋势热点 scope) against the demo data of demo-seed-content.ts,
 * through the real HTTP API, as admin and as demo-user. Read-mostly: writes only go to throw-away items
 * named `demo-tmp-<hex>` that are deleted at the end. Never distributes/publishes, never touches devices.
 * One exception, stated in the output: the in-use protection needs an unfinished task referencing the asset,
 * which needs a device or a publish task; a `running` push-asset fixture row (no BullMQ job, no device) is
 * inserted directly in the DB for a throw-away asset and removed right after.
 * Usage (from apps/api, API running, after the seed): npx tsx --env-file=../../.env scripts/demo-verify-content.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { db, schema, sqlClient } from '../src/db/index.js';
import { ACCOUNT_LANGS, CATEGORIES, CONTENT_CATEGORIES, CONTENTS, FAVORITES, MEDIA, PERSONAS, PUBLISHES, TARGETS, TEMPLATES, http, listAll, login, mediaName, readCredentials } from './demo-seed-content.js';

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };
const tmp = `demo-tmp-${randomBytes(3).toString('hex')}`;
const sorted = (xs: string[]) => [...xs].sort().join('|');
const eqSet = (a: string[], b: string[]) => sorted(a) === sorted(b);

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const creds = readCredentials();
if (!creds) { console.error('✗ var/demo-credentials.txt missing: run demo-seed-content.ts first'); process.exit(1); }
const U = await login(creds.username, creds.password);
const me = (await http('GET', '/api/auth/me', U)).body;
const userId: string = me?.user?.id ?? me?.id;
const adminMe = (await http('GET', '/api/auth/me', T)).body;
const adminId: string = adminMe?.user?.id ?? adminMe?.id;

const cleanup: (() => Promise<unknown>)[] = [];
async function upload(token: string, scope: string, file: string, data: Buffer, mime: string, categoryId?: string) {
  const fd = new FormData();
  fd.append('scope', scope);
  if (categoryId) fd.append('categoryId', categoryId);
  fd.append('file', new Blob([new Uint8Array(data)], { type: mime }), file);
  const r = await http('POST', '/api/media/upload', token, fd);
  { const mid = r.body?.item?.id; if (mid) cleanup.push(() => http('DELETE', `/api/media/${mid}`, T)); }
  return r;
}
async function waitReady(token: string, id: string) {
  for (let i = 0; i < 240; i++) {
    const r = await http('GET', `/api/media/${id}`, token);
    if (r.status === 200 && r.body.item.status !== 'processing') return r.body.item;
    await new Promise((res) => setTimeout(res, 500));
  }
  return null;
}
const jpeg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#3388cc' } }).jpeg().toBuffer();

try {
  // ======================================================================== 素材库
  console.log('\n— 素材库');
  const pubAdmin = await listAll(T, '/api/media?scope=public&q=demo-');
  const pubUser = await listAll(U, '/api/media?scope=public&q=demo-');
  const mineAdmin = await listAll(T, '/api/media?scope=mine&q=demo-');
  const mineUser = await listAll(U, '/api/media?scope=mine&q=demo-');
  const byName = new Map<string, any>([...pubAdmin, ...mineAdmin, ...mineUser].map((x) => [x.name, x]));
  const spec = (o: string) => MEDIA.filter((m) => m.owner === o);
  const names = (xs: any[]) => xs.map((x) => x.name).filter((n: string) => MEDIA.some((m) => mediaName(m) === n));

  check('admin public scope: all 11 public demo assets (incl. disabled)', eqSet(names(pubAdmin), spec('public').map(mediaName)), sorted(names(pubAdmin)));
  check('demo-user public scope: 10 ready ones, disabled 旧版LOGO hidden', eqSet(names(pubUser), spec('public').filter((m) => !m.disabled).map(mediaName)), sorted(names(pubUser)));
  check('admin mine: only admin private demo assets', eqSet(names(mineAdmin), spec('admin').map(mediaName)));
  check('demo-user mine: only own private demo assets', eqSet(names(mineUser), spec('user').map(mediaName)) && mineUser.every((x) => x.ownerId === userId));

  // processing results
  const all = MEDIA.map((m) => ({ m, it: byName.get(mediaName(m)) }));
  const notReady = all.filter(({ m, it }) => !it || it.status !== (m.disabled ? 'disabled' : 'ready'));
  check('processing finished: every asset ready (旧版LOGO disabled)', notReady.length === 0, notReady.map(({ m, it }) => `${m.file}:${it?.status}`).join(','));
  const dimsBad = all.filter(({ m, it }) => it && (it.width !== m.w || it.height !== m.h));
  check('metadata: width/height match the generated files (images + videos)', dimsBad.length === 0, dimsBad.map(({ m, it }) => `${m.file} ${it.width}x${it.height}≠${m.w}x${m.h}`).join(','));
  const durBad = all.filter(({ m, it }) => m.secs && !(Math.abs(Number(it?.duration) - m.secs) < 0.6));
  check('metadata: video duration ≈ clip length', durBad.length === 0, durBad.map(({ m, it }) => `${m.file} ${it?.duration}`).join(','));
  check('file type image/video detected', all.every(({ m, it }) => it?.fileType === (m.secs ? 'video' : 'image')));
  let thumbsOk = true; let thumbDetail = '';
  for (const { m, it } of all) {
    const tk = m.owner === 'user' ? U : T;
    const res = await fetch(`${process.env.E2E_API ?? 'http://127.0.0.1:3000'}${it.thumbnailUrl}`, { headers: { authorization: `Bearer ${tk}` } });
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200 || res.headers.get('content-type') !== 'image/jpeg' || buf[0] !== 0xff || buf[1] !== 0xd8) { thumbsOk = false; thumbDetail += `${m.file}:${res.status} `; }
  }
  check('thumbnail/cover JPEG served for every asset (videos too)', thumbsOk, thumbDetail);
  const c0 = await fetch(`${process.env.E2E_API ?? 'http://127.0.0.1:3000'}/api/media/${byName.get('demo-开箱短片').id}/content`, { headers: { authorization: `Bearer ${U}` } });
  check('content download of a public video as demo-user: 200 video/mp4 + nosniff', c0.status === 200 && c0.headers.get('content-type') === 'video/mp4' && c0.headers.get('x-content-type-options') === 'nosniff');
  await c0.arrayBuffer();

  // RBAC
  const adminPriv = byName.get('demo-admin-草图-01'); const disabled = byName.get('demo-旧版LOGO'); const userPriv = byName.get('demo-user-自拍-01');
  const pubImg = byName.get('demo-咖啡新品-方图');
  let r = await http('GET', `/api/media/${adminPriv.id}`, U);
  check('demo-user GET admin private asset → 404', r.status === 404 && r.body.code === 'media.not_found');
  r = await http('GET', `/api/media/${disabled.id}`, U);
  check('demo-user GET disabled public asset → 404', r.status === 404);
  r = await http('GET', `/api/media/${userPriv.id}`, T);
  check('admin GET demo-user private asset → 200 (canManage)', r.status === 200 && r.body.item.canManage === true);
  r = await http('GET', '/api/media?scope=all-users', U);
  check('demo-user scope=all-users → 403 media.admin_only', r.status === 403 && r.body.code === 'media.admin_only');
  const allUsers = await listAll(T, `/api/media?scope=all-users&ownerId=${userId}`);
  check('admin all-users&ownerId=demo-user → exactly demo-user private assets', eqSet(names(allUsers), spec('user').map(mediaName)));
  r = await upload(U, 'public', `${tmp}-x.jpg`, await jpeg(64, 64), 'image/jpeg');
  check('demo-user upload scope=public → 403 media.public_admin_only', r.status === 403 && r.body.code === 'media.public_admin_only');
  r = await http('PUT', `/api/media/${pubImg.id}`, U, { name: 'hijack' });
  const rDel = await http('DELETE', `/api/media/${pubImg.id}`, U);
  check('demo-user PUT/DELETE public asset → 403', r.status === 403 && rDel.status === 403);
  r = await http('PUT', `/api/media/${adminPriv.id}`, U, { name: 'hijack' });
  check('demo-user PUT admin private asset → 404', r.status === 404);
  r = await http('POST', '/api/media/categories', U, { scope: 'public', name: `${tmp} cat` });
  check('demo-user create public category → 403', r.status === 403);
  check('canManage flags: user false on public, true on own', pubUser.every((x) => x.canManage === false) && mineUser.every((x) => x.canManage === true));
  r = await http('GET', `/api/media/categories?scope=mine&ownerId=${adminId}`, U);
  check('demo-user reading admin categories → 403', r.status === 403);

  // filters / search / pagination
  const vids = await listAll(T, '/api/media?scope=public&q=demo-&type=video');
  check('filter type=video (public): 圣诞倒计时 + 开箱短片', eqSet(names(vids), ['demo-圣诞倒计时', 'demo-开箱短片']));
  const pubCats = (await http('GET', '/api/media/categories?scope=public', T)).body.categories as any[];
  const prodCat = pubCats.find((c) => c.name === 'demo 产品图');
  const inProd = await listAll(T, `/api/media?scope=public&categoryId=${prodCat.id}`);
  const wantProd = spec('public').filter((m) => m.category === 'demo 产品图').map(mediaName);
  check('filter categoryId (demo 产品图) → 5 assets', eqSet(names(inProd), wantProd), sorted(names(inProd)));
  check('category count on GET /api/media/categories matches (admin view)', prodCat.count === wantProd.length, String(prodCat.count));
  const uPubCats = (await http('GET', '/api/media/categories?scope=public', U)).body.categories as any[];
  check('category count matches (demo-user view)', uPubCats.find((c) => c.name === 'demo 产品图')?.count === wantProd.length, String(uPubCats.find((c) => c.name === 'demo 产品图')?.count));
  const none = await listAll(T, '/api/media?scope=public&q=demo-&categoryId=none');
  check('filter categoryId=none → 旧版LOGO (uncategorized)', eqSet(names(none), ['demo-旧版LOGO']));
  const promoUpper = await listAll(U, '/api/media?scope=public&q=demo-&tag=PROMO');
  check('tag filter case-insensitive (PROMO → Promo/promo)', eqSet(names(promoUpper), ['demo-双十一海报', 'demo-圣诞倒计时']), sorted(names(promoUpper)));
  const two = await listAll(T, `/api/media?scope=public&tags=${encodeURIComponent('coffee,新品')}`);
  check('tags=coffee,新品 requires all tags → 1', eqSet(names(two), ['demo-咖啡新品-方图']));
  const qTag = await listAll(U, '/api/media?scope=mine&q=GYM');
  check('q matches a tag name too (q=GYM → 健身打卡)', eqSet(names(qTag), ['demo-user-健身打卡']));
  const qName = await listAll(T, `/api/media?scope=public&q=${encodeURIComponent('咖啡')}`);
  check('q matches the name (咖啡 → 2)', eqSet(names(qName), ['demo-咖啡新品-方图', 'demo-咖啡新品-竖图']));
  const pages: string[] = []; let total = 0;
  for (let p = 1; p <= 3; p++) {
    const x = (await http('GET', `/api/media?scope=public&q=demo-&pageSize=4&page=${p}`, U)).body;
    total = x.total; pages.push(...x.items.map((i: any) => i.id));
  }
  check('pagination pageSize=4 over 3 pages: total 10, 10 distinct ids, no overlap', total === 10 && pages.length === 10 && new Set(pages).size === 10, `${total}/${pages.length}`);
  r = await http('GET', '/api/media?scope=public&q=demo-&pageSize=4&page=9', U);
  check('page past the end → empty items, same total', r.status === 200 && r.body.items.length === 0 && r.body.total === 10);
  r = await http('GET', '/api/media?scope=public&pageSize=101', U);
  check('pageSize > 100 → 400', r.status === 400);
  const tagSug = (await http('GET', '/api/media/tags?scope=public', U)).body.tags as string[];
  check('tag suggestions (user, public) contain demo tags but not admin-private/disabled-only ones', tagSug.includes('christmas') && !tagSug.includes('archive') && !tagSug.includes('draft'), tagSug.filter((t) => ['archive', 'draft', 'christmas'].includes(t)).join(','));

  // favorites
  const favU = await listAll(U, '/api/media?scope=favorites');
  check('demo-user favorites = the 4 seeded', eqSet(names(favU), FAVORITES.user.map((f) => f.replace(/\.[^.]+$/, ''))), sorted(names(favU)));
  const favA = await listAll(T, '/api/media?scope=favorites');
  check('admin favorites are separate (2)', eqSet(names(favA), FAVORITES.admin.map((f) => f.replace(/\.[^.]+$/, ''))));
  check('isFavorite flag per viewer', pubUser.find((x) => x.name === 'demo-海边日落')?.isFavorite === true && pubAdmin.find((x) => x.name === 'demo-海边日落')?.isFavorite === false);
  r = await http('POST', `/api/media/${userPriv.id}/favorite`, U);
  check('favorite a private asset → 400 media.favorite_public_only', r.status === 400 && r.body.code === 'media.favorite_public_only');
  const tf = byName.get('demo-城市夜景');
  r = await http('POST', `/api/media/${tf.id}/favorite`, U);
  const r2 = await http('POST', `/api/media/${tf.id}/favorite`, U);
  const favMid = await listAll(U, '/api/media?scope=favorites');
  await http('DELETE', `/api/media/${tf.id}/favorite`, U);
  const favAfter = await listAll(U, '/api/media?scope=favorites');
  check('favorite toggle: add (idempotent) → listed, remove → gone', r.status === 200 && r2.status === 200 && favMid.some((x) => x.id === tf.id) && !favAfter.some((x) => x.id === tf.id));
  await http('PUT', `/api/media/${disabled.id}`, T, { status: 'ready' });
  await http('POST', `/api/media/${disabled.id}/favorite`, U);
  await http('PUT', `/api/media/${disabled.id}`, T, { status: 'disabled' });
  const favDis = await listAll(U, '/api/media?scope=favorites');
  await http('DELETE', `/api/media/${disabled.id}/favorite`, U);
  check('a favorite that gets disabled disappears from the user\'s favorites', !favDis.some((x) => x.id === disabled.id));

  // edit / disable / delete on throw-away assets
  const myCats = (await http('GET', '/api/media/categories?scope=mine', U)).body.categories as any[];
  const myCat = myCats.find((c) => c.name === 'demo 我的拍摄');
  r = await upload(U, 'mine', `${tmp}-edit.jpg`, await jpeg(640, 480), 'image/jpeg');
  const e1 = r.body.item;
  check('upload returns 201 processing', r.status === 201 && e1.status === 'processing');
  const e1r = await waitReady(U, e1.id);
  check('throw-away upload processed (ready, 640x480, thumbnail)', e1r?.status === 'ready' && e1r.width === 640 && e1r.height === 480 && !!e1r.thumbnailUrl);
  r = await http('PUT', `/api/media/${e1.id}`, U, { name: `${tmp} renamed`, categoryId: myCat.id, tags: ['Alpha', 'alpha', 'Beta'] });
  const g = (await http('GET', `/api/media/${e1.id}`, U)).body.item;
  check('edit name/category/tags persists; tags deduped case-insensitively', r.status === 200 && g.name === `${tmp} renamed` && g.categoryId === myCat.id && g.tags.length === 2, JSON.stringify(g?.tags));
  r = await http('PUT', `/api/media/${e1.id}`, U, { categoryId: prodCat.id });
  check('assigning a public category to a private asset → 400 media.category_mismatch', r.status === 400 && r.body.code === 'media.category_mismatch');
  r = await http('PUT', `/api/media/${e1.id}`, U, { status: 'disabled' });
  check('disable a private asset → 400 media.status_public_only', r.status === 400 && r.body.code === 'media.status_public_only');
  r = await http('PUT', `/api/media/${e1.id}`, U, {});
  check('empty update → 400 common.nothing_to_update', r.status === 400 && r.body.code === 'common.nothing_to_update');
  r = await http('DELETE', `/api/media/${e1.id}`, U);
  const gone = await http('GET', `/api/media/${e1.id}`, U);
  check('delete own asset → 204, then 404', r.status === 204 && gone.status === 404);

  r = await upload(T, 'public', `${tmp}-pub.png`, await sharp({ create: { width: 300, height: 200, channels: 3, background: '#aa3344' } }).png().toBuffer(), 'image/png');
  const p1 = r.body.item; await waitReady(T, p1.id);
  r = await http('PUT', `/api/media/${p1.id}`, T, { status: 'disabled' });
  const seenDis = await http('GET', `/api/media/${p1.id}`, U);
  await http('PUT', `/api/media/${p1.id}`, T, { status: 'ready' });
  const seenEn = await http('GET', `/api/media/${p1.id}`, U);
  check('admin disable → user 404; re-enable → user 200', r.status === 200 && seenDis.status === 404 && seenEn.status === 200);
  r = await upload(T, 'mine', `${tmp}-b1.jpg`, await jpeg(100, 100), 'image/jpeg');
  const b1 = r.body.item; await waitReady(T, b1.id);
  r = await http('POST', '/api/media/batch-delete', U, { ids: [p1.id, b1.id] });
  check('batch delete as user: public → 403, admin-private → 404, per id', r.status === 200 && r.body.deleted === 0 && r.body.results.find((x: any) => x.id === p1.id)?.status === 403 && r.body.results.find((x: any) => x.id === b1.id)?.status === 404);
  r = await http('POST', '/api/media/batch-delete', T, { ids: [p1.id, b1.id] });
  check('batch delete as admin → both deleted', r.body.deleted === 2);

  // validation
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).png().toBuffer();
  r = await upload(U, 'mine', `${tmp}-fake.jpg`, png, 'image/jpeg');
  check('PNG bytes named .jpg → 415 media.content_mismatch', r.status === 415 && r.body.code === 'media.content_mismatch', `${r.status} ${r.body?.code}`);
  r = await upload(U, 'mine', `${tmp}-x.jpg`, await jpeg(10, 10), 'video/mp4');
  check('MIME vs extension mismatch → 415 media.mime_mismatch', r.status === 415 && r.body.code === 'media.mime_mismatch');
  r = await upload(U, 'mine', `${tmp}-x.txt`, Buffer.from('hello'), 'text/plain');
  check('unsupported type (.txt) → rejected 4xx', r.status >= 400 && r.status < 500, `${r.status} ${r.body?.code}`);
  r = await upload(U, 'mine', `${tmp}-x.jpg`, await jpeg(10, 10), 'image/jpeg', prodCat.id);
  check('upload with a category of another scope → 400 media.category_mismatch', r.status === 400 && r.body.code === 'media.category_mismatch');

  // categories CRUD
  r = await http('POST', '/api/media/categories', U, { scope: 'mine', name: `${tmp} 分类`, description: 'demo: 说明' });
  const cat = r.body.category;
  const dup = await http('POST', '/api/media/categories', U, { scope: 'mine', name: `${tmp} 分类`.toUpperCase() });
  const ren = await http('PATCH', `/api/media/categories/${cat?.id}`, U, { name: `${tmp} 分类2` });
  r = await upload(U, 'mine', `${tmp}-incat.jpg`, await jpeg(50, 50), 'image/jpeg', cat?.id);
  const inCat = r.body.item; await waitReady(U, inCat.id);
  const dc = await http('DELETE', `/api/media/categories/${cat?.id}`, U);
  const afterCat = (await http('GET', `/api/media/${inCat.id}`, U)).body.item;
  check('category: create 201 (with description), case-variant duplicate 409, rename 200, delete 204 → asset uncategorized', cat?.description === 'demo: 说明' && dup.status === 409 && ren.status === 200 && dc.status === 204 && afterCat.categoryId === null);
  const otherDel = await http('DELETE', `/api/media/categories/${prodCat.id}`, U);
  check('user deleting a public category → 403', otherDel.status === 403);

  // in-use protection (fixture row, see header)
  const [fx] = await db.insert(schema.tasks).values({ type: 'push-asset', status: 'running', createdBy: userId, refType: 'media', refId: inCat.id, instanceName: `${tmp} in-use fixture`, payload: {}, startedAt: new Date() }).returning();
  try {
    r = await http('DELETE', `/api/media/${inCat.id}`, U);
    check('in-use: asset referenced by an unfinished push-asset task → 409 media.in_use (DB fixture task, no device)', r.status === 409 && r.body.code === 'media.in_use', `${r.status} ${r.text.slice(0, 120)}`);
  } finally { await db.delete(schema.tasks).where(eq(schema.tasks.id, fx!.id)); }
  r = await http('DELETE', `/api/media/${inCat.id}`, U);
  check('after the task is gone the delete succeeds', r.status === 204);

  // ======================================================================== 话术库
  console.log('\n— 话术库');
  const tplNames = (xs: any[]) => xs.map((x) => x.name).filter((n: string) => TEMPLATES.some((t) => t.name === n));
  const tl = async (tk: string, q: string) => (await http('GET', `/api/comment-templates?${q}`, tk)).body.templates as any[];
  const uAll = await tl(U, 'kind=all&q=demo');
  check('demo-user kind=all: own (5) + shared (5), not admin private', eqSet(tplNames(uAll), TEMPLATES.filter((t) => t.owner !== 'admin').map((t) => t.name)), sorted(tplNames(uAll)));
  const aAll = await tl(T, 'kind=all&q=demo');
  check('admin kind=all sees all 12 incl. demo-user\'s (ownerName demo-user)', eqSet(tplNames(aAll), TEMPLATES.map((t) => t.name)) && aAll.find((x) => x.name === 'demo user 健身日常')?.ownerName === 'demo-user');
  const uDefault = await tl(U, 'q=demo');
  check('default list (reply composer) = comment templates only', eqSet(tplNames(uDefault), TEMPLATES.filter((t) => t.owner !== 'admin' && t.kind === 'comment').map((t) => t.name)));
  const uPost = await tl(U, 'kind=post&q=demo');
  check('kind=post for demo-user → 3 shared + 3 own', eqSet(tplNames(uPost), TEMPLATES.filter((t) => t.owner !== 'admin' && t.kind === 'post').map((t) => t.name)));
  const uPub = (await http('GET', '/api/personas?scope=public', U)).body.personas as any[];
  const uMine = (await http('GET', '/api/personas?scope=mine', U)).body.personas as any[];
  const pid = (xs: any[], name: string) => xs.find((x) => x.name === name)?.id as string | undefined;
  check('personas: demo-user sees the public ones (read-only) + own, not admin\'s 客服主管',
    PERSONAS.filter((x) => x.owner === 'public').every((x) => uPub.some((y) => y.name === x.name && y.writable === false))
      && eqSet(uMine.map((x) => x.name).filter((n: string) => PERSONAS.some((x) => x.name === n)), PERSONAS.filter((x) => x.owner === 'user').map((x) => x.name))
      && ![...uPub, ...uMine].some((x) => x.name === '客服主管'));
  check('persona counts (demo-user view): 客服小助手 2, 健身教练Max 2', uPub.find((x) => x.name === '客服小助手')?.count === 2 && uMine.find((x) => x.name === '健身教练Max')?.count === 2);
  const pers = await tl(U, `kind=all&personaId=${pid(uMine, '健身教练Max')}`);
  check('persona filter', eqSet(tplNames(pers), ['demo user 健身日常', 'demo user 粉丝互动']));
  const pNone = await tl(U, 'kind=all&personaId=none&q=demo');
  check('personaId=none', eqSet(tplNames(pNone), ['demo user 价格回复']));
  const tagF = await tl(U, 'kind=all&tag=FAQ');
  check('tag filter case-insensitive (FAQ)', eqSet(tplNames(tagF), ['demo 物流咨询回复', 'demo user 价格回复']));
  const sh = await tl(U, 'kind=all&scope=shared&q=demo'); const own = await tl(U, 'kind=all&scope=own&q=demo');
  check('scope shared / own', eqSet(tplNames(sh), TEMPLATES.filter((t) => t.owner === 'shared').map((t) => t.name)) && eqSet(tplNames(own), TEMPLATES.filter((t) => t.owner === 'user').map((t) => t.name)));
  const qt = await tl(U, `kind=all&q=${encodeURIComponent('48 小时')}`);
  check('q searches the text', eqSet(tplNames(qt), ['demo 物流咨询回复']));
  const fac = (await http('GET', '/api/comment-templates/facets?kind=all', U)).body;
  check('facets: tags of visible templates only (no admin-only "complaint")', fac.tags.includes('fitness') && !fac.tags.includes('complaint') && !('personas' in fac));
  const shTpl = aAll.find((x) => x.name === 'demo 新品上市文案'); const adTpl = aAll.find((x) => x.name === 'demo admin 测试草稿');
  check('writable flag: user false on shared, true on own', uAll.find((x) => x.id === shTpl.id)?.writable === false && own.every((x) => x.writable === true));
  r = await http('PUT', `/api/comment-templates/${shTpl.id}`, U, { text: 'x' });
  const rd = await http('DELETE', `/api/comment-templates/${shTpl.id}`, U);
  check('demo-user edit/delete shared template → 403', r.status === 403 && rd.status === 403);
  r = await http('PUT', `/api/comment-templates/${adTpl.id}`, U, { text: 'x' });
  check('demo-user edit admin private template → 404', r.status === 404);
  r = await http('POST', '/api/comment-templates', U, { name: `${tmp} s`, text: 'x', shared: true });
  check('demo-user create shared → 403 comment.admin_only', r.status === 403 && r.body.code === 'comment.admin_only');
  // duplicate (the UI's "save as mine" = POST with the same fields)
  r = await http('POST', '/api/comment-templates', U, { kind: shTpl.kind, name: `${tmp} ${shTpl.name}（副本）`, personaId: shTpl.persona?.id ?? null, tags: shTpl.tags, text: shTpl.text });
  const cp = r.body.template;
  if (cp?.id) cleanup.push(() => http('DELETE', `/api/comment-templates/${cp.id}`, T));
  check('duplicate a shared template → private copy owned by demo-user, same text/persona/tags', r.status === 201 && cp.shared === false && cp.userId === userId && cp.text === shTpl.text && cp.persona?.id === shTpl.persona?.id && !!cp.persona && eqSet(cp.tags, shTpl.tags));
  r = await http('PUT', `/api/comment-templates/${cp.id}`, U, { text: '改过的文案', personaId: null, tags: ['New', 'NEW'], kind: 'comment' });
  const cpAfter = (await tl(U, `kind=all&q=${encodeURIComponent(tmp)}`)).find((x) => x.id === cp.id);
  check('edit copy persists (personaId null clears, tags lowercased+deduped, kind changed)', r.status === 200 && cpAfter?.text === '改过的文案' && cpAfter.persona === null && JSON.stringify(cpAfter.tags) === '["new"]' && cpAfter.kind === 'comment');
  check('shared original unchanged', (await tl(U, 'kind=all&scope=shared&q=demo')).find((x) => x.id === shTpl.id)?.text === TEMPLATES[0]!.text);
  r = await http('DELETE', `/api/comment-templates/${cp.id}`, U);
  check('delete own copy → 204, gone from list', r.status === 204 && !(await tl(U, `kind=all&q=${encodeURIComponent(tmp)}`)).some((x) => x.id === cp.id));
  r = await http('POST', '/api/comment-templates', U, { name: `${tmp} x`, text: '   ' });
  check('blank text → 400', r.status === 400);

  // ======================================================================== 内容管理
  console.log('\n— 内容管理');
  const ctitles = (xs: any[]) => xs.map((x) => x.title).filter((n: string) => CONTENTS.some((c) => c.title === n));
  const cl = (tk: string, q: string) => listAll(tk, `/api/contents?${q}`);
  const uC = await cl(U, 'q=demo');
  check('demo-user sees only own contents (6)', eqSet(ctitles(uC), CONTENTS.filter((c) => c.owner === 'user').map((c) => c.title)) && uC.every((x) => x.userId === userId));
  const aC = await cl(T, 'q=demo');
  check('admin sees all 13 demo contents', eqSet(ctitles(aC), CONTENTS.map((c) => c.title)));
  const aOwnU = await cl(T, `ownerId=${userId}`);
  check('admin ownerId=demo-user filter', eqSet(ctitles(aOwnU), CONTENTS.filter((c) => c.owner === 'user').map((c) => c.title)) && aOwnU.every((x) => x.userId === userId));
  r = await http('GET', `/api/contents?ownerId=${adminId}`, U);
  check('demo-user ownerId=admin → 403 content.admin_only', r.status === 403 && r.body.code === 'content.admin_only');
  const adminContent = aC.find((x) => x.title === 'demo 新品咖啡上市');
  r = await http('GET', `/api/contents/${adminContent.id}`, U);
  const rp = await http('PUT', `/api/contents/${adminContent.id}`, U, { title: 'x' });
  const rdl = await http('DELETE', `/api/contents/${adminContent.id}`, U);
  check('demo-user GET/PUT/DELETE admin content → 404', r.status === 404 && rp.status === 404 && rdl.status === 404);
  // Contents with demo publish tasks (定时发布 demo) get their status from those tasks instead of the stage.
  const withPublish = new Set(aC.filter((x) => Object.values(x.publishCounts ?? {}).some((n) => Number(n) > 0)).map((x) => x.title));
  for (const s of ['draft', 'ready', 'archived'] as const) {
    const got = await cl(T, `status=${s}&q=demo`);
    check(`status=${s} filter (admin, all owners)`, eqSet(ctitles(got), CONTENTS.filter((c) => c.stage === s && !withPublish.has(c.title)).map((c) => c.title)), sorted(ctitles(got)));
  }
  // 分区 tabs: csv status filter + byStatus (counts under the other filters, never the status one).
  {
    const tab = await cl(T, 'status=draft,archived&q=demo');
    const want = aC.filter((x) => x.status === 'draft' || x.status === 'archived');
    check('status=draft,archived (csv) = draft + archived demo contents', eqSet(ctitles(tab), ctitles(want)), sorted(ctitles(tab)));
    const byA = (await http('GET', '/api/contents?q=demo&status=published', T)).body.byStatus as Record<string, number>;
    const byU = (await http('GET', '/api/contents?q=demo', U)).body.byStatus as Record<string, number>;
    const tally = (xs: any[]) => xs.reduce((m: Record<string, number>, x) => ({ ...m, [x.status]: (m[x.status] ?? 0) + 1 }), {});
    const same = (b: Record<string, number>, xs: any[]) => Object.entries(tally(xs)).every(([s, n]) => b[s] === n) && Object.values(b).reduce((a, n) => a + n, 0) === xs.length;
    check('byStatus (admin, q=demo, status filter ignored) matches the list', same(byA, aC), JSON.stringify(byA));
    check('byStatus (demo-user) counts only its own contents', same(byU, uC), JSON.stringify(byU));
  }
  // List publish summary (媒体号 / 发布时间), recomputed here from the DB rows: accounts of non-cancelled tasks
  // (users: only tasks whose user_id is themselves), next due time of an unfinished task, latest published time.
  {
    const ptRows = await db.select().from(schema.publishTasks);
    const UNF = ['pending', 'scheduled', 'running', 'awaiting_operator'];
    const expectFor = (contentId: string, viewer: string | null) => {
      const rs = ptRows.filter((p) => p.contentId === contentId && p.status !== 'cancelled' && (!viewer || p.userId === viewer));
      const ms = (xs: (Date | null)[]) => xs.filter((d): d is Date => !!d).map((d) => d.getTime());
      const next = ms(rs.filter((p) => UNF.includes(p.status)).map((p) => p.scheduledAt));
      const last = ms(rs.map((p) => p.publishedAt));
      return { accounts: [...new Set(rs.map((p) => p.accountId))].sort().join('|'), next: next.length ? Math.min(...next) : null, last: last.length ? Math.max(...last) : null };
    };
    const got = (x: any) => ({
      accounts: (x.publishAccounts as any[]).map((a) => a.id).sort().join('|'),
      next: x.nextPublishAt ? new Date(x.nextPublishAt).getTime() : null, last: x.lastPublishedAt ? new Date(x.lastPublishedAt).getTime() : null,
    });
    const bad = (xs: any[], viewer: string | null) => xs.filter((x) => JSON.stringify(got(x)) !== JSON.stringify(expectFor(x.id, viewer))).map((x) => x.title);
    const withAcc = aC.filter((x) => x.publishAccounts.length).length;
    check(`list publishAccounts / nextPublishAt / lastPublishedAt match the publish tasks (admin, ${withAcc} contents with tasks)`, bad(aC, null).length === 0, bad(aC, null).join(','));
    check('list publish summary for demo-user: only its own publish tasks', bad(uC, userId).length === 0, bad(uC, userId).join(','));
    const shapeOk = aC.every((x) => (x.publishAccounts as any[]).every((a) => a.handle && a.platform && a.status && a.status !== 'cancelled' && a.scheduledAt && a.postType));
    check('publishAccounts entries carry platform, handle, status, postType, scheduledAt (no cancelled)', shapeOk);
  }
  const media0 = aC.find((x) => x.title === 'demo 夏日海边合集');
  check('media attached in order with thumbnails', media0.media.map((m: any) => m.name).join(',') === 'demo-海边日落,demo-城市夜景,demo-早餐摆拍' && media0.media.every((m: any) => m.thumbnailUrl));
  check('instagram caption stored in platformHints', media0.platformHints?.instagram?.caption === '☀️ Summer memories #travel');
  const tagC = await cl(U, 'tag=FITNESS');
  check('tag filter case-insensitive (FITNESS)', eqSet(ctitles(tagC), ['demo 健身打卡第1天', 'demo 跑步vlog']));
  const tagHash = await cl(U, `tag=${encodeURIComponent('#food')}`);
  check('tag filter strips leading #', eqSet(ctitles(tagHash), ['demo 周末午餐', 'demo 早餐灵感']));
  // 内容分类: public categories for admin's demo contents, demo-user's personal ones for its own.
  const ccPub = (await http('GET', '/api/content-categories?scope=public', U)).body.categories as any[];
  const ccMine = (await http('GET', '/api/content-categories?scope=mine', U)).body.categories as any[];
  const ccId = (name: string) => [...ccPub, ...ccMine].find((x) => x.name === name)?.id;
  check('content categories: public 活动/新品发布/生活方式 (read-only for demo-user), personal 健身/美食/旅行',
    CONTENT_CATEGORIES.every((cc) => (cc.owner === 'public' ? ccPub : ccMine).some((x) => x.name === cc.name && x.writable === (cc.owner === 'user'))));
  check('demo contents carry their category ({id, name}, scope)', CONTENTS.every((c) => {
    const row = aC.find((x) => x.title === c.title);
    return c.category ? row?.category?.name === c.category && row.category.ownerType === (c.owner === 'admin' ? 'public' : 'user') : row?.category === null;
  }));
  const catC = await cl(T, `categoryId=${ccId('活动')}`);
  check('category filter (活动)', eqSet(ctitles(catC).filter((x) => x.startsWith('demo ')), CONTENTS.filter((c) => c.category === '活动').map((c) => c.title)));
  check('category count (demo-user sees 健身 = 2 of its own)', ccMine.find((x) => x.name === '健身')?.count === CONTENTS.filter((c) => c.category === '健身').length);
  const catNone = await cl(U, 'categoryId=none');
  check('categoryId=none', eqSet(ctitles(catNone), ['demo 自拍分享']));
  const qBody = await cl(T, `q=${encodeURIComponent('20 平米')}`);
  check('q searches the body', eqSet(ctitles(qBody), ['demo 品牌故事草稿']));
  const pg: string[] = [];
  let ctot = 0;
  for (let p = 1; p <= 3; p++) { const x = (await http('GET', `/api/contents?ownerId=${userId}&pageSize=2&page=${p}`, T)).body; ctot = x.total; pg.push(...x.items.map((i: any) => i.id)); }
  check('pagination pageSize=2 × 3 pages = 6 distinct', ctot === 6 && new Set(pg).size === 6);
  const facets = (await http('GET', '/api/contents/facets', U)).body;
  check('facets (demo-user): own tags only, no categories', !('categories' in facets) && facets.tags.some((x: string) => x.toLowerCase() === 'vlog') && !facets.tags.includes('christmas'));

  // create / edit / stage / delete on throw-away contents
  const pubReady = byName.get('demo-早餐摆拍'); const uOwn = byName.get('demo-user-午餐');
  r = await http('POST', '/api/contents', U, { title: `${tmp} 草稿`, stage: 'archived' });
  check('create with stage archived → 400 content.bad_stage', r.status === 400 && r.body.code === 'content.bad_stage');
  r = await http('POST', '/api/contents', U, { title: `${tmp} x`, mediaIds: [adminPriv.id] });
  check('demo-user attaching admin private media → 404 media.not_found', r.status === 404 && r.body.code === 'media.not_found');
  r = await http('POST', '/api/contents', U, { title: `${tmp} x`, mediaIds: [disabled.id] });
  check('demo-user attaching disabled public media → 404', r.status === 404);
  r = await http('POST', '/api/contents', T, { title: `${tmp} x`, ownerId: userId, mediaIds: [adminPriv.id] });
  { const cid = r.body?.content?.id; if (cid) cleanup.push(() => http('DELETE', `/api/contents/${cid}`, T)); }
  check('admin creating for demo-user with admin private media → 400 content.media_not_usable', r.status === 400 && r.body.code === 'content.media_not_usable');
  r = await http('POST', '/api/contents', T, { title: `${tmp} x`, ownerId: userId, mediaIds: [disabled.id] });
  { const cid = r.body?.content?.id; if (cid) cleanup.push(() => http('DELETE', `/api/contents/${cid}`, T)); }
  check('admin creating for demo-user with disabled public media → 400 content.media_not_usable', r.status === 400 && r.body.code === 'content.media_not_usable');
  r = await http('POST', '/api/contents', U, { title: `${tmp} x`, ownerId: adminId });
  check('demo-user creating for another owner → 403', r.status === 403);
  r = await http('POST', '/api/contents', U, { title: `${tmp} 新内容`, body: '正文', categoryId: null, tags: ['A', 'a', '#B'], mediaIds: [uOwn.id, pubReady.id, uOwn.id], platformHints: { instagram: { caption: 'cap 1' } } });
  const nc = r.body.content;
  if (nc?.id) cleanup.push(() => http('DELETE', `/api/contents/${nc.id}`, T));
  check('create: default stage/status draft, categoryId null → no category, tags deduped (# stripped), media deduped in order', r.status === 201 && nc.stage === 'draft' && nc.status === 'draft' && nc.category === null
    && eqSet(nc.tags, ['A', 'B']) && nc.media.map((m: any) => m.id).join() === [uOwn.id, pubReady.id].join() && nc.ownerName === 'demo-user', JSON.stringify({ tags: nc?.tags, cat: nc?.category }));
  r = await http('POST', '/api/contents', U, { title: `${tmp} y`, platformHints: { instagram: { caption: 'x'.repeat(2201) } } });
  check('instagram caption > 2200 → 400', r.status === 400);
  r = await http('POST', '/api/contents', U, { title: `${tmp} y`, platformHints: { myspace: {} } });
  check('unknown platform key in hints → 400', r.status === 400);
  r = await http('POST', '/api/contents', U, { title: `${tmp} yt`, platformHints: { youtube: { title: 'yt title' } } });
  { const cid = r.body?.content?.id; if (cid) cleanup.push(() => http('DELETE', `/api/contents/${cid}`, T)); }
  console.log(`  (info) youtube hints with ENABLED_PLATFORMS=instagram → HTTP ${r.status} (${r.status === 201 ? 'accepted and stored' : r.body?.code})`);
  r = await http('PUT', `/api/contents/${nc.id}`, U, { title: `${tmp} 改名`, body: '新正文', categoryId: ccId('健身'), tags: ['C'], mediaIds: [pubReady.id], platformHints: { instagram: { caption: 'cap 2' } }, stage: 'ready' });
  const ge = (await http('GET', `/api/contents/${nc.id}`, U)).body;
  check('edit persists title/body/category/tags/media/caption; stage+status ready', r.status === 200 && ge.content.title === `${tmp} 改名` && ge.content.body === '新正文' && ge.content.category?.name === '健身'
    && eqSet(ge.content.tags, ['C']) && ge.content.media.length === 1 && ge.content.platformHints.instagram.caption === 'cap 2' && ge.content.stage === 'ready' && ge.content.status === 'ready');
  check('detail has no publish tasks', Array.isArray(ge.publishTasks) && ge.publishTasks.length === 0);
  r = await http('PUT', `/api/contents/${nc.id}`, U, { stage: 'archived' });
  const arch = await cl(U, `status=archived&q=${encodeURIComponent(tmp)}`);
  check('archive → stage/status archived, listed under status=archived', r.status === 200 && r.body.content.status === 'archived' && arch.some((x) => x.id === nc.id));
  r = await http('PUT', `/api/contents/${nc.id}`, U, { body: 'edit while archived' });
  check('editing an archived content keeps it archived', r.status === 200 && r.body.content.stage === 'archived' && r.body.content.body === 'edit while archived');
  r = await http('PUT', `/api/contents/${nc.id}`, U, { stage: 'ready' });
  check('unarchive → ready', r.status === 200 && r.body.content.status === 'ready');
  r = await http('PUT', `/api/contents/${nc.id}`, U, { stage: 'draft' });
  check('ready → draft', r.status === 200 && r.body.content.status === 'draft');
  r = await http('PUT', `/api/contents/${nc.id}`, U, { title: '' });
  check('empty title → 400', r.status === 400);
  r = await http('PUT', `/api/contents/${nc.id}`, U, { mediaIds: Array.from({ length: 21 }, () => pubReady.id) });
  check('more than 20 media → 400', r.status === 400);
  // media referenced by a content (no publish task): delete behaviour
  r = await upload(U, 'mine', `${tmp}-ref.jpg`, await jpeg(120, 120), 'image/jpeg');
  const ref = r.body.item; await waitReady(U, ref.id);
  await http('PUT', `/api/contents/${nc.id}`, U, { mediaIds: [ref.id, pubReady.id] });
  r = await http('DELETE', `/api/media/${ref.id}`, U);
  const afterRef = (await http('GET', `/api/contents/${nc.id}`, U)).body.content;
  console.log(`  (info) deleting media used by a content without publish tasks → HTTP ${r.status}; content now has ${afterRef.media.length} media`);
  // 发布目标 of the demo contents (only when the 媒体矩阵 demo accounts exist)
  const userAccs = await listAll(U, '/api/social/accounts?q=demo.');
  if (userAccs.some((a) => a.handle === 'demo.fit.with.mia')) {
    const want = (title: string) => TARGETS[title]!.join();
    const got = (list: any[], title: string) => (list.find((x) => x.title === title)?.targets ?? []).map((x: any) => x.handle).join();
    check('demo 发布目标: contents carry their default targets in order (admin + demo-user)',
      Object.keys(TARGETS).every((title) => got(CONTENTS.find((c) => c.title === title)!.owner === 'user' ? uC : aC, title) === want(title)),
      Object.keys(TARGETS).map((title) => `${title}: ${got(aC, title)}`).join(' | '));
    // 账号语言 + 发文语言: accounts carry their language; the demo publish task snapshots use the translation in it
    const adminAccs = await listAll(T, '/api/social/accounts?q=demo.');
    const langOk = Object.entries(ACCOUNT_LANGS).every(([h, l]) => [...adminAccs, ...userAccs].filter((a) => a.handle === h).every((a) => a.lang === l));
    check('demo 账号语言: accounts carry their language', langOk, Object.keys(ACCOUNT_LANGS).map((h) => `${h}=${adminAccs.find((a) => a.handle === h)?.lang}`).join(' '));
    const coffee = aC.find((x) => x.title === 'demo 新品咖啡上市');
    const lena = adminAccs.find((a) => a.handle === 'demo.wanderlust.lena');
    const lenaTasks = coffee && lena ? (await http('GET', `/api/publish/tasks?contentId=${coffee.id}&accountId=${lena.id}&limit=5`, T)).body.items as any[] : [];
    const en = CONTENTS.find((c) => c.title === 'demo 新品咖啡上市')!.translations!.find((x) => x.lang === 'en')!;
    check('demo 发文语言: the coffee post to @demo.wanderlust.lena (en) uses the English translation (lang en, English caption)',
      PUBLISHES.some((p) => p.content === 'demo 新品咖啡上市' && p.account === 'demo.wanderlust.lena') && lenaTasks.length > 0
        && lenaTasks.every((x) => x.lang === 'en' && x.caption === en.caption),
      lenaTasks.map((x) => `${x.lang}: ${String(x.caption).slice(0, 30)}`).join(' | '));
    const langs = (await http('GET', '/api/contents/languages', T)).body;
    check('GET /api/contents/languages: zh-CN source + the languages bound to accounts', langs.source === 'zh-CN' && langs.languages[0] === 'zh-CN'
      && ['en', 'hi'].every((l) => langs.configured.includes(l)) && !langs.configured.includes('zh-CN'), JSON.stringify(langs));
    const adminAcc = adminAccs.find((a) => a.handle === 'demo.wanderlust.lena');
    r = await http('PUT', `/api/contents/${nc.id}`, U, { targetIds: [adminAcc.id] });
    check('demo-user cannot target an admin account → 404', r.status === 404 && r.body.code === 'social.not_found', `${r.status} ${r.body?.code}`);
    const mia = userAccs.find((a) => a.handle === 'demo.fit.with.mia');
    r = await http('PUT', `/api/contents/${nc.id}`, U, { targetIds: [mia.id] });
    check('demo-user targets an own account (no device → still allowed)', r.status === 200 && r.body.content.targets[0]?.id === mia.id && r.body.content.targets[0]?.instance === null);
  } else console.log('  (skip) 发布目标 checks: 媒体矩阵 demo accounts missing (run scripts/demo-seed-matrix.ts)');
  r = await http('DELETE', `/api/contents/${nc.id}`, U);
  const cg = await http('GET', `/api/contents/${nc.id}`, U);
  check('delete own content → 204, then 404', r.status === 204 && cg.status === 404);
  const still = await http('GET', `/api/media/${pubReady.id}`, U);
  check('deleting a content leaves its media in the library', still.status === 200);

  // ======================================================================== 趋势热点 (Instagram-only scope)
  console.log('\n— 趋势热点');
  const tr = await http('GET', '/api/trending', U);
  check('GET /api/trending → 200, configured=false, notice trending.unavailable', tr.status === 200 && tr.body.configured === false && tr.body.notice === 'trending.unavailable', `${tr.status} ${tr.body?.notice}`);
  r = await http('PUT', '/api/trending/settings', T, tr.body.settings);
  check('PUT /api/trending/settings (admin, unchanged values) → 400 platform.disabled', r.status === 400 && r.body.code === 'platform.disabled', `${r.status} ${r.body?.code}`);
  r = await http('POST', '/api/trending/refresh', T);
  check('POST /api/trending/refresh → 400 platform.disabled (nothing queued)', r.status === 400 && r.body.code === 'platform.disabled', `${r.status} ${r.body?.code}`);
} catch (err) {
  check(`unexpected error: ${(err as Error).stack ?? (err as Error).message}`, false);
} finally {
  for (const f of cleanup.reverse()) await f().catch(() => undefined);
  const leftM = (await listAll(T, `/api/media?scope=public&q=${tmp}`)).length + (await listAll(T, `/api/media?scope=all-users&q=${tmp}`)).length;
  const leftC = (await listAll(T, `/api/contents?q=${tmp}`)).length;
  const leftT = ((await http('GET', `/api/comment-templates?kind=all&q=${tmp}`, T)).body.templates as any[]).length;
  const leftTasks = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(eq(schema.tasks.instanceName, `${tmp} in-use fixture`));
  check('cleanup: no demo-tmp media/contents/templates/fixture tasks left', leftM + leftC + leftT + leftTasks.length === 0, `${leftM}/${leftC}/${leftT}/${leftTasks.length}`);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `\nfailed:\n  ${failed.map((f) => f[0]).join('\n  ')}` : ''}`);
  process.exit(failed.length ? 1 : 0);
}
void fs; void path;
