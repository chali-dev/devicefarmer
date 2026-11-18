import type { Sql } from 'postgres';
import { firstSlot, IG_DEFAULT_INTERVAL_HOURS } from '../modules/tracked/slots.js';

export const TRACKED_IG_SCHEDULE_MARKER = 'migration.tracked_ig_schedule';

/**
 * Data migration (owner decision 2026-11-18): Instagram tracked accounts are collected on the collector
 * device on a schedule by default. Existing Instagram accounts without an interval get 24 h (first slot
 * within the next hour at their minute offset). Runs once: a marker row in `settings` makes reruns a
 * no-op, so an interval a user switches off later is never switched on again. Runs from src/db/migrate.ts.
 * `opts` (tests only): another marker key and a restriction to some rows, so a check never touches real accounts.
 */
export async function migrateTrackedIgSchedule(
  sql: Sql, log: (msg: string) => void = console.log, opts: { marker?: string; onlyIds?: string[] } = {},
): Promise<{ updated: number; skipped: boolean }> {
  const marker = opts.marker ?? TRACKED_IG_SCHEDULE_MARKER;
  return sql.begin(async (tx) => {
    // Serialise concurrent runs on the marker key.
    await tx`select pg_advisory_xact_lock(hashtext(${marker}))`;
    const [done] = await tx`select 1 from settings where key = ${marker}`;
    if (done) return { updated: 0, skipped: true };
    const rows = await tx<{ id: string }[]>`
      select id from tracked_accounts where platform = 'instagram' and refresh_interval_hours is null
      ${opts.onlyIds ? tx`and id = any(${opts.onlyIds}::uuid[])` : tx``} for update`;
    for (const r of rows) {
      await tx`update tracked_accounts set refresh_interval_hours = ${IG_DEFAULT_INTERVAL_HOURS}, next_refresh_at = ${firstSlot(r.id).toISOString()}::timestamptz, schedule_skip_code = null
        where id = ${r.id} and refresh_interval_hours is null`;
    }
    const value = { at: new Date().toISOString(), updated: rows.length };
    await tx`insert into settings (key, value) values (${marker}, ${JSON.stringify(value)}::jsonb) on conflict (key) do nothing`;
    if (rows.length) log(`tracked accounts: scheduled collection every ${IG_DEFAULT_INTERVAL_HOURS} h switched on for ${rows.length} Instagram accounts`);
    return { updated: rows.length, skipped: false };
  });
}
