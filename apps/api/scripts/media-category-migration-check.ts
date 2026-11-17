/**
 * Migration check for 0029_media_categories_scoped (case-duplicate media category names merged before the
 * case-insensitive unique index). Two phases, run against a test database only:
 *
 *   npx tsx --env-file=../../.env scripts/media-category-migration-check.ts seed <migrations folder without 0029>
 *     applies the migrations up to 0028 from that folder, then inserts duplicate categories (public "Travel"/"travel",
 *     a user's "Food"/"FOOD"/"food", another user's "food" which must stay) with assets in each;
 *   npm run db:migrate
 *   npx tsx --env-file=../../.env scripts/media-category-migration-check.ts verify
 *     checks that per owner one row is left (the lowest sort, then oldest), all assets point at it, the other owner's row
 *     is untouched, and the new index refuses a case variant.
 * Never point this at a database you care about: `seed` writes fake users, categories and assets.
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sqlClient } from '../src/db/index.js';

const phase = process.argv[2];
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};
const TAG = 'mcmig';

if (phase === 'seed') {
  await migrate(db, { migrationsFolder: process.argv[3]! });
  const [u1] = await sqlClient<{ id: string }[]>`insert into users (username, password_hash, role) values (${`${TAG}_u1`}, 'x', 'user') returning id`;
  const [u2] = await sqlClient<{ id: string }[]>`insert into users (username, password_hash, role) values (${`${TAG}_u2`}, 'x', 'user') returning id`;
  const cat = async (ownerId: string | null, name: string, sort: number, age: number) => (await sqlClient<{ id: string }[]>`
    insert into media_categories (owner_type, owner_id, name, sort, created_at)
    values (${ownerId ? 'user' : 'public'}, ${ownerId}, ${name}, ${sort}, now() - make_interval(mins => ${age})) returning id`)[0]!.id;
  const asset = async (ownerId: string | null, categoryId: string, n: number) => {
    await sqlClient`insert into media_assets (owner_type, owner_id, category_id, name, file_name, file_type, mime_type, file_size, checksum, file_key, storage, status)
      values (${ownerId ? 'user' : 'public'}, ${ownerId}, ${categoryId}, ${`${TAG} ${n}`}, ${`${TAG}${n}.jpg`}, 'image', 'image/jpeg', 1,
        ${'0'.repeat(64)}, ${`${TAG}/${n}.jpg`}, 'local', 'ready')`;
  };
  const p1 = await cat(null, `${TAG} Travel`, 0, 10);
  const p2 = await cat(null, `${TAG} travel`, 0, 5); // same sort, newer → merged into p1
  const f1 = await cat(u1!.id, `${TAG} Food`, 2, 30);
  const f2 = await cat(u1!.id, `${TAG} FOOD`, 1, 1); // lowest sort → kept
  const f3 = await cat(u1!.id, `${TAG} food`, 3, 60);
  const o1 = await cat(u2!.id, `${TAG} food`, 0, 0); // another owner: not a duplicate
  let n = 0;
  for (const [o, c] of [[null, p1], [null, p2], [null, p2], [u1!.id, f1], [u1!.id, f3], [u1!.id, f2], [u2!.id, o1]] as const) await asset(o, c, n++);
  console.log('seeded', { p1, p2, f1, f2, f3, o1 });
} else if (phase === 'verify') {
  const rows = await sqlClient<{ id: string; ownerId: string | null; name: string; n: number }[]>`
    select c.id, c.owner_id as "ownerId", c.name, (select count(*)::int from media_assets a where a.category_id = c.id) as n
    from media_categories c where c.name ilike ${`${TAG} %`} order by c.owner_id nulls first, c.name`;
  const users = await sqlClient<{ id: string; username: string }[]>`select id, username from users where username like ${`${TAG}_%`}`;
  const u1 = users.find((u) => u.username === `${TAG}_u1`)!.id;
  const u2 = users.find((u) => u.username === `${TAG}_u2`)!.id;
  const pub = rows.filter((r) => r.ownerId === null);
  check('public: one of Travel/travel left, the older one (same sort)', pub.length === 1 && pub[0]!.name === `${TAG} Travel` && pub[0]!.n === 3, pub);
  const own = rows.filter((r) => r.ownerId === u1);
  check('user 1: one of Food/FOOD/food left, the lowest sort (FOOD), with all 3 assets', own.length === 1 && own[0]!.name === `${TAG} FOOD` && own[0]!.n === 3, own);
  const other = rows.filter((r) => r.ownerId === u2);
  check('user 2: own "food" untouched', other.length === 1 && other[0]!.n === 1, other);
  const orphans = await sqlClient<{ n: number }[]>`select count(*)::int as n from media_assets where name like ${`${TAG} %`} and category_id is null`;
  check('no asset lost its category', orphans[0]!.n === 0, orphans);
  const dup = await sqlClient`insert into media_categories (owner_type, owner_id, name) values ('user', ${u1}, ${`${TAG} fOOd`})`.then(() => 'inserted', (e: { code?: string }) => e.code);
  check('case-insensitive unique index refuses a case variant', dup === '23505', dup);
  const desc = await sqlClient`select description from media_categories limit 1`.then(() => true, () => false);
  check('description column exists', desc);
  // cleanup
  await sqlClient`delete from media_assets where name like ${`${TAG} %`}`;
  await sqlClient`delete from media_categories where name ilike ${`${TAG} %`}`;
  await sqlClient`delete from users where username like ${`${TAG}_%`}`;
  console.log(failed ? `${failed} FAILED` : 'all passed');
} else {
  console.error('usage: media-category-migration-check.ts seed <folder> | verify');
  process.exitCode = 2;
}
await sqlClient.end();
if (failed) process.exitCode = 1;
