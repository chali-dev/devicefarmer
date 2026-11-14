import { t, te } from '../i18n'

export type Role = 'admin' | 'user'
export const ROLES: Role[] = ['admin', 'user']
export const roleText = (r: Role) => t(`roles.${r}`)
export type InstanceStatus = 'creating' | 'starting' | 'running' | 'stopping' | 'stopped' | 'restarting' | 'deleting' | 'error'

export interface User { id: string; username: string; role: Role; displayName?: string | null; email?: string | null; builtin?: boolean }
export interface ManagedUser extends User { disabled: boolean; builtin: boolean; createdAt: string; instanceIds: string[] }

export interface Instance {
  id: string
  name: string
  engine: 'redroid' | 'emulator'
  profile: string
  image: string
  adbPort: number
  containerId: string | null
  status: InstanceStatus
  adbState: string | null
  bootCompleted: boolean
  stfReady: boolean
  lastError: string | null
  google: GoogleHealth | null
  netContainerId: string | null
  /** Bound pool proxy (non-secret fields only). */
  proxy: InstanceProxy | null
  proxyStatus: { checkedAt: string; ok: boolean; egressIp: string | null; latencyMs: number | null; dnsOk: boolean; error: string | null } | null
  spec: { width: number; height: number; dpi: number; memoryMb?: number; locale?: string; timezone?: string; deviceName?: string }
  createdAt: string
  updatedAt: string
  /** Users granted this device; only returned to admins. */
  owners?: InstanceOwner[]
}

export interface InstanceOwner { id: string; username: string; displayName: string | null }

export interface GoogleHealth {
  checkedAt: string
  gms: { installed: boolean; version: string | null; running: boolean }
  gsf: { installed: boolean; gsfId: string | null }
  playStore: { installed: boolean; version: string | null }
  youtube: { installed: boolean; version: string | null; playing: boolean }
  googleAccounts: number
}

export interface InstalledApp { package: string; versionName: string | null; versionCode: string | null; protected: boolean }

export interface LibraryApp {
  id: string; package: string; versionName: string | null; versionCode: string
  files: { name: string; size: number; sha256: string }[]; preinstall: boolean; sourceInstance: string | null; createdAt: string
}

export type ProxyType = 'socks5' | 'http'
export type ProxyStatus = 'unchecked' | 'ok' | 'failed'
export const PROXY_STATUS_COLOR: Record<ProxyStatus, string> = { unchecked: 'default', ok: 'success', failed: 'error' }

/** What any user who can see a device knows about its proxy (no credentials). */
export interface InstanceProxy {
  id: string; label: string | null; type: ProxyType; host: string; port: number
  country: string | null; city: string | null; hasAuth: boolean; status: ProxyStatus
}

export interface ProxyCheck { at: string; ok: boolean; egressIp: string | null; latencyMs: number | null; country: string | null; city: string | null; error: string | null }

/** Pool entry (admin API). The password is write-only: only `hasPassword` is returned. */
export interface PoolProxy {
  id: string; label: string | null; type: ProxyType; host: string; port: number; username: string | null; hasPassword: boolean
  country: string | null; region: string | null; city: string | null; provider: string | null; notes: string | null
  status: ProxyStatus; lastCheck: ProxyCheck | null; createdAt: string; updatedAt: string
  boundInstance: { id: string; name: string } | null
}

export interface ProxyImportLine { line: number; input: string; status: 'created' | 'duplicate' | 'invalid'; id?: string; error?: string }
export interface ProxyImportResult { dryRun: boolean; results: ProxyImportLine[]; created: number; duplicate: number; invalid: number }

/** Short display of a device's / pool proxy. */
export const proxyLabel = (p: { label: string | null; host: string; port: number }) => p.label || `${p.host}:${p.port}`

export interface Profile { id: string; label: string; engine: string; gapps: boolean; available: boolean; reason: string | null }

export type TaskStatus = 'pending' | 'scheduled' | 'running' | 'success' | 'failed' | 'cancelled'
export const TASK_STATUSES: TaskStatus[] = ['pending', 'scheduled', 'running', 'success', 'failed', 'cancelled']
export const TASK_FINAL: TaskStatus[] = ['success', 'failed', 'cancelled']

/** Task-centre row (lists and events carry no payload/result; GET /api/tasks/:id adds them). */
export interface Task {
  id: string
  type: string
  instanceId: string | null
  /** Display label (device name · detail, or e.g. the media name). */
  instanceName: string | null
  refType: string | null
  refId: string | null
  status: TaskStatus
  attempts: number
  maxAttempts: number
  timeoutMs: number | null
  priority: number
  idempotencyKey: string | null
  retryOf: string | null
  runAt: string | null
  cancelRequested: boolean
  /** Last error and its code (translated as errors.<code>). */
  error: string | null
  errorCode: string | null
  createdBy?: string | null
  /** Username of createdBy (GET /api/tasks only; null = system task). */
  createdByName?: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string
}
export interface TaskDetail extends Task { payload: Record<string, unknown> | null; result: unknown; canCancel: boolean; canRetry: boolean }
export interface TaskLog { id: string; taskId: string; ts: string; level: 'debug' | 'info' | 'warn' | 'error'; message: string; data: Record<string, unknown> | null }
export interface TaskStats { byStatus: Record<TaskStatus, number>; byType: Record<string, number>; types: string[] }

/** Localized task type (unknown types are shown raw). */
export const taskText = (type: string) => (te(`tasks.types.${type}`) ? t(`tasks.types.${type}`) : type)
export const TASK_STATUS_COLOR: Record<TaskStatus, string> = { pending: 'default', scheduled: 'purple', running: 'processing', success: 'success', failed: 'error', cancelled: 'warning' }
/** Badge status for a-badge (no colour names). */
export const TASK_STATUS_BADGE: Record<TaskStatus, 'default' | 'processing' | 'success' | 'error' | 'warning'> = { pending: 'default', scheduled: 'default', running: 'processing', success: 'success', failed: 'error', cancelled: 'warning' }
export const taskStatusText = (s: string) => (te(`tasks.status.${s}`) ? t(`tasks.status.${s}`) : s)

export type PlatformEvent =
  | { type: 'instance.updated'; instance: Instance }
  | { type: 'instance.deleted'; instanceId: string }
  | { type: 'task.updated'; task: Task }
  | { type: 'task.log'; taskId: string; instanceId: string | null; createdBy: string | null; log: TaskLog }

export const BUSY_STATUSES: InstanceStatus[] = ['creating', 'starting', 'stopping', 'restarting', 'deleting']

export type MediaScope = 'public' | 'mine' | 'favorites' | 'all-users'
export type MediaStatus = 'processing' | 'ready' | 'failed' | 'disabled'
export interface MediaItem {
  id: string
  ownerType: 'public' | 'user'
  ownerId: string | null
  ownerName: string | null
  categoryId: string | null
  categoryName: string | null
  name: string
  fileName: string
  storage: 'local' | 's3'
  fileType: 'image' | 'video'
  mimeType: string
  fileSize: number
  width: number | null
  height: number | null
  /** seconds (videos) */
  duration: number | null
  checksum: string
  status: MediaStatus
  error: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
  tags: string[]
  isFavorite: boolean
  /** The current user may edit/delete it. */
  canManage: boolean
  contentUrl: string
  thumbnailUrl: string | null
}
export interface MediaCategory {
  id: string; ownerType: 'public' | 'user'; ownerId: string | null; name: string; sort: number; count: number; createdAt: string; updatedAt: string
}
export interface MediaFormatLimit { id: string; mime: string; mimes: string[]; exts: string[] }
export interface MediaLimits {
  image: { maxMb: number; formats: MediaFormatLimit[] }
  video: { maxMb: number; formats: MediaFormatLimit[] }
}

export interface StorageSettings {
  type: 'local' | 's3'
  s3: { endpoint?: string; region: string; bucket: string; accessKeyId: string; forcePathStyle: boolean; prefix?: string; hasSecret: boolean } | null
}

export interface StorageTestResult { ok: boolean; latencyMs: number; error: string | null }

export interface AuditLog {
  id: string
  at: string
  userId: string | null
  username: string | null
  action: string
  target: string | null
  targetId: string | null
  method: string
  path: string
  status: number
  ok: boolean
  ip: string | null
  detail: Record<string, unknown> | null
}
/** Localized label for known audit actions (unknown ones are shown raw). Keys use '_' for '.'. */
export function auditActionText(action: string): string {
  const key = `audit.actions.${action.replace(/\./g, '_')}`
  return te(key) ? t(key) : action
}

/** Localized profile (image) label; falls back to the API's label. */
export function profileLabel(id: string, fallback: string): string {
  return te(`profiles.${id}`) ? t(`profiles.${id}`) : fallback
}

// ---------------------------------------------------------------- social accounts (社交账号)
export type SocialLoginStatus = 'unknown' | 'logged_in' | 'logged_out' | 'needs_verification'
export type SocialAccountStatus = 'active' | 'limited' | 'suspended' | 'disabled'
export const SOCIAL_LOGIN_STATUSES: SocialLoginStatus[] = ['unknown', 'logged_in', 'logged_out', 'needs_verification']
export const SOCIAL_ACCOUNT_STATUSES: SocialAccountStatus[] = ['active', 'limited', 'suspended', 'disabled']
export const SOCIAL_LOGIN_COLOR: Record<SocialLoginStatus, string> = { unknown: 'default', logged_in: 'success', logged_out: 'warning', needs_verification: 'error' }
export const SOCIAL_ACCOUNT_COLOR: Record<SocialAccountStatus, string> = { active: 'success', limited: 'warning', suspended: 'error', disabled: 'default' }

export interface SocialPlatform { id: string; name: string; defaultLimit: number; limit: number }

export interface SocialAccount {
  id: string
  userId: string
  ownerName: string | null
  platform: string
  handle: string
  displayName: string | null
  profileUrl: string | null
  externalId: string | null
  groupId: string | null
  groupName: string | null
  tags: string[]
  instanceId: string | null
  instance: { id: string; name: string; status: string; accessible: boolean } | null
  /** Derived from the device's pool proxy (non-secret fields). */
  proxy: InstanceProxy | null
  loginStatus: SocialLoginStatus
  accountStatus: SocialAccountStatus
  notes: string | null
  lastCheckedAt: string | null
  lastError: string | null
  exception: boolean
  createdAt: string
  updatedAt: string
}

export interface SocialGroup { id: string; userId: string; ownerName: string; name: string; count: number }

export interface SocialAccountLog {
  id: string
  at: string
  actorId: string | null
  actorName: string | null
  action: 'create' | 'update' | 'status' | 'checked' | 'link' | 'unlink'
  field: string | null
  fromValue: string | null
  toValue: string | null
  message: string | null
}

// ---- tracked accounts (追踪账号)
export type TrackedStatus = 'active' | 'paused' | 'error'
export const TRACKED_STATUS_COLOR: Record<TrackedStatus, string> = { active: 'success', paused: 'default', error: 'error' }
export type TrackedMetric = 'followers' | 'following' | 'posts' | 'views'
/** api = official API configured; api_unconfigured = API exists but no credentials; manual_only = manual entry only. */
export type TrackedDataMode = 'api' | 'api_unconfigured' | 'manual_only'
export interface TrackedPlatform {
  id: string; label: string; metrics: TrackedMetric[]
  api: { profile: boolean; recentPosts: boolean; metrics: TrackedMetric[]; configured: boolean } | null
}
export interface TrackedAccount {
  id: string; userId: string; ownerName: string | null; platform: string; handle: string; profileUrl: string
  externalId: string | null; displayName: string | null; avatarUrl: string | null; bio: string | null
  category: string | null; tags: string[]; favorite: boolean; status: TrackedStatus; notes: string | null
  lastCheckedAt: string | null; lastError: string | null; lastErrorCode: string | null; lastSource: 'api' | 'manual' | null
  createdAt: string; updatedAt: string; dataMode: TrackedDataMode
  latest: { capturedAt: string; source: 'api' | 'manual'; followers: number | null; following: number | null; posts: number | null; views: number | null } | null
  followers: number | null; followersDelta: number | null; followersPrevAt: string | null
  lastRefresh: { id: string; status: TaskStatus; error: string | null; createdAt: string; finishedAt: string | null } | null
}
export interface TrackedSnapshot {
  id: string; capturedAt: string; source: 'api' | 'manual'
  followers: number | null; following: number | null; posts: number | null; views: number | null
}
export interface TrackedPost {
  id: string; externalId: string; url: string | null; title: string | null; publishedAt: string | null
  views: number | null; likes: number | null; comments: number | null; source: 'api' | 'manual'; firstSeenAt: string; lastSeenAt: string
}
/** "@handle", or the bare YouTube channel id. */
export const trackedHandle = (a: Pick<TrackedAccount, 'handle'>) => (/^UC[A-Za-z0-9_-]{22}$/.test(a.handle) ? a.handle : `@${a.handle}`)
/** Compact count (1.2K / 3.4M), full number in a tooltip elsewhere. */
export function compactNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

// ---------------------------------------------------------------- content (内容管理) + publish scheduler (定时发布)
export type ContentStatus = 'draft' | 'ready' | 'scheduled' | 'partially_published' | 'published' | 'failed' | 'archived'
export const CONTENT_STATUSES: ContentStatus[] = ['draft', 'ready', 'scheduled', 'partially_published', 'published', 'failed', 'archived']
export const CONTENT_STATUS_COLOR: Record<ContentStatus, string> = {
  draft: 'default', ready: 'blue', scheduled: 'purple', partially_published: 'gold', published: 'success', failed: 'error', archived: 'default',
}
export type PublishStatus = 'pending' | 'scheduled' | 'running' | 'awaiting_operator' | 'published' | 'failed' | 'cancelled'
export const PUBLISH_STATUSES: PublishStatus[] = ['pending', 'scheduled', 'running', 'awaiting_operator', 'published', 'failed', 'cancelled']
export const PUBLISH_UNFINISHED: PublishStatus[] = ['pending', 'scheduled', 'running', 'awaiting_operator']
export const PUBLISH_STATUS_COLOR: Record<PublishStatus, string> = {
  pending: 'default', scheduled: 'purple', running: 'processing', awaiting_operator: 'orange', published: 'success', failed: 'error', cancelled: 'default',
}
export interface ContentMedia {
  id: string; name: string; fileType: 'image' | 'video'; status: MediaStatus; ownerType: 'public' | 'user'
  width: number | null; height: number | null; duration: number | null; thumbnailUrl: string | null
}
export interface ContentHints {
  youtube?: { title?: string; description?: string; privacy?: 'public' | 'unlisted' | 'private' }
  instagram?: { caption?: string }
  tiktok?: { caption?: string }
}
export interface Content {
  id: string; userId: string; ownerName: string | null; title: string; body: string; category: string | null
  stage: 'draft' | 'ready' | 'archived'; status: ContentStatus; platformHints: ContentHints
  tags: string[]; media: ContentMedia[]; publishCounts: Partial<Record<PublishStatus, number>>
  createdAt: string; updatedAt: string
}
export interface PublishTaskItem {
  id: string; userId: string; ownerName: string | null; contentId: string; accountId: string; platform: string
  title: string | null; caption: string; hashtags: string[]; text: string; options: Record<string, unknown>; mediaIds: string[]
  scheduledAt: string; status: PublishStatus; method: 'api' | 'manual' | null; attemptNo: number; maxAttempts: number; taskId: string | null
  republish: boolean; externalId: string | null; url: string | null; error: string | null; errorCode: string | null; publishedAt: string | null
  createdAt: string; updatedAt: string
  content: { id: string; title: string; userId: string } | null
  account: { id: string; handle: string; displayName: string | null; platform: string; loginStatus: SocialLoginStatus; accountStatus: SocialAccountStatus } | null
  instance: { id: string; name: string; status: string; adbState: string | null; online: boolean; accessible: boolean } | null
  media: ContentMedia[]
}
export interface PublishLog {
  id: string; publishTaskId: string; at: string; level: 'debug' | 'info' | 'warn' | 'error'; message: string; data: Record<string, unknown> | null
  attemptNo: number | null; taskId: string | null; actorName: string | null
}
export interface PublishRun {
  id: string; status: TaskStatus; attempts: number; maxAttempts: number; runAt: string | null; idempotencyKey: string | null; retryOf: string | null
  error: string | null; errorCode: string | null; result: unknown; createdAt: string; startedAt: string | null; finishedAt: string | null
}
export interface PublishCapability {
  media: { min: number; max: number; kinds: ('image' | 'video')[]; mixed: boolean }
  title: { required: boolean; max: number } | null
  captionMax: number; hashtagsMax: number; privacy?: string[]
}
export interface PublishPlatform { id: string; name: string; capability: PublishCapability; methods: ('api' | 'manual')[]; known: boolean }
