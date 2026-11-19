import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyBaseLogger } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { config } from '../../config.js';
import { db, schema, sqlClient } from '../../db/index.js';
import { runMigrations } from '../../db/run-migrations.js';
import { conflict } from '../../lib/errors.js';
import { withMutex } from '../../lib/locks.js';
import { storageFor } from '../settings/storage.js';
import { createTask, reconcileTasks, registerTaskHandler, TaskError, type TaskContext } from '../tasks/core.js';
import { getBackup, MAGIC, pgConnection, scrub, takeBackup } from './backup.js';

/**
 * 导入 (restore the database from a backup, admin). The device-less task `db-restore` (queue system-ops, one at a
 * time, 1 attempt) replaces the WHOLE database of DATABASE_URL with the backup:
 *   1. a safety backup of the current data (trigger `pre-restore`, no retention pruning); if it fails, nothing else runs;
 *   2. the backup file is copied from its storage to a temp file, its PGDMP magic checked;
 *   3. `${PG_RESTORE_CMD} --clean --if-exists --no-owner --single-transaction` (all or nothing; password only in PGPASSWORD);
 *   4. the schema/data migrations (a backup of an older release is brought up to date);
 *   5. what the restored tables cannot know is put back: the backup list exactly as it was before (it describes files in
 *      storage, incl. the safety backup), the task rows behind it, this task with its log and its audit row;
 *   6. task reconciliation as at startup (unfinished tasks of the backup are re-queued, running ones fail as interrupted).
 * Everything else (users, settings, tasks, …) is the backup's state; only the safety backup can undo it.
 */

export const RESTORE_TYPE = 'db-restore';

function restoreCommand() {
  const raw = config.PG_RESTORE_CMD?.trim() || (/pg_dump$/.test(config.PG_DUMP_CMD.trim()) ? config.PG_DUMP_CMD.trim().replace(/pg_dump$/, 'pg_restore') : 'pg_restore');
  const [cmd, ...pre] = raw.split(/\s+/);
  const c = pgConnection();
  return { cmd: cmd!, args: [...pre, '--clean', '--if-exists', '--no-owner', '--single-transaction', ...c.args], env: c.env, password: c.password, dbName: c.dbName };
}

async function runRestore(file: string, signal: AbortSignal): Promise<void> {
  const { cmd, args, env, password } = restoreCommand();
  const child = spawn(cmd, args, { env, stdio: ['pipe', 'ignore', 'pipe'] });
  const onAbort = () => child.kill('SIGTERM');
  signal.addEventListener('abort', onAbort);
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => { if (stderr.length < 4000) stderr += d.toString('utf8'); });
  try {
    const closed = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    // A child that dies early (e.g. command not found) closes stdin: that EPIPE is reported through `closed`.
    pipeline(fs.createReadStream(file), child.stdin).catch(() => undefined);
    const code = await closed.catch((err: NodeJS.ErrnoException) => {
      throw new TaskError(err.code === 'ENOENT' ? 'system.restore_cmd_missing' : 'system.restore_failed', `cannot run ${cmd}: ${scrub(err.message, password)}`);
    });
    if (signal.aborted) throw signal.reason;
    if (code !== 0) throw new TaskError('system.restore_failed', `pg_restore exited with ${code}: ${scrub(stderr, password) || 'no output'}`);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

type Json = Record<string, unknown>;
interface Snapshot { backups: Json[]; tasks: Json[]; logs: Json[]; audit: Json[] }

/** Rows the restore would lose, read right before pg_restore (as JSON rows of their tables). */
async function snapshot(taskId: string): Promise<Snapshot> {
  const [b] = await sqlClient`select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) as j from db_backups b`;
  const backups = b!.j as Json[];
  const ids = [...new Set([taskId, ...backups.map((r) => r.task_id).filter((x): x is string => typeof x === 'string')])];
  const [t] = await sqlClient`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as j from tasks t where t.id in ${sqlClient(ids)}`;
  const [l] = await sqlClient`select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) as j from task_logs l where l.task_id = ${taskId}`;
  const [a] = await sqlClient`select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) as j from audit_logs a
    where a.action = 'system.backup_restore' and a.detail->>'taskId' = ${taskId}`;
  return { backups, tasks: t!.j as Json[], logs: l!.j as Json[], audit: a!.j as Json[] };
}

/**
 * Puts the snapshot back after pg_restore + migrations; references to vanished users/tasks become null. Two
 * transactions: the task rows first (so a failure of the second still ends this task visibly), then the backup list.
 */
async function putBack(s: Snapshot) {
  const j = (rows: Json[]) => JSON.stringify(rows);
  await sqlClient.begin(async (tx) => {
    const ids = s.tasks.map((r) => r.id as string);
    if (ids.length) {
      await tx`delete from tasks where id in ${tx(ids)}`;
      await tx`insert into tasks select * from jsonb_populate_recordset(null::tasks, ${j(s.tasks)}::jsonb)`;
    }
    if (s.logs.length) await tx`insert into task_logs select * from jsonb_populate_recordset(null::task_logs, ${j(s.logs)}::jsonb) on conflict (id) do nothing`;
    if (s.audit.length) await tx`insert into audit_logs select * from jsonb_populate_recordset(null::audit_logs, ${j(s.audit)}::jsonb) on conflict (id) do nothing`;
  });
  await sqlClient.begin(async (tx) => {
    await tx`delete from db_backups`;
    if (s.backups.length) {
      await tx`insert into db_backups (id, status, trigger, storage, key, size, error, task_id, created_by, created_at, finished_at)
        select r.id, r.status, r.trigger, r.storage, r.key, r.size, r.error,
          case when exists (select 1 from tasks t where t.id = r.task_id) then r.task_id end,
          case when exists (select 1 from users u where u.id = r.created_by) then r.created_by end,
          r.created_at, r.finished_at
        from jsonb_populate_recordset(null::db_backups, ${j(s.backups)}::jsonb) r`;
    }
  });
}

registerTaskHandler<{ backupId: string }>(RESTORE_TYPE, {
  queue: 'system-ops',
  concurrency: 1,
  timeoutMs: 3 * 60 * 60_000,
  maxAttempts: 1,
  retryable: false,
  async run(ctx) {
    const source = await getBackup(ctx.payload.backupId).catch(() => {
      throw new TaskError('system.backup_not_found', 'backup not found');
    });
    if (source.status !== 'ok') throw new TaskError('system.backup_not_ok', `backup is ${source.status}`);
    const name = path.basename(source.key);
    await ctx.log('info', `restore of ${name} started: safety backup first`, { backupId: source.id });

    let safety: Awaited<ReturnType<typeof takeBackup>>;
    try {
      safety = await takeBackup(ctx as TaskContext<unknown>, 'pre-restore', false);
    } catch (err) {
      throw new TaskError('system.restore_safety_backup_failed', `safety backup failed, nothing restored: ${(err as Error).message}`.slice(0, 1000));
    }

    const tmp = path.join(os.tmpdir(), `cloudphone-restore-${randomUUID()}.dump`);
    try {
      await pipeline(await (await storageFor(source.storage)).getStream(source.key), fs.createWriteStream(tmp));
      const fd = await fs.promises.open(tmp, 'r');
      try {
        const head = Buffer.alloc(MAGIC.length);
        await fd.read(head, 0, MAGIC.length, 0);
        if (!head.equals(MAGIC)) throw new TaskError('system.restore_invalid', 'the backup file is not a custom-format archive');
      } finally { await fd.close(); }
      const { size } = await fs.promises.stat(tmp);
      await ctx.log('info', `pg_restore of ${name} started (${size} bytes)`, { backupId: source.id, safetyBackupId: safety.backupId, dbName: restoreCommand().dbName });

      const snap = await snapshot(ctx.task.id);
      await runRestore(tmp, ctx.signal);
      // From here on the tables hold the backup's rows: this task's own row is back only after putBack.
      const migrationLines: string[] = [];
      let migrationError: string | null = null;
      try { await runMigrations((m) => migrationLines.push(m)); } catch (err) { migrationError = (err as Error).message; }
      try {
        await putBack(snap);
      } catch (err) {
        // This task's row may be missing now, so the task log can't take it: the server log does.
        console.error(`db-restore ${ctx.task.id}: restored, but putting back the backup list / task rows failed`, err);
        throw new TaskError('system.restore_failed', `restored, but putting back the backup list failed: ${(err as Error).message}`.slice(0, 1000));
      }
      await ctx.log('info', `database restored from ${name}`, { backupId: source.id, safetyBackupId: safety.backupId });
      if (migrationError) throw new TaskError('system.restore_migrations_failed', `restored, but the migrations failed: ${migrationError}`.slice(0, 1000));
      await ctx.log('info', 'migrations applied', migrationLines.length ? { lines: migrationLines } : undefined);

      const logger = {
        info: (o: unknown, m?: string) => { void ctx.log('info', m ?? String(o), typeof o === 'object' ? o as Json : undefined).catch(() => undefined); },
        warn: (o: unknown, m?: string) => { void ctx.log('warn', m ?? String(o), typeof o === 'object' ? o as Json : undefined).catch(() => undefined); },
        error: (o: unknown, m?: string) => { void ctx.log('error', m ?? String(o)).catch(() => undefined); },
      } as unknown as FastifyBaseLogger;
      await reconcileTasks(logger);
      await ctx.log('info', 'tasks reconciled');
      return { backupId: source.id, name, safetyBackupId: safety.backupId, safetyKey: safety.key };
    } finally {
      await fs.promises.unlink(tmp).catch(() => undefined);
    }
  },
});

/** 导入: admin request → the task. Only for an `ok` backup, one restore at a time. */
export async function startRestore(userId: string, backupId: string) {
  const b = await getBackup(backupId);
  if (b.status !== 'ok') throw conflict('backup is not complete', 'system.backup_not_ok');
  // 防并发: two clicks / two admins → one restore (checked and created alone, across API processes)
  return withMutex(`task:${RESTORE_TYPE}`, async () => {
    const [busy] = await db.select({ id: schema.tasks.id }).from(schema.tasks)
      .where(and(eq(schema.tasks.type, RESTORE_TYPE), inArray(schema.tasks.status, ['pending', 'scheduled', 'running'])));
    if (busy) throw conflict('a restore is already running', 'system.restore_running');
    const { task } = await createTask({ type: RESTORE_TYPE, userId, label: path.basename(b.key), refType: 'db_backup', refId: b.id, payload: { backupId: b.id } });
    return { task, backup: b };
  });
}
