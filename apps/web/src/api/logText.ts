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
  'check: account login not checked yet': 'checkLoginUnknown',
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
  'drafts: skipped (switched off)': 'draftsSkipped',
  'drafts: the API refused the refusal fallback parameters, retrying once without them': 'draftsNoFallbackRetry',
  // comment replies (no approval step since 2026-11-18)
  submitted: 'replySubmitted',
  'approval removed': 'approvalRemoved',
  'test mode removed: rehearsal turned back into a draft': 'testModeDraft',
  'test mode removed: rehearsal cancelled (the comment already has another reply)': 'testModeCancelled',
  'test mode removed: rehearsal kept as cancelled, schedule it again with retry': 'testModePublish',
  'draft deleted': 'draftDeleted',
  // 社交号自动检测 (task account-device-check)
  'account check: own profile read': 'acctProfileRead',
  'account check: username not readable': 'acctNoUsername',
  'account check: login screen': 'acctLoginScreen',
  'account check: challenge screen, device halted': 'acctChallenge',
  'account check: profile did not show in time': 'acctTimeout',
  // 从云手机同步 (task account-device-sync)
  'account sync: username not readable': 'acctNoUsername',
  'account sync: login screen': 'acctLoginScreen',
  'account sync: challenge screen, device halted': 'acctChallenge',
  'account sync: profile did not show in time': 'acctTimeout',
  // 同步 button: step 2 (feed-collect) queued by step 1 (account-device-sync / tracked-refresh)
  'feed collection queued': 'feedQueued',
  'following sync queued': 'followingQueued',
  // 帖子与评论采集 (task feed-collect) / 云手机发评论 (comment-reply on the device)
  'feed: profile opened': 'feedOpened',
  'feed: no posts on the profile': 'feedNoPosts',
  'feed: private account, posts not visible': 'feedPrivate',
  'feed: post ids read': 'feedIds',
  'feed: post did not show': 'feedPostMissing',
  'feed: comments did not open': 'feedCommentsMissing',
  'feed: post read': 'feedPostRead',
  'reply: post opened': 'replyPostOpened',
  'reply: comments opened': 'replyCommentsOpened',
  'reply: replying to the comment': 'replyReplying',
  'reply: text pasted and read back': 'replyPasted',
  'reply: test mode, not sent; field cleared': 'replyTestCleared',
  'reply: sent and seen in the comments': 'replySeen',
  'reply: the input field could not be cleared': 'replyClearFailed',
  'device screen excerpt': 'replyExcerpt',
  'device halted (risk control): waiting until an admin resumes it': 'replyHalted',
  'test mode: text pasted and checked on the phone, not sent (field cleared)': 'replyDryRun',
  'sent from the cloud phone and seen in the comments': 'replySentDevice',
  'device resumed: queued again': 'replyResumed',
  'post comment written': 'postCommentWritten',
  // 云手机发帖
  'cloud phone: test mode (stops before sharing)': 'deviceTest',
  'cloud phone: live (shares the post)': 'deviceLive',
  'failed before 分享: not counted toward the daily cap / minimum gap': 'deviceNotCounted',
  'published from the cloud phone and seen on the profile': 'devicePublished',
  'test mode: rehearsed on the cloud phone up to sharing, nothing posted (draft discarded)': 'deviceDryRun',
  'publish: account on the phone verified': 'pubAccountOk',
  'publish: media pushed to the phone gallery': 'pubPushed',
  'publish: share screen opened': 'pubShareOpened',
  'publish: carousel items added in order': 'pubCarousel',
  'publish: last screen before sharing reached': 'pubLastScreen',
  'publish: caption pasted and read back': 'pubCaption',
  'publish: test mode, not shared; draft discarded': 'pubTestDone',
  'publish: draft discarded': 'pubDiscarded',
  'publish: one-time notice acknowledged': 'pubNux',
  'publish: share tapped': 'pubShareTapped',
  'publish: share confirmed on the follow-up screen': 'pubShareConfirmed',
  'publish: post seen on the profile': 'pubSeen',
  'publish: new post not on the profile yet': 'pubNotYet',
  'publish: new story not on the profile yet': 'pubStoryNotYet',
  'publish: own profile not shown yet': 'pubProfileNotYet',
  'publish: media kept on the phone (upload not confirmed)': 'pubKept',
  'publish: caption copy for the read-back gave nothing, trying again': 'pubCopyRetry',
}
const methodName = (m: string) => (te(`publish.method.${m}`) ? t(`publish.method.${m}`) : m)

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
  [/^run started \(round (\d+)\)$/, 'runStartedRound', (m) => ({ round: m[1]! })],
  [/^(failed|cancelled) \(scheduler task (\w+)\)$/, 'schedulerEnded', (m) => ({ status: status('publish', m[1]!), task: status('tasks', m[2]!) })],
  [/^send started \(attempt (\d+)\/(\d+)\)$/, 'sendStarted', (m) => ({ n: m[1]!, max: m[2]! })],
  [/^send rate limit reached \((\d+)\/(\d+) per hour\), deferred$/, 'rateLimited', (m) => ({ n: m[1]!, max: m[2]! })],
  [/^(daily limit reached \(\d+\/\d+ per 24 h\)|minimum gap between two sends not reached \(\d+ s\)|device busy or paced \(\S+\)), deferred$/, 'replyDeferred', (_m, d) => ({ msg: coded(String(d?.code ?? ''), d) })],
  [/^method (\w+) not available: (\S+)$/, 'methodUnavailable', (m) => ({ method: methodName(m[1]!), msg: codeText(m[2]!, undefined, m[2]!) })],
  [/^method (\w+)$/, 'methodTry', (m) => ({ method: methodName(m[1]!) })],
  [/^(daily limit reached \(\d+\/\d+ per 24 h\)|minimum gap between two posts not reached \(\d+ min\)), deferred$/, 'publishDeferred', (_m, d) => ({ msg: coded(String(d?.code ?? ''), d) })],
  [/^handed over to an operator: ([\s\S]+)$/, 'handedOverWhy', (m, d) => ({ msg: coded(m[1]!, d) })],
  [/^feed collection skipped: (\S+)$/, 'feedSkipped', (m) => ({ msg: codeText(m[1]!, undefined, m[1]!) })],
  [/^feed collection failed: (\S+)$/, 'feedFailed', (m) => ({ msg: codeText(m[1]!, undefined, m[1]!) })],
  [/^feed collection not queued: (\S+)$/, 'feedNotQueued', (m) => ({ msg: codeText(m[1]!, undefined, m[1]!) })],
  [/^following sync not queued: (\S+)$/, 'followingNotQueued', (m) => ({ msg: codeText(m[1]!, undefined, m[1]!) })],
  // 追踪中 (task account-following)
  [/^following: own profile read$/, 'followingProfileRead', (_m, d) => ({ n: String(d?.following ?? '?') })],
  [/^following: list stopped growing before its end$/, 'followingStalled', () => ({})],
  [/^following sync skipped: (\S+)$/, 'followingSkipped', (m) => ({ msg: codeText(m[1]!, undefined, m[1]!) })],
  [/^following sync failed: (\S+)$/, 'followingFailed', (m) => ({ msg: codeText(m[1]!, undefined, m[1]!) })],
  [/^following list read: (\d+) accounts \((\d+) new, (\d+) gone\)$/, 'followingRead', (m) => ({ n: m[1]!, added: m[2]!, gone: m[3]! })],
  // 粉丝 list (≤ 20 newest, same task)
  [/^followers: list stopped growing before its end$/, 'followersStalled', () => ({})],
  [/^followers list skipped: (\S+)$/, 'followersSkipped', (m) => ({ msg: codeText(m[1]!, undefined, m[1]!) })],
  [/^followers list read: (\d+) accounts \((\d+) new, (\d+) gone\)$/, 'followersRead', (m) => ({ n: m[1]!, added: m[2]!, gone: m[3]! })],
  [/^feed collected: (\d+) posts \((\d+) new\), (\d+) comments \((\d+) new\)$/, 'feedCollected', (m) => ({ posts: m[1]!, newPosts: m[2]!, comments: m[3]!, newComments: m[4]! })],
  [/^task (\w+)$/, 'taskEnded', (m) => ({ status: status('tasks', m[1]!) })],
  // 定时采集 / 趋势热点
  [/^scheduled refresh skipped: (\S+)$/, 'scheduledSkipped', (m) => ({ msg: codeText(m[1]!, undefined, m[1]!) })],
  [/^deferred: (\S+)$/, 'deferred', (m) => ({ msg: codeText(m[1]!, undefined, m[1]!) })],
  [/^collector: visit started$/, 'collectorVisit', (_m, d) => ({ device: typeof d?.device === 'string' ? d.device : '' })],
  [/^account check: device accounts read$/, 'acctDeviceAccounts', (_m, d) => ({ count: String(d?.count ?? '?') })],
  [/^account check result: (\w+)$/, 'acctResult', (m) => ({ result: te(`social.checkResult.${m[1]}`) ? t(`social.checkResult.${m[1]}`) : m[1]! })],
  [/^account check skipped: (\S+)$/, 'acctSkipped', (m) => ({ msg: codeText(m[1]!, undefined, m[1]!) })],
  [/^account sync: device accounts read$/, 'acctDeviceAccounts', (_m, d) => ({ count: String(d?.count ?? '?') })],
  [/^account sync: own profile read$/, 'syncProfileRead', (_m, d) => ({ handle: typeof d?.handle === 'string' ? d.handle : '?' })],
  [/^account sync result: (\w+)$/, 'syncResult', (m) => ({ result: te(`social.sync.result.${m[1]}`) ? t(`social.sync.result.${m[1]}`) : m[1]! })],
  [/^account sync skipped: (\S+)$/, 'syncSkipped', (m) => ({ msg: codeText(m[1]!, undefined, m[1]!) })],
  [/^stored (\d+) trending videos for (\w+)$/, 'trendingStored', (m) => ({ n: m[1]!, region: m[2]! })],
  [/^collection: (\d+) tracked refreshes queued, (\d+) skipped; (\d+) trending refreshes queued; (\d+) old trending snapshots deleted$/, 'collectionTick',
    (m) => ({ queued: m[1]!, skipped: m[2]!, trending: m[3]!, purged: m[4]! })],
  [/^deleted (\d+) read and (\d+) unread notifications, (\d+) alert states$/, 'notificationsDeleted', (m) => ({ read: m[1]!, unread: m[2]!, states: m[3]! })],
  // 人设每日草稿 (AI)
  [/^drafts: requesting (\d+) from (\S+)$/, 'draftsRequest', (m) => ({ n: m[1]!, model: m[2]! })],
  [/^drafts: the model declined \(category (\S+)\)$/, 'draftsDeclined', (m) => ({ category: m[1]! })],
  [/^drafts: (\d+) drafts written for (\S+) \(served by (\S+)\)$/, 'draftsWritten', (m) => ({ n: m[1]!, user: m[2]!, model: m[3]! })],
  [/^drafts: (\d+) dropped for a banned word$/, 'draftsDropped', (m) => ({ n: m[1]! })],
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

