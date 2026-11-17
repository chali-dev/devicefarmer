import type { Sql } from 'postgres';

const NONE = '00000000-0000-0000-0000-000000000000';

/**
 * Data migration: social account groups (分组, `social_account_groups` / `social_accounts.group_id`) → personas (人设).
 * For every account still in a group:
 * - no persona → the account gets a personal persona of its owner named like the group (an existing personal persona of
 *   that owner with the same name, case-insensitively, is reused; otherwise it is created), logged as field `persona`;
 * - a persona already set → it is kept and the group name becomes a lowercase account tag (max 32 chars; an existing
 *   tag with the same name is reused), logged as field `tags` (unless the account already carries that tag).
 * Then the account's `group_id` is cleared, which is what makes a rerun a no-op (and a later rollback-then-upgrade
 * migrates groups the old code created in between). The group rows themselves stay (expand/contract; drop later).
 * Log rows have no actor (system) and the message `group migrated: <name>`. Runs from src/db/migrate.ts after the schema.
 */
export async function migrateSocialGroups(sql: Sql, log: (msg: string) => void = console.log): Promise<{ accounts: number; personasCreated: number; personaSet: number; tagged: number }> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; userId: string; personaId: string | null; group: string }[]>`
      select a.id, a.user_id as "userId", a.persona_id as "personaId", btrim(g.name) as "group"
      from social_accounts a join social_account_groups g on g.id = a.group_id
      order by a.id for update of a`;
    const out = { accounts: rows.length, personasCreated: 0, personaSet: 0, tagged: 0 };
    if (!rows.length) return out;

    const personaIds = new Map<string, { id: string; name: string }>(); // `${owner}\n${lower}` → persona
    for (const r of rows) {
      const message = `group migrated: ${r.group}`;
      if (!r.personaId) {
        const key = `${r.userId}\n${r.group.toLowerCase()}`;
        let p = personaIds.get(key);
        if (!p) {
          const name = r.group.slice(0, 50);
          const ins = await tx<{ id: string; name: string }[]>`
            insert into personas (owner_type, owner_id, name, sort)
            values ('user', ${r.userId}, ${name}, (select coalesce(max(sort), -1) + 1 from personas where owner_id = ${r.userId}))
            on conflict do nothing returning id, name`;
          if (ins.length) out.personasCreated++;
          [p] = ins.length ? ins : await tx<{ id: string; name: string }[]>`
            select id, name from personas where coalesce(owner_id, ${NONE}::uuid) = ${r.userId}::uuid and lower(name) = lower(${name})`;
          personaIds.set(key, p!);
        }
        await tx`update social_accounts set persona_id = ${p!.id}, group_id = null, updated_at = now() where id = ${r.id}`;
        await tx`insert into social_account_logs (account_id, action, field, from_value, to_value, message)
          values (${r.id}, 'update', 'persona', null, ${p!.name}, ${message})`;
        out.personaSet++;
        continue;
      }
      const tag = r.group.toLowerCase().slice(0, 32);
      const before = (await tx<{ name: string }[]>`
        select t.name from social_account_tags at join social_tags t on t.id = at.tag_id where at.account_id = ${r.id} order by t.name`).map((t) => t.name);
      if (!before.some((t) => t.toLowerCase() === tag)) {
        await tx`insert into social_tags (name) values (${tag}) on conflict do nothing`;
        const [t] = await tx<{ id: string; name: string }[]>`select id, name from social_tags where lower(name) = ${tag}`;
        await tx`insert into social_account_tags (account_id, tag_id) values (${r.id}, ${t!.id}) on conflict do nothing`;
        const after = [...before, t!.name].sort();
        await tx`insert into social_account_logs (account_id, action, field, from_value, to_value, message)
          values (${r.id}, 'update', 'tags', ${before.join(', ') || null}, ${after.join(', ')}, ${message})`;
        out.tagged++;
      }
      await tx`update social_accounts set group_id = null, updated_at = now() where id = ${r.id}`;
    }
    log(`social groups: ${out.accounts} accounts migrated (${out.personaSet} got a persona, ${out.personasCreated} personas created, ${out.tagged} tagged)`);
    return out;
  });
}
