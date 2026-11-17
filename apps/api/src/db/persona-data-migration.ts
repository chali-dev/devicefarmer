import type { Sql } from 'postgres';

/**
 * Data migration: free-text `comment_templates.persona` → managed personas (`personas`, `comment_templates.persona_id`).
 * Texts are trimmed and grouped case-insensitively (the most used spelling wins, then the alphabetically first).
 * Texts used by shared templates become public personas; texts used only by a user's personal templates become that
 * user's personal personas. A public persona with the same name (created now or earlier) also covers personal templates.
 * Existing personas with the same name are reused, so nothing is created twice.
 *
 * Idempotent: only templates with a legacy text and no `persona_id` are touched. The legacy column stays for rollbacks
 * (expand/contract); the code no longer reads it and only clears it when it changes a template's persona, so a
 * template whose persona was cleared or deleted is never re-linked. Runs from src/db/migrate.ts after the schema.
 */
export async function migratePersonaTexts(sql: Sql, log: (msg: string) => void = console.log): Promise<{ created: number; linked: number }> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; userId: string | null; text: string }[]>`
      select id, user_id as "userId", btrim(persona) as text from comment_templates
      where persona_id is null and persona is not null and btrim(persona) <> '' for update`;
    if (!rows.length) return { created: 0, linked: 0 };

    // owner key ('' = public) → lower(name) → spelling → uses
    const groups = new Map<string, Map<string, Map<string, number>>>();
    const add = (owner: string, text: string) => {
      const g = groups.get(owner) ?? new Map<string, Map<string, number>>();
      groups.set(owner, g);
      const v = g.get(text.toLowerCase()) ?? new Map<string, number>();
      g.set(text.toLowerCase(), v);
      v.set(text, (v.get(text) ?? 0) + 1);
    };
    const publicKeys = new Set(rows.filter((r) => r.userId === null).map((r) => r.text.toLowerCase()));
    // A public persona that already exists also covers personal texts.
    for (const p of await tx<{ k: string }[]>`select lower(name) as k from personas where owner_type = 'public'`) publicKeys.add(p.k);
    for (const r of rows) add(r.userId === null || publicKeys.has(r.text.toLowerCase()) ? '' : r.userId, r.text);

    let created = 0;
    const ids = new Map<string, string>(); // `${owner}\n${lower}` → persona id
    for (const [owner, byKey] of groups) {
      for (const [key, spellings] of byKey) {
        const name = [...spellings].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]![0].slice(0, 50);
        const ins = await tx<{ id: string }[]>`
          insert into personas (owner_type, owner_id, name) values (${owner ? 'user' : 'public'}, ${owner || null}, ${name})
          on conflict do nothing returning id`;
        if (ins.length) created++;
        const [p] = ins.length ? ins : await tx<{ id: string }[]>`
          select id from personas where coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid) = ${owner || '00000000-0000-0000-0000-000000000000'}::uuid
          and lower(name) = lower(${name})`;
        ids.set(`${owner}\n${key}`, p!.id);
      }
    }
    let linked = 0;
    for (const r of rows) {
      const k = r.text.toLowerCase();
      const id = ids.get(`${r.userId === null || publicKeys.has(k) ? '' : r.userId}\n${k}`)!;
      await tx`update comment_templates set persona_id = ${id} where id = ${r.id}`;
      linked++;
    }
    log(`personas: created ${created} from legacy persona texts, linked ${linked} templates`);
    return { created, linked };
  });
}
