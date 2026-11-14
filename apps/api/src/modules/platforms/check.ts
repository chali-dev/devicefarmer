import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { HttpError } from '../../lib/errors.js';
import { registerTaskHandler, type TaskContext } from '../tasks/core.js';
import { writeLogs, type LogEntry } from '../social/social.js';
import { connectionFor, withConnection } from './connections.js';
import { requireAdapter } from './index.js';

/**
 * Task `social-account-check` (任务中心, device-less): checks a social account through its official
 * API connection (fetchOwnProfile, refreshing the token if needed) and records the result on the
 * account (login status, last check, error) plus a social_account_logs entry.
 * - No connection: logs "manual only" and changes nothing (the manual check stays in the Social page).
 * - Authorisation failures (expired / revoked / permission missing) are a check *result*: the account
 *   becomes logged_out with the reason and the task succeeds. Other failures (network, quota, rate
 *   limit) fail the task and leave the account's status as it was.
 */
export const ACCOUNT_CHECK_TASK = 'social-account-check';
export const ACCOUNT_REF_TYPE = 'social-account';
const AUTH_CODES = new Set(['platform.auth_expired', 'platform.permission_missing', 'platform.no_channel', 'platform.not_configured']);
const sa = schema.socialAccounts;

export async function checkSocialAccount(accountId: string, ctx: Pick<TaskContext, 'signal' | 'log'>): Promise<Record<string, unknown>> {
  const [account] = await db.select().from(sa).where(eq(sa.id, accountId));
  if (!account) { await ctx.log('warn', 'account no longer exists'); return { outcome: 'account_deleted' }; }
  const conn = await connectionFor(account.id);
  if (!conn) {
    await ctx.log('info', 'no official API connection: manual check only, nothing changed');
    return { outcome: 'manual_only' };
  }
  const adapter = requireAdapter(conn.platform);
  const now = new Date();
  const record = async (set: Partial<typeof sa.$inferInsert>, message: string) => {
    await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(sa).where(eq(sa.id, account.id)).for('update');
      if (!cur) return;
      const logs: LogEntry[] = [{ accountId: cur.id, action: 'checked', field: null, fromValue: null, toValue: null, message }];
      for (const k of ['loginStatus', 'lastError'] as const) {
        if (set[k] !== undefined && set[k] !== cur[k]) logs.push({ accountId: cur.id, action: 'status', field: k, fromValue: cur[k], toValue: set[k] ?? null, message: 'official API check' });
      }
      await tx.update(sa).set({ ...set, lastCheckedAt: now }).where(eq(sa.id, cur.id));
      await writeLogs(tx, null, logs);
    });
  };
  try {
    const profile = await withConnection(account.id, (a) => adapter.fetchOwnProfile(a), {
      signal: ctx.signal, log: (m, d) => ctx.log('info', m, d),
    });
    await db.update(schema.platformConnections).set({ lastCheckedAt: now, externalAccountName: profile.name ?? profile.handle })
      .where(eq(schema.platformConnections.socialAccountId, account.id));
    await record({ loginStatus: 'logged_in' }, `${adapter.name} API: authorised`);
    await ctx.log('info', 'authorised', { externalAccountId: profile.externalAccountId, followers: profile.followers, posts: profile.posts });
    return { outcome: 'authorised', externalAccountId: profile.externalAccountId, followers: profile.followers, posts: profile.posts, views: profile.views };
  } catch (err) {
    const code = err instanceof HttpError ? err.code ?? null : null;
    if (code && AUTH_CODES.has(code)) {
      await db.update(schema.platformConnections).set({ lastCheckedAt: now }).where(eq(schema.platformConnections.socialAccountId, account.id));
      await record({ loginStatus: 'logged_out', lastError: (err as Error).message.slice(0, 500) }, `${adapter.name} API: ${code}`);
      await ctx.log('warn', 'authorisation invalid', { code });
      return { outcome: 'authorisation_invalid', code };
    }
    throw err;
  }
}

registerTaskHandler<{ socialAccountId: string }>(ACCOUNT_CHECK_TASK, {
  queue: 'task-ops',
  timeoutMs: 2 * 60_000,
  maxAttempts: 1,
  run: (ctx) => checkSocialAccount(ctx.payload.socialAccountId ?? ctx.task.refId!, ctx),
});
