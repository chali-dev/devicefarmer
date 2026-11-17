/**
 * Data migration check for src/db/social-group-data-migration.ts (social account groups → personas / tags), against the
 * real DB of the running environment (no API needed). Seeds legacy groups directly (the table is kept for rollbacks):
 * - user A: group "Travel" with 2 accounts without persona → one personal persona "Travel" (created once), logged;
 *   group "Food" with an account that already has a persona → persona kept, tag "food" added, logged; an account in
 *   "Food" that already carries the tag "FOOD" → no tag change, no log;
 *   group "Fit" whose name matches an existing personal persona "fit" of A → that persona is reused, nothing created;
 * - user B: group "Travel" too → B gets its own personal persona (personas are per owner);
 * - a long group name (40 chars) → persona keeps it, the tag is cut to 32 chars.
 * Runs the migration twice: the second run changes nothing (group_id cleared, so there is nothing left to migrate), and
 * a persona removed by an operator after the first run is not re-assigned. Cleans up everything it created.
 * Usage (from apps/api): npx tsx --env-file=../../.env scripts/social-group-migration-check.ts
 */
import { randomBytes } from 'node:crypto';
import { sqlClient as sql } from '../src/db/index.js';
import { migrateSocialGroups } from '../src/db/social-group-data-migration.js';

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (ok) passed++; else failed++;
};
const tag = randomBytes(3).toString('hex');
const long = `Long group name ${tag} ${'x'.repeat(40)}`.slice(0, 40);

const user = async (n: string) => (await sql<{ id: string }[]>`insert into users (username, password_hash, role) values (${`sgm${n}${tag}`}, 'x', 'user') returning id`)[0]!.id;
const group = async (userId: string, name: string) => (await sql<{ id: string }[]>`insert into social_account_groups (user_id, name) values (${userId}, ${name}) returning id`)[0]!.id;
const persona = async (ownerId: string | null, name: string) => (await sql<{ id: string }[]>`
  insert into personas (owner_type, owner_id, name) values (${ownerId ? 'user' : 'public'}, ${ownerId}, ${name}) returning id`)[0]!.id;
const account = async (userId: string, handle: string, groupId: string, personaId: string | null = null) => (await sql<{ id: string }[]>`
  insert into social_accounts (user_id, platform, handle, group_id, persona_id) values (${userId}, 'instagram', ${`sgm_${tag}_${handle}`}, ${groupId}, ${personaId}) returning id`)[0]!.id;
const state = async (id: string) => (await sql<{ groupId: string | null; personaId: string | null; persona: string | null; tags: string[] }[]>`
  select a.group_id as "groupId", a.persona_id as "personaId", p.name as persona,
    coalesce((select array_agg(t.name order by t.name) from social_account_tags at join social_tags t on t.id = at.tag_id where at.account_id = a.id), '{}') as tags
  from social_accounts a left join personas p on p.id = a.persona_id where a.id = ${id}`)[0]!;
const logs = async (id: string) => sql<{ field: string; fromValue: string | null; toValue: string | null; message: string; actorId: string | null }[]>`
  select field, from_value as "fromValue", to_value as "toValue", message, actor_id as "actorId" from social_account_logs where account_id = ${id} order by at, id`;

const uA = await user('a');
const uB = await user('b');
let pubId = '';
try {
  const gTravel = await group(uA, `Travel ${tag}`);
  const gFood = await group(uA, `Food ${tag}`);
  const gFit = await group(uA, `Fit ${tag}`);
  const gLong = await group(uA, long);
  const gTravelB = await group(uB, `Travel ${tag}`);
  pubId = await persona(null, `Brand ${tag}`);
  const fitExisting = await persona(uA, `fit ${tag}`);
  // the tag "FOOD <tag>" already exists on one account (any spelling counts)
  await sql`insert into social_tags (name) values (${`FOOD ${tag}`}) on conflict do nothing`;
  const t1 = await account(uA, 't1', gTravel);
  const t2 = await account(uA, 't2', gTravel);
  const f1 = await account(uA, 'f1', gFood, pubId);
  const f2 = await account(uA, 'f2', gFood, pubId);
  await sql`insert into social_account_tags (account_id, tag_id) select ${f2}, id from social_tags where lower(name) = lower(${`FOOD ${tag}`})`;
  const fit = await account(uA, 'fit', gFit);
  const lg = await account(uA, 'long', gLong, pubId);
  const tb = await account(uB, 'tb', gTravelB);
  const ids = [t1, t2, f1, f2, fit, lg, tb];
  const personasOf = async (owner: string) => (await sql<{ id: string; name: string }[]>`select id, name from personas where owner_id = ${owner} order by name`);

  const run1 = await migrateSocialGroups(sql, () => {});
  check('run 1 touched every grouped test account', run1.accounts >= ids.length, run1);

  const [s1, s2, sf1, sf2, sfit, slg, stb] = await Promise.all(ids.map(state));
  check('all test accounts left their group (group_id cleared)', [s1, s2, sf1, sf2, sfit, slg, stb].every((x) => x!.groupId === null));
  const aPersonas = await personasOf(uA);
  const travelA = aPersonas.filter((p) => p.name.toLowerCase() === `travel ${tag}`);
  check('no persona → personal persona of the owner named like the group, created once for both accounts',
    travelA.length === 1 && s1!.personaId === travelA[0]!.id && s2!.personaId === travelA[0]!.id, aPersonas);
  check('existing personal persona with the same name (case-insensitive) is reused', sfit!.personaId === fitExisting && aPersonas.length === 2, aPersonas);
  check('persona already set → kept, group name added as lowercase tag', sf1!.personaId === pubId && sf1!.tags.some((x) => x.toLowerCase() === `food ${tag}`), sf1);
  check('tag already present (other spelling) → unchanged', sf2!.personaId === pubId && sf2!.tags.length === 1, sf2);
  check('long group name → tag cut to 32 chars', slg!.personaId === pubId && slg!.tags.length === 1 && slg!.tags[0] === long.toLowerCase().slice(0, 32), slg);
  const bPersonas = await personasOf(uB);
  check('another owner\'s same-named group → that owner\'s own persona', bPersonas.length === 1 && stb!.personaId === bPersonas[0]!.id && bPersonas[0]!.id !== travelA[0]!.id, bPersonas);
  check('group rows themselves are kept (expand/contract)', (await sql`select 1 from social_account_groups where user_id in (${uA}, ${uB})`).length === 5);

  const [l1, lf1, lf2] = await Promise.all([logs(t1), logs(f1), logs(f2)]);
  check('persona change logged (system actor, group name in the message)', l1.length === 1 && l1[0]!.field === 'persona' && l1[0]!.fromValue === null
    && l1[0]!.toValue === `Travel ${tag}` && l1[0]!.actorId === null && l1[0]!.message === `group migrated: Travel ${tag}`, l1);
  check('tag change logged (from → to)', lf1.length === 1 && lf1[0]!.field === 'tags' && lf1[0]!.fromValue === null && lf1[0]!.toValue!.toLowerCase() === `food ${tag}`, lf1);
  check('no log when nothing changed', lf2.length === 0, lf2);

  // an operator clears a migrated persona; rerunning the migration must not bring it back
  await sql`update social_accounts set persona_id = null where id = ${t2}`;
  const logCount = async () => (await sql<{ n: number }[]>`select count(*)::int as n from social_account_logs where account_id in ${sql(ids)}`)[0]!.n;
  const before = await logCount();
  const personasBefore = (await sql<{ n: number }[]>`select count(*)::int as n from personas where owner_id in (${uA}, ${uB})`)[0]!.n;
  await migrateSocialGroups(sql, () => {});
  const after = await Promise.all(ids.map(state));
  check('rerun: no new logs, no new personas, cleared persona stays cleared', (await logCount()) === before
    && (await sql<{ n: number }[]>`select count(*)::int as n from personas where owner_id in (${uA}, ${uB})`)[0]!.n === personasBefore
    && after[1]!.personaId === null && after[0]!.personaId === travelA[0]!.id);
} catch (e) {
  check(`unexpected error: ${(e as Error).stack}`, false);
} finally {
  await sql`delete from users where id in (${uA}, ${uB})`; // cascades accounts, groups, personal personas, logs
  if (pubId) await sql`delete from personas where id = ${pubId}`;
  await sql`delete from social_tags t where t.name ilike ${`%${tag}%`} and not exists (select 1 from social_account_tags at where at.tag_id = t.id)`;
  console.log(`\n${passed}/${passed + failed} checks passed`);
  await sql.end();
  if (failed) process.exitCode = 1;
}
