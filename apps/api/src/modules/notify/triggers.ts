import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { Instance, PlatformConnection, PublishTask, SocialAccount, Task } from '../../db/schema.js';
import { onTaskFailed } from '../tasks/core.js';
import { notify, recover } from './notify.js';
import { TELEGRAM_TASK } from './telegram.js';

/**
 * Alert triggers: the kind-specific mapping from a state transition to notify()/recover(). Each is called
 * from the single place where that transition happens (monitor, device-op failure hook, account check,
 * connection state writes, publish failure hook, task centre). Never throw (notify/recover don't).
 */

/** Why a device went down (shown translated; also in Telegram texts). */
export type DownReason = 'container_missing' | 'container_exited' | 'sidecar_down' | 'powered_off' | 'op_failed';

/** Device status transition observed by the monitor (or a failed lifecycle op: reason op_failed + op). */
export async function deviceStatusChanged(inst: Pick<Instance, 'id' | 'name' | 'status'>, to: Instance['status'] | undefined, reason?: DownReason, op?: string): Promise<void> {
  if (!to || to === inst.status && reason !== 'op_failed') return;
  const a = { kind: 'device.down' as const, refId: inst.id, params: { name: inst.name, status: to, reason, op } };
  if (to === 'error' || to === 'stopped') await notify(a);
  else if (to === 'running') await recover(a);
}

const PROBLEM_LOGIN = new Set<string>(['logged_out', 'needs_verification']);
const PROBLEM_ACCOUNT = new Set<string>(['limited', 'suspended', 'disabled']);

/** Result of an account check (official API task or the manual "mark checked"). */
export async function accountChecked(acc: Pick<SocialAccount, 'id' | 'platform' | 'handle' | 'loginStatus' | 'accountStatus'>, code?: string | null): Promise<void> {
  const reason = PROBLEM_LOGIN.has(acc.loginStatus) ? acc.loginStatus : PROBLEM_ACCOUNT.has(acc.accountStatus) ? acc.accountStatus : null;
  const a = { kind: 'account.problem' as const, refId: acc.id, params: { platform: acc.platform, handle: acc.handle, reason, code } };
  if (reason) await notify(a);
  else if (acc.loginStatus === 'logged_in') await recover(a);
}

async function accountOf(id: string) {
  const [acc] = await db.select({ id: schema.socialAccounts.id, platform: schema.socialAccounts.platform, handle: schema.socialAccounts.handle })
    .from(schema.socialAccounts).where(eq(schema.socialAccounts.id, id));
  return acc;
}

/** The official-API check task failed (network, quota…): the account's state is unknown. */
export async function accountCheckFailed(accountId: string, code: string | null): Promise<void> {
  const acc = await accountOf(accountId).catch(() => undefined);
  if (acc) await notify({ kind: 'account.problem', refId: acc.id, params: { platform: acc.platform, handle: acc.handle, reason: 'check_failed', code } });
}

/** platform_connections.status written (modules/platforms/connections.ts). */
export async function connectionChanged(conn: Pick<PlatformConnection, 'socialAccountId' | 'platform'>, status: PlatformConnection['status'], code?: string | null): Promise<void> {
  const acc = await accountOf(conn.socialAccountId).catch(() => undefined);
  if (!acc) return;
  const a = { kind: 'connection.expired' as const, refId: acc.id, params: { platform: conn.platform, handle: acc.handle, status, code } };
  if (status === 'connected') await recover(a);
  else await notify(a);
}

/** A publish run ended failed (one alert per round). */
export async function publishFailed(row: Pick<PublishTask, 'id' | 'attemptNo' | 'platform' | 'accountId' | 'contentId' | 'errorCode'>): Promise<void> {
  const acc = await accountOf(row.accountId).catch(() => undefined);
  const [c] = await db.select({ title: schema.contents.title }).from(schema.contents).where(eq(schema.contents.id, row.contentId)).catch(() => []);
  await notify({ kind: 'publish.failed', refId: row.id, key: `${row.id}:${row.attemptNo}`, params: { platform: row.platform, handle: acc?.handle, title: c?.title, code: row.errorCode } });
}

/**
 * Generic task failure. Skipped: types with their own alert (publish, account check, device lifecycle ops →
 * device.down). Keyed per type + device/object, so a repeating failure is reported once per cooldown.
 * A failed Telegram delivery is reported in-app only (never through Telegram again).
 */
const OWN_ALERT = new Set(['publish', 'social-account-check', 'create', 'start', 'stop', 'restart', 'delete', 'set-proxy']);
onTaskFailed(async (task: Task) => {
  if (OWN_ALERT.has(task.type)) return;
  await notify({
    kind: 'task.failed', refId: task.id, key: `${task.type}:${task.instanceId ?? task.refId ?? task.id}`,
    params: { type: task.type, label: task.instanceName, code: task.errorCode }, inAppOnly: task.type === TELEGRAM_TASK,
  });
});
