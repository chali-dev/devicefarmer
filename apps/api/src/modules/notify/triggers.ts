import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { Instance, PublishTask, SocialAccount, Task } from '../../db/schema.js';
import { onTaskFailed } from '../tasks/core.js';
import { notify, recover } from './notify.js';

/**
 * Alert triggers: the kind-specific mapping from a state transition to notify()/recover(). Each is called
 * from the single place where that transition happens (monitor, device-op failure hook, automatic account
 * check, collector, publish failure hook, task centre). Never throw (notify/recover don't).
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

/**
 * Result of the automatic account check on the account's cloud phone (modules/social/check.ts; the manual
 * "mark checked" was removed on 2026-11-18). `reason` overrides the one derived from the statuses (wrong_account).
 */
export async function accountChecked(acc: Pick<SocialAccount, 'id' | 'platform' | 'handle' | 'loginStatus' | 'accountStatus'>, why?: string): Promise<void> {
  const reason = why ?? (PROBLEM_LOGIN.has(acc.loginStatus) ? acc.loginStatus : PROBLEM_ACCOUNT.has(acc.accountStatus) ? acc.accountStatus : null);
  const a = { kind: 'account.problem' as const, refId: acc.id, params: { platform: acc.platform, handle: acc.handle, reason } };
  if (reason) await notify(a);
  else if (acc.loginStatus === 'logged_in') await recover(a);
}

async function accountOf(id: string) {
  const [acc] = await db.select({ id: schema.socialAccounts.id, platform: schema.socialAccounts.platform, handle: schema.socialAccounts.handle })
    .from(schema.socialAccounts).where(eq(schema.socialAccounts.id, id));
  return acc;
}

/** A cloud phone stopped by 风控 on a challenge screen (blocked) or was resumed / read fine again. */
export async function collectorBlocked(inst: Pick<Instance, 'id' | 'name'>, platform: string, blocked: boolean, code?: string): Promise<void> {
  const a = { kind: 'collector.blocked' as const, refId: inst.id, key: `${inst.id}:${platform}`, params: { name: inst.name, platform, code } };
  if (blocked) await notify(a);
  else await recover(a);
}

/** A publish run ended failed (one alert per round). */
export async function publishFailed(row: Pick<PublishTask, 'id' | 'attemptNo' | 'platform' | 'accountId' | 'contentId' | 'errorCode'>): Promise<void> {
  const acc = await accountOf(row.accountId).catch(() => undefined);
  const [c] = await db.select({ title: schema.contents.title }).from(schema.contents).where(eq(schema.contents.id, row.contentId)).catch(() => []);
  await notify({ kind: 'publish.failed', refId: row.id, key: `${row.id}:${row.attemptNo}`, params: { platform: row.platform, handle: acc?.handle, title: c?.title, code: row.errorCode } });
}

/**
 * Generic task failure. Skipped: types with their own alert (publish, device lifecycle ops →
 * device.down; alert channel deliveries → channel.failed, in-app only, so a broken channel never loops).
 * Keyed per type + device/object, so a repeating failure is reported once per cooldown.
 */
const OWN_ALERT = new Set(['publish', 'create', 'start', 'stop', 'restart', 'delete', 'set-proxy']);
onTaskFailed(async (task: Task) => {
  if (OWN_ALERT.has(task.type) || task.type.startsWith('notify-')) return;
  await notify({
    kind: 'task.failed', refId: task.id, key: `${task.type}:${task.instanceId ?? task.refId ?? task.id}`,
    params: { type: task.type, label: task.instanceName, code: task.errorCode },
  });
});
