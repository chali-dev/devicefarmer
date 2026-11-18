import type { Sql } from 'postgres';

/**
 * Data migration: 对用户可见 removed (owner decision 2026-11-18: public media is always visible to every user).
 * Assets in status 'disabled' (only public ones could be; the status was only ever set on processed files) become
 * 'ready'; 'processing' / 'failed' rows keep their status. `disable_on_ready` (migration 0039) is cleared on every
 * row, so an upload queued by an older colour can't come back as hidden. Both updates only touch rows that still
 * need it, which makes a rerun a no-op. The 'disabled' status value and the column stay (expand/contract; drop later).
 * Runs from src/db/migrate.ts after the schema.
 */
export async function migrateMediaVisibility(sql: Sql, log: (msg: string) => void = console.log): Promise<{ enabled: number; flagsCleared: number }> {
  return sql.begin(async (tx) => {
    const enabled = await tx`update media_assets set status = 'ready', disable_on_ready = false, updated_at = now() where status = 'disabled' returning id`;
    const cleared = await tx`update media_assets set disable_on_ready = false, updated_at = now() where disable_on_ready returning id`;
    const out = { enabled: enabled.length, flagsCleared: cleared.length };
    if (out.enabled || out.flagsCleared) log(`media: ${out.enabled} disabled public assets set ready, ${out.flagsCleared} pending hide flags cleared (public media is always visible)`);
    return out;
  });
}
