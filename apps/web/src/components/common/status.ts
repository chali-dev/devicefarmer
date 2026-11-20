import {
  COMMENT_REPLY_STATUS_COLOR, COMMENT_STATUS_COLOR, CONTENT_STATUS_COLOR, PUBLISH_STATUS_COLOR,
  SOCIAL_ACCOUNT_COLOR, SOCIAL_LOGIN_COLOR, TASK_STATUS_COLOR, TRACKED_STATUS_COLOR, taskStatusText, type InstanceStatus,
} from '../../api/types'
import { t, te } from '../../i18n'
import { STATUS_COLOR as MEDIA_STATUS_COLOR } from '../media/media'

/**
 * One place that maps every status family to its Ant Design colour and its label.
 * Colours are semantic presets: success (done/ok), processing (running), warning (needs attention),
 * error (failed), default (idle/neutral); purple = scheduled, gold = waiting for review.
 * Render with <StatusTag kind="…" :status="…" />. A new family = one entry here.
 */
export const INSTANCE_STATUS_COLOR: Record<InstanceStatus, string> = {
  creating: 'processing', starting: 'processing', running: 'success', stopping: 'processing',
  stopped: 'default', restarting: 'processing', deleting: 'warning', error: 'error',
}
const BACKUP_STATUS_COLOR: Record<string, string> = { running: 'processing', ok: 'success', failed: 'error' }

interface StatusFamily { colors: Record<string, string>; label: (s: string) => string }
const prefixed = (prefix: string) => (s: string) => (te(`${prefix}.${s}`) ? t(`${prefix}.${s}`) : s)

export const STATUS_FAMILIES = {
  instance: { colors: INSTANCE_STATUS_COLOR, label: prefixed('status') },
  task: { colors: TASK_STATUS_COLOR, label: taskStatusText },
  socialLogin: { colors: SOCIAL_LOGIN_COLOR, label: prefixed('social.login') },
  socialAccount: { colors: SOCIAL_ACCOUNT_COLOR, label: prefixed('social.account') },
  tracked: { colors: TRACKED_STATUS_COLOR, label: prefixed('tracked.status') },
  content: { colors: CONTENT_STATUS_COLOR, label: prefixed('content.status') },
  publish: { colors: PUBLISH_STATUS_COLOR, label: prefixed('publish.status') },
  comment: { colors: COMMENT_STATUS_COLOR, label: prefixed('comments.status') },
  commentReply: { colors: COMMENT_REPLY_STATUS_COLOR, label: prefixed('comments.replyStatus') },
  media: { colors: MEDIA_STATUS_COLOR, label: prefixed('media.statuses') },
  backup: { colors: BACKUP_STATUS_COLOR, label: prefixed('sysadmin.backup.status') },
  alertChannel: { colors: { ok: 'success', failed: 'error', never: 'default' }, label: prefixed('alertChannels.result') },
} satisfies Record<string, StatusFamily>

export type StatusKind = keyof typeof STATUS_FAMILIES

export const statusColor = (kind: StatusKind, s: string): string => (STATUS_FAMILIES[kind].colors as Record<string, string>)[s] ?? 'default'
export const statusLabel = (kind: StatusKind, s: string): string => STATUS_FAMILIES[kind].label(s)
/** For <a-badge :status>: tag-only colours (purple, gold, …) fall back to 'default'. */
export const statusBadge = (kind: StatusKind, s: string): 'success' | 'processing' | 'default' | 'error' | 'warning' => {
  const c = statusColor(kind, s)
  return c === 'success' || c === 'processing' || c === 'error' || c === 'warning' ? c : 'default'
}
