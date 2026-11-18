import { t, te, dateLocale } from '../i18n'
import { codeText } from './client'

/**
 * Task / publish / comment log lines are stored in English by the API (stable for grep and ops).
 * The UI translates the known ones here; unknown messages are shown as stored.
 */
type Data = Record<string, unknown> | null | undefined
type Rule = [RegExp, string, (m: RegExpMatchArray, data: Data) => Record<string, string | number>]

const coded = (raw: string, data: Data) => {
  const code = typeof data?.code === 'string' ? data.code : undefined
  const params = Object.fromEntries(Object.entries(data ?? {}).filter(([, v]) => typeof v === 'string' || typeof v === 'number')) as Record<string, string | number>
  return codeText(code, params, raw)
}
const status = (ns: string, s: string) => (te(`${ns}.status.${s}`) ? t(`${ns}.status.${s}`) : s)

/** Exact messages → key under `logMsg.text`. */
const EXACT: Record<string, string> = {
  created: 'created',
  scheduled: 'scheduled',
  'cancelled before it started': 'cancelledBeforeStart',
  'cancel requested while running': 'cancelRequested',
  'retried as a new task': 'retriedAsNew',
  succeeded: 'succeeded',
  'succeeded (cancel was requested, but the task completed)': 'succeededDespiteCancel',
  'cancelled while running': 'cancelledWhileRunning',
  'job was missing; enqueued again at startup': 'reenqueued',
  'retention disabled: nothing deleted': 'retentionDisabled',
  'cancelled: official platform APIs removed': 'cancelledApisRemoved',
  'official platform APIs removed: this round will be handed to an operator': 'publishApisRemoved',
  'handed over to an operator: publish by hand on the bound device, then record the outcome': 'handedOverPublish',
  'not executed: the publish task is no longer driven by this task': 'publishDetached',
  'awaiting operator': 'awaitingOperator',
  'check: account owner ok': 'checkOwner',
  'check: account active': 'checkActive',
  'check: platform enabled on the device': 'checkPlatformEnabled',
  'check: media ready and valid for the platform': 'checkMedia',
  'check: not published before on this account': 'checkNotPublished',
  'check: device online': 'checkDeviceOnline',
  'check: account logged in on the device': 'checkLoggedIn',
  distributed: 'distributed',
  'distributed (re-publish)': 'distributedRepublish',
  rescheduled: 'rescheduled',
  retried: 'retried',
  cancelled: 'cancelled',
  edited: 'edited',
  'operator recorded: published': 'operatorPublished',
  'operator recorded: failed': 'operatorFailed',
  'operator recorded: sent': 'operatorSent',
  'not executed: the reply is no longer driven by this task': 'replyDetached',
  'rate limit reached: deferred to a new round': 'rateDeferred',
  'handed over to an operator: reply by hand on the phone, then record the outcome': 'handedOverReply',
  'comment entered manually': 'enteredManually',
  'draft written': 'draftWritten',
  'self-approval refused': 'selfApproval',
  'the comment was already replied to': 'alreadyReplied',
  'test handler running': 'testRunning',
  'telegram disabled: not sent': 'telegramDisabled',
  'telegram message sent': 'telegramSent',
  'alert channel deleted: not sent': 'channelDeleted',
  'alert channel disabled: not sent': 'channelDisabled',
  'alert message sent': 'channelSent',
  'collector: profile link opened': 'collectorOpened',
  'collector: profile read': 'collectorRead',
  'collector: profile header could not be parsed': 'collectorParseFailed',
  'collector: challenge screen, collection halted': 'collectorChallenge',
  'collector: Instagram is not logged in': 'collectorLoggedOut',
  'collector: profile not available': 'collectorUnavailable',
  'collector: profile did not show in time': 'collectorTimeout',
}

const RULES: Rule[] = [
  [/^failed: ([\s\S]*)$/, 'failed', (m, d) => ({ msg: coded(m[1]!, d) })],
  [/^attempt failed, will retry: ([\s\S]*)$/, 'attemptFailedWillRetry', (m, d) => ({ msg: coded(m[1]!, d) })],
  [/^failure hook error: ([\s\S]*)$/, 'failureHook', (m) => ({ msg: m[1]! })],
  [/^could not schedule: ([\s\S]*)$/, 'couldNotSchedule', (m) => ({ msg: m[1]! })],
  [/^attempt (\d+)\/(\d+) started$/, 'attemptStarted', (m) => ({ n: m[1]!, max: m[2]! })],
  [/^attempt (\d+)\/(\d+) failed, retrying$/, 'attemptRetrying', (m) => ({ n: m[1]!, max: m[2]! })],
  [/^deleted (\d+) finished tasks \((\d+) log lines\) finished before (.+)$/, 'retentionDeleted',
    (m) => ({ tasks: m[1]!, logs: m[2]!, cutoff: isNaN(Date.parse(m[3]!)) ? m[3]! : new Date(m[3]!).toLocaleString(dateLocale()) })],
  [/^pg_dump of (\S+) started$/, 'backupStarted', (m) => ({ db: m[1]! })],
  [/^backup stored \((\d+) bytes\)$/, 'backupStored', (m) => ({ size: m[1]! })],
  [/^deleted (\d+) old backups$/, 'backupsPruned', (m) => ({ n: m[1]! })],
  [/^run started \(round (\d+), attempt (\d+)\/(\d+)\)$/, 'runStarted', (m) => ({ round: m[1]!, n: m[2]!, max: m[3]! })],
  [/^(failed|cancelled) \(scheduler task (\w+)\)$/, 'schedulerEnded', (m) => ({ status: status('publish', m[1]!), task: status('tasks', m[2]!) })],
  [/^send started \(attempt (\d+)\/(\d+)\)$/, 'sendStarted', (m) => ({ n: m[1]!, max: m[2]! })],
  [/^send rate limit reached \((\d+)\/(\d+) per hour\), deferred$/, 'rateLimited', (m) => ({ n: m[1]!, max: m[2]! })],
  [/^task (\w+)$/, 'taskEnded', (m) => ({ status: status('tasks', m[1]!) })],
  // 定时采集 / 趋势热点
  [/^scheduled refresh skipped: (\S+)$/, 'scheduledSkipped', (m) => ({ msg: codeText(m[1]!, undefined, m[1]!) })],
  [/^deferred: (\S+)$/, 'deferred', (m) => ({ msg: codeText(m[1]!, undefined, m[1]!) })],
  [/^collector: visit started$/, 'collectorVisit', (_m, d) => ({ device: typeof d?.device === 'string' ? d.device : '' })],
  [/^stored (\d+) trending videos for (\w+)$/, 'trendingStored', (m) => ({ n: m[1]!, region: m[2]! })],
  [/^collection: (\d+) tracked refreshes queued, (\d+) skipped; (\d+) trending refreshes queued; (\d+) old trending snapshots deleted$/, 'collectionTick',
    (m) => ({ queued: m[1]!, skipped: m[2]!, trending: m[3]!, purged: m[4]! })],
  [/^deleted (\d+) read and (\d+) unread notifications, (\d+) alert states$/, 'notificationsDeleted', (m) => ({ read: m[1]!, unread: m[2]!, states: m[3]! })],
  [/^(\w+) → (\w+)$/, 'commentStatus', (m) => ({ from: status('comments', m[1]!), to: status('comments', m[2]!) })],
]

export function logText(message: string | null | undefined, data?: Data): string {
  if (!message) return ''
  const exact = EXACT[message]
  if (exact) return t(`logMsg.text.${exact}`)
  for (const [re, key, params] of RULES) {
    const m = message.match(re)
    if (m) return t(`logMsg.text.${key}`, params(m, data))
  }
  return message
}

/** Label of a comment log action (`comment_logs.action`). */
export const commentActionText = (a: string) => (te(`logMsg.commentAction.${a}`) ? t(`logMsg.commentAction.${a}`) : a)

