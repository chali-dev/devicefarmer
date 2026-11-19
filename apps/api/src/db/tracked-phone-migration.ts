import type { Sql } from 'postgres';

export const TRACKED_PHONE_MARKER = 'migration.tracked_own_phone';
export const LEGACY_COLLECTORS_KEY = 'tracked.collectors';

interface LegacyEntry { instanceId?: string | null; haltedAt?: string | null; haltCode?: string | null }

/**
 * Data migration (owner decision 2026-11-19, 「采集手机改成配置自己的云手机，从系统配置移除」): tracked accounts read in the
 * app (Instagram) get their own 采集手机 `tracked_accounts.instance_id` instead of the global collector setting
 * `tracked.collectors`. Each Instagram account without a phone gets
 *   1. the old collector device of the setting when its owner may use it (admin owner: any device; user: granted), else
 *   2. the owner's only phone when the owner has exactly one (admin owner: the only device), else
 *   3. none (the 追踪号 list shows 「未设置」).
 * A halt still stored on an old collector entry (haltedAt / haltCode, written by an older version) is moved into
 * `risk.halts` for that device first, then the setting row is deleted. Runs once (marker row `settings` key
 * `migration.tracked_own_phone`), so a phone a user clears later is never set again. Runs from src/db/migrate.ts.
 * `opts` (tests only): another marker / collectors key and a restriction to some rows, so a check never touches
 * real accounts.
 */
export async function migrateTrackedPhones(
  sql: Sql, log: (msg: string) => void = console.log,
  opts: { marker?: string; collectorsKey?: string; onlyIds?: string[] } = {},
): Promise<{ skipped: boolean; fromCollector: number; single: number; none: number; haltsMoved: number; settingDeleted: boolean }> {
  const marker = opts.marker ?? TRACKED_PHONE_MARKER;
  const key = opts.collectorsKey ?? LEGACY_COLLECTORS_KEY;
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${marker}))`;
    const out = { skipped: false, fromCollector: 0, single: 0, none: 0, haltsMoved: 0, settingDeleted: false };
    const [done] = await tx`select 1 from settings where key = ${marker}`;
    if (done) return { ...out, skipped: true };

    const [row] = await tx<{ value: Record<string, LegacyEntry> | null }[]>`select value from settings where key = ${key}`;
    const entries = row?.value ?? {};
    const existing = new Set((await tx<{ id: string }[]>`select id from instances`).map((r) => r.id));

    // legacy entry halts → risk.halts (per device), unless the device already has one there
    const halted = Object.entries(entries).filter(([, e]) => e?.instanceId && e.haltedAt && existing.has(e.instanceId));
    if (halted.length) {
      const [h] = await tx<{ value: Record<string, unknown> | null }[]>`select value from settings where key = 'risk.halts' for update`;
      const halts = { ...(h?.value ?? {}) };
      for (const [platform, e] of halted) {
        if (halts[e.instanceId!]) continue;
        halts[e.instanceId!] = { at: e.haltedAt, code: e.haltCode ?? 'tracked.collector_challenge', source: 'collector', platform };
        out.haltsMoved++;
      }
      if (out.haltsMoved) {
        await tx`insert into settings (key, value) values ('risk.halts', ${JSON.stringify(halts)}::jsonb)
          on conflict (key) do update set value = excluded.value, updated_at = now()`;
      }
    }

    const collector = entries.instagram?.instanceId && existing.has(entries.instagram.instanceId) ? entries.instagram.instanceId : null;
    const rows = await tx<{ id: string; user_id: string; role: string }[]>`
      select t.id, t.user_id, u.role from tracked_accounts t join users u on u.id = t.user_id
      where t.platform = 'instagram' and t.instance_id is null
      ${opts.onlyIds ? tx`and t.id = any(${opts.onlyIds}::uuid[])` : tx``} for update of t`;
    const phonesOf = new Map<string, string[]>();
    const phones = async (userId: string, role: string) => {
      if (!phonesOf.has(userId)) {
        phonesOf.set(userId, role === 'admin' ? [...existing]
          : (await tx<{ id: string }[]>`select instance_id as id from instance_grants where user_id = ${userId}`).map((r) => r.id));
      }
      return phonesOf.get(userId)!;
    };
    for (const r of rows) {
      const own = await phones(r.user_id, r.role);
      const pick = collector && own.includes(collector) ? collector : own.length === 1 ? own[0]! : null;
      if (!pick) { out.none++; continue; }
      await tx`update tracked_accounts set instance_id = ${pick} where id = ${r.id} and instance_id is null`;
      if (pick === collector) out.fromCollector++; else out.single++;
    }

    if (row) {
      await tx`delete from settings where key = ${key}`;
      out.settingDeleted = true;
    }
    await tx`insert into settings (key, value) values (${marker}, ${JSON.stringify({ at: new Date().toISOString(), ...out })}::jsonb) on conflict (key) do nothing`;
    if (rows.length || row) {
      log(`tracked accounts: 采集手机 set for ${out.fromCollector + out.single} Instagram accounts (${out.fromCollector} old collector, ${out.single} only phone), ${out.none} without one; collector setting ${out.settingDeleted ? 'removed' : 'absent'}${out.haltsMoved ? `, ${out.haltsMoved} halt(s) moved to risk.halts` : ''}`);
    }
    return out;
  });
}
