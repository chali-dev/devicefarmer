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
  engine: 'redroid' | 'emulator' | 'bitbrowser'
  /** Device source and the phone's id there (external phones, e.g. BitBrowser); null for local containers. */
  sourceId: string | null
  externalId: string | null
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
  proxyStatus: { checkedAt: string; ok: boolean; egressIp: string | null; latencyMs: number | null; dnsOk: boolean; error: string | null; country?: string | null; region?: string | null; city?: string | null } | null
  spec: { width: number; height: number; dpi: number; memoryMb?: number; locale?: string; timezone?: string; deviceName?: string }
  /** Social platforms allowed on the device; null = all. */
  allowedPlatforms: string[] | null
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
export const PROXY_KINDS = ['static', 'mobile'] as const
export type ProxyKind = (typeof PROXY_KINDS)[number]
export const PROXY_STATUS_COLOR: Record<ProxyStatus, string> = { unchecked: 'default', ok: 'success', failed: 'error' }

/** What any user who can see a device knows about its proxy (no credentials). */
export interface InstanceProxy {
  id: string; label: string | null; type: ProxyType; host: string; port: number
  country: string | null; city: string | null; hasAuth: boolean; status: ProxyStatus
}

export interface ProxyCheck { at: string; ok: boolean; egressIp: string | null; latencyMs: number | null; country: string | null; city: string | null; error: string | null }

/** Pool entry (admin API). The password is write-only: only `hasPassword` is returned. */
export interface PoolProxy {
  id: string; label: string | null; type: ProxyType; kind: ProxyKind; host: string; port: number; username: string | null; hasPassword: boolean
  country: string | null; region: string | null; city: string | null; provider: string | null; notes: string | null
  status: ProxyStatus; lastCheck: ProxyCheck | null; createdAt: string; updatedAt: string
  boundInstance: { id: string; name: string } | null
}

export interface ProxyImportLine { line: number; input: string; status: 'created' | 'duplicate' | 'invalid'; id?: string; error?: string }
export interface ProxyImportResult { dryRun: boolean; results: ProxyImportLine[]; created: number; duplicate: number; invalid: number }

/** Short display of a device's / pool proxy. */
export const proxyLabel = (p: { label: string | null; host: string; port: number }) => p.label || `${p.host}:${p.port}`
/** Measured egress location: "IN · Maharashtra · Mumbai" (repeated parts dropped), or '' before a check with geo. */
export const egressGeo = (s: Instance['proxyStatus'] | undefined) =>
  s?.country ? [s.country, s.region, s.city].filter((x, n, a) => x && a.indexOf(x) === n).join(' · ') : ''

/** Device source (设备来源): where external phones come from, e.g. a BitBrowser client. */
export interface SourceHealth { ok: boolean | null; lastOkAt: string | null; failingSince: string | null; lastError: string | null; lastErrorCode: string | null }
/** `config` never contains secrets: secret fields come back only as `<field>Set` (e.g. apiKeySet). */
export interface DeviceSource { id: string; type: 'bitbrowser'; name: string; config: Record<string, unknown>; health: SourceHealth | null; devices: number }
/** A phone offered by a device source (GET /api/device-sources/:id/phones). */
export interface SourcePhone {
  id: string; name: string; detail: string | null; model: string | null; region: string | null; on: boolean | null
  instance: { id: string; name: string } | null
}

export interface Profile { id: string; label: string; engine: string; android: number | null; gapps: boolean; available: boolean; reason: string | null }

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
  | { type: 'notification.created'; userId: string; notification: AppNotification }

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
  /** Crop/compress requested at upload; `result` once processed (kept = re-encode wasn't smaller, original kept). */
  processing: MediaProcessing | null
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
/** 素材分类 (count = visible assets in it); a category only holds assets of its own owner. */
export type MediaCategory = ScopedItem
export interface MediaFormatLimit { id: string; mime: string; mimes: string[]; exts: string[]; processable: boolean }
export type MediaCropAspect = 'original' | '1:1' | '4:5' | '9:16' | '16:9' | '1.91:1'
/** Crop rectangle in 0..1 of the (orientation-corrected) source; `aspect` = fixed preset it is locked to. */
export interface MediaCropRect { x: number; y: number; w: number; h: number; aspect?: MediaCropAspect }
export interface MediaProcessOptions { crop?: MediaCropRect | { aspect: MediaCropAspect; x: number; y: number }; maxSize?: 1080 | 720; quality?: 'high' | 'medium' | 'low' }
export interface MediaFileFacts { size: number; width: number | null; height: number | null; mime: string; duration?: number | null }
export interface MediaProcessing { options: MediaProcessOptions; result?: { before: MediaFileFacts; after: MediaFileFacts; kept?: boolean } }
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
  /** 账号人设 */
  personaId: string | null
  personaName: string | null
  tags: string[]
  instanceId: string | null
  instance: { id: string; name: string; status: string; accessible: boolean } | null
  /** Derived from the device's pool proxy (non-secret fields). */
  proxy: InstanceProxy | null
  /** Measured egress of the linked device (only with a grant on it). */
  egress: { ip: string | null; country: string | null; region: string | null; city: string | null; checkedAt: string } | null
  loginStatus: SocialLoginStatus
  accountStatus: SocialAccountStatus
  notes: string | null
  lastCheckedAt: string | null
  lastError: string | null
  /** Last automatic check on the cloud phone (ok | logged_out | wrong_account | challenge | offline | timeout | app_missing). */
  lastCheckCode: string | null
  lastCheckDetail: string | null
  /** Why 自动检测 can't run (account_check.unsupported_platform | account_check.no_device), null = it can. */
  autoCheckUnsupported: string | null
  exception: boolean
  createdAt: string
  updatedAt: string
}

export interface SocialAccountLog {
  id: string
  at: string
  actorId: string | null
  actorName: string | null
  action: 'create' | 'update' | 'status' | 'checked' | 'link' | 'unlink' | 'connect' | 'disconnect'
  field: string | null
  fromValue: string | null
  toValue: string | null
  message: string | null
}

// ---- tracked accounts (追踪账号)
export type TrackedStatus = 'active' | 'paused' | 'error'
export const TRACKED_STATUS_COLOR: Record<TrackedStatus, string> = { active: 'success', paused: 'default', error: 'error' }
export type TrackedMetric = 'followers' | 'following' | 'posts' | 'views'
/**
 * api / device = official API / collector phone ready; *_unconfigured = source exists but is not ready (no key,
 * no collector device or collection paused); manual_only = no data source (manual entry was removed).
 */
export type TrackedDataMode = 'api' | 'api_unconfigured' | 'device' | 'device_unconfigured' | 'manual_only'
export type TrackedSource = 'api' | 'manual' | 'device'
export interface TrackedPlatform {
  id: string; label: string; metrics: TrackedMetric[]
  api: { kind: 'api' | 'device'; profile: boolean; recentPosts: boolean; metrics: TrackedMetric[]; configured: boolean } | null
}
export interface TrackedAccount {
  id: string; userId: string; ownerName: string | null; platform: string; handle: string; profileUrl: string
  externalId: string | null; displayName: string | null; avatarUrl: string | null; bio: string | null
  tags: string[]; favorite: boolean; status: TrackedStatus; notes: string | null
  lastCheckedAt: string | null; lastError: string | null; lastErrorCode: string | null; lastSource: TrackedSource | null; verified: boolean | null
  createdAt: string; updatedAt: string; dataMode: TrackedDataMode
  latest: { capturedAt: string; source: TrackedSource; approx: string[]; followers: number | null; following: number | null; posts: number | null; views: number | null } | null
  followers: number | null; followersDelta: number | null; followersPrevAt: string | null
  lastRefresh: { id: string; status: TaskStatus; error: string | null; createdAt: string; finishedAt: string | null } | null
  /** 定时采集: hours between scheduled refreshes (null = off), next slot, why the last due slot was skipped. */
  refreshIntervalHours: number | null; nextRefreshAt: string | null; scheduleSkipCode: string | null
}
export interface TrackedSnapshot {
  id: string; capturedAt: string; source: TrackedSource; approx: string[] | null
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
  facebook?: { caption?: string }
}
export interface Content {
  id: string; userId: string; ownerName: string | null; title: string; body: string
  /** 内容分类 */
  categoryId: string | null; category: ContentCategoryRef | null
  stage: 'draft' | 'ready' | 'archived'; status: ContentStatus; platformHints: ContentHints
  tags: string[]; media: ContentMedia[]; publishCounts: Partial<Record<PublishStatus, number>>
  /** Source language (BCP-47) and the languages that have a translation. */
  lang: string | null; translations: string[]
  /** 发布目标: the content's default target accounts, in order. */
  targets: ContentTarget[]
  /** 媒体号 of the publish tasks the viewer may see (latest task per account), next due time of an unfinished task, latest published time. */
  publishAccounts: ContentPublishAccount[]; nextPublishAt: string | null; lastPublishedAt: string | null
  /** 人设每日草稿: set when the content was written as an AI draft (must be reviewed and edited by a person). */
  aiGenerated?: ContentAiInfo | null
  createdAt: string; updatedAt: string
}
export interface ContentAiInfo {
  model: string; requestedModel: string; personaId: string; personaName: string; taskId: string | null; generatedAt: string; mediaTags: string[]
}
/** Tag set on every AI draft (shown as 「AI 草稿」). */
export const AI_DRAFT_TAG = 'ai-draft'
export interface ContentPublishAccount {
  id: string; platform: string; handle: string; displayName: string | null
  status: PublishStatus; postType: PostType; scheduledAt: string; publishedAt: string | null
}
export interface ContentTarget {
  id: string; platform: string; handle: string; displayName: string | null; personaId: string | null
  instance: { id: string; name: string } | null
}
/** 多语言内容: a human-written version of a content in another language (text fields only). */
export interface ContentTranslation {
  lang: string; title: string; body: string; platformHints: Omit<ContentHints, 'youtube'> & { youtube?: { title?: string; description?: string } }
  createdAt: string; updatedAt: string
}
export interface LanguageSettings { languages: string[]; defaultSource: string | null }
export interface PublishTaskItem {
  id: string; userId: string; ownerName: string | null; contentId: string; accountId: string; platform: string
  title: string | null; caption: string; hashtags: string[]; text: string; options: Record<string, unknown>; mediaIds: string[]
  scheduledAt: string; status: PublishStatus; method: 'api' | 'manual' | null; attemptNo: number; maxAttempts: number; taskId: string | null
  republish: boolean; externalId: string | null; url: string | null; error: string | null; errorCode: string | null; publishedAt: string | null
  postType: PostType
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
export const POST_TYPES = ['feed', 'reel', 'story'] as const
export type PostType = (typeof POST_TYPES)[number]
export interface MediaRule { min: number; max: number; kinds: ('image' | 'video')[]; mixed: boolean; maxVideoSec?: number }
export interface PublishCapability {
  media: MediaRule
  postTypes?: Partial<Record<'reel' | 'story', { media: MediaRule; caption: boolean }>>
  title: { required: boolean; max: number } | null
  captionMax: number; hashtagsMax: number; privacy?: string[]
}
export interface PublishPlatform { id: string; name: string; capability: PublishCapability; postTypes: PostType[]; known: boolean }

// ---------------------------------------------------------------- dashboard (概览) + settings (设置)
export interface DashboardCapacity { freeMb: number | null; error: string | null; checkedAt: string; fits: { profile: string; memEstimateMb: number; count: number }[] }
export interface DashboardWidgets {
  devices?: { total: number; running: number; stopped: number; error: number; busy: number; online: number; byStatus: Record<string, number>; capacity: DashboardCapacity | null }
  proxies?: { total: number; bound: number; free: number; freeUsable: number; ok: number; failed: number; unchecked: number }
  social?: {
    total: number; exceptions: number; linked: number; byPlatform: Record<string, number>; byLogin: Record<string, number>
  }
  tracked?: { total: number; byStatus: Record<string, number>; topGainers: { id: string; platform: string; handle: string; displayName: string | null; followers: number; gain: number }[] }
  publishing?: {
    contents: { total: number; byStatus: Record<string, number> }
    upcoming7d: number; published7d: number; failed7d: number; awaitingOperator: number; running: number
    next: { id: string; scheduledAt: string; platform: string; status: string; title: string | null; handle: string | null }[]
    trend: { day: string; published: number; failed: number }[]
  }
  publishToday?: { total: number; byType: Record<PostType, number>; published: Record<PostType, number>; byStatus: Record<string, number> }
  tasks?: {
    last24h: Record<'total' | 'pending' | 'scheduled' | 'running' | 'success' | 'failed' | 'cancelled', number>
    recentFailures: { id: string; type: string; label: string | null; error: string | null; errorCode: string | null; finishedAt: string | null; createdAt: string }[]
  }
  media?: { public: DashboardMediaPart; private: DashboardMediaPart; processing: number; failed: number }
  comments?: { total: number; unread: number; drafts: number; awaitingOperator: number; queued: number; sent7d: number; failed7d: number }
  analytics?: DashboardAnalytics
  trending?: { regions: string[]; region: string; capturedAt: string; top: { rank: number; title: string | null; videoId: string; views: number | null; url: string }[] }
  perUser?: { users: DashboardUserRow[] }
}
export interface DashboardMediaPart { count: number; bytes: number; images: number; videos: number }
export interface DashboardUserRow {
  id: string; username: string; role: Role; disabled: boolean; devices: number; socialAccounts: number; exceptions: number
  trackedAccounts: number; contents: number; published7d: number; failed7d: number; awaitingOperator: number
}
export interface DashboardResponse {
  generatedAt: string
  scope: { userId: string; username: string; admin: boolean }
  /** Widget keys in display order; widgets registered by other modules (e.g. comments) arrive under their own key. */
  order: string[]
  widgets: DashboardWidgets & Record<string, unknown>
  errors: Record<string, string>
}
export interface SettingsConfig {
  publish: { maxAttempts: number; timeoutMs: number; retryBackoffMs: number }
  auditRetentionDays: number
  media: { imageMaxMb: number; videoMaxMb: number; allowedTypes: string[] }
  adbPorts: { min: number; max: number }
}
export interface SystemInfo {
  health: { ok: boolean; checks: Record<string, string>; capabilities: { kvm: boolean } }
  capacity: DashboardCapacity
  versions: { node: string; postgres: string | null; redis: string | null; docker: { version: string; os: string; arch: string; kernel: string | null } | null }
  env: string
  uptimeSec: number
  stf: { reachable: boolean; devices: number; present: number; ready: number }
}
export interface TaskRetentionSettings {
  retention: { days: number | null; updatedAt: string | null }
  defaultDays: number
  maxDays: number
  lastCleanup: { id: string; status: TaskStatus; result: { tasks: number; logs: number; cutoff: string | null } | null; finishedAt: string | null; createdAt: string } | null
}

// ---------------------------------------------------------------- comments & engagement (评论互动)
export type CommentStatus = 'new' | 'read' | 'replied' | 'hidden' | 'ignored'
/** dry_run = test mode on the cloud phone: pasted and checked, not sent. */
export type CommentReplyStatus = 'draft' | 'pending_review' | 'approved' | 'scheduled' | 'sending' | 'awaiting_operator' | 'sent' | 'failed' | 'rejected' | 'cancelled' | 'dry_run'
export const COMMENT_STATUS_COLOR: Record<CommentStatus, string> = { new: 'blue', read: 'default', replied: 'success', hidden: 'default', ignored: 'default' }
export const COMMENT_REPLY_STATUS_COLOR: Record<CommentReplyStatus, string> = {
  draft: 'default', pending_review: 'gold', approved: 'processing', scheduled: 'purple', sending: 'processing', awaiting_operator: 'orange',
  sent: 'success', failed: 'error', rejected: 'error', cancelled: 'default', dry_run: 'cyan',
}
/** comments.rules; sendsPerDay / minGapSec / testMode = 云手机发评论 (device sends). */
export interface CommentRules { duplicateMax: number; duplicateWindowHours: number; sendsPerHour: number; sendsPerDay: number; minGapSec: number; testMode: boolean }
export interface CommentAccount {
  id: string; platform: string; handle: string; displayName: string | null; userId: string; instanceId: string | null
  newCount: number
}
export interface CommentReplySummary {
  id: string; status: CommentReplyStatus; text: string; method: string | null; errorCode: string | null; error: string | null; authorName: string | null; sentAt: string | null; updatedAt: string
}
export interface CommentItem {
  id: string; userId: string; accountId: string; platform: string; source: 'api' | 'manual' | 'device'; externalId: string; parentExternalId: string | null
  externalPostId: string | null; postUrl: string | null; publishTaskId: string | null; authorName: string | null; authorHandle: string | null; text: string
  likeCount: number | null; replyCount: number | null; publishedAt: string | null; fetchedAt: string; status: CommentStatus; createdAt: string
  /** personaId = 账号人设 (default persona filter of the reply templates). */
  account: { id: string; handle: string; platform: string; personaId: string | null } | null
  publishTask: { id: string; url: string | null; title: string | null } | null
  reply: CommentReplySummary | null
  children?: CommentItem[]
}
export interface CommentReplyItem {
  /** commentId null = a comment written directly under the account's post (`post`). */
  id: string; userId: string; accountId: string; commentId: string | null; postId: string | null; platform: string; text: string; templateId: string | null; status: CommentReplyStatus
  method: 'api' | 'manual' | 'device' | null; scheduledAt: string | null; round: number; maxAttempts: number; taskId: string | null; externalReplyId: string | null
  error: string | null; errorCode: string | null; authorId: string | null; authorName: string | null; submittedAt: string | null
  reviewerId: string | null; reviewerName: string | null; reviewedAt: string | null; reviewNote: string | null
  senderId: string | null; senderName: string | null; handedAt: string | null; sentAt: string | null; createdAt: string; updatedAt: string
  ownerName: string | null
  comment: { id: string; text: string; authorName: string | null; authorHandle: string | null; source: 'api' | 'manual' | 'device'; status: CommentStatus; externalPostId: string | null; postUrl: string | null; publishedAt: string | null } | null
  post: { id: string; caption: string | null; permalink: string | null; publishedAt: string | null } | null
  /** Test run / device send: what the input field showed (the screenshot: GET /api/comment-replies/:id/evidence). */
  evidence: { at: string; inputText: string | null; excerpt: string | null } | null
  hasEvidence: boolean
  account: { id: string; handle: string; platform: string } | null
  instance: { id: string; name: string; status: string; adbState: string | null; online: boolean; accessible: boolean } | null
  canEdit: boolean
}
// ---------------------------------------------------------------- 帖子与评论 (account feed)
export interface FeedReply {
  id: string; status: CommentReplyStatus; text: string; method: string | null; scheduledAt: string | null; sentAt: string | null; handedAt: string | null
  errorCode: string | null; error: string | null; authorName: string | null; hasEvidence: boolean; updatedAt: string
}
export interface FeedComment {
  id: string; source?: 'api' | 'manual' | 'device'; authorName?: string | null; authorHandle: string | null; text: string; likeCount: number | null; replyCount: number | null
  publishedAt: string | null; status?: CommentStatus; reply?: FeedReply | null; children?: FeedComment[]
}
export interface FeedPost {
  id: string; externalId: string; source: string; permalink: string | null; caption: string | null; mediaType: string | null; publishedAt: string | null
  likes: number | null; comments: number | null; views?: number | null; approx: string[]; firstSeenAt: string; fetchedAt: string; commentsFetchedAt: string | null
  commentRows: FeedComment[]; commentsTotal: number; postComments?: (FeedReply | null)[]
}
export type FeedActivity =
  | { type: 'stats'; at: string; followers: number | null; following: number | null; posts: number | null; approx: string[]; source: string; delta: { followers: number | null; following: number | null; posts: number | null } }
  | { type: 'post'; at: string; postId: string; caption: string | null; publishedAt: string | null; permalink: string | null }
  | { type: 'collect'; at: string; status: string; errorCode: string | null; outcome: string | null; posts: number | null; newPosts: number | null; comments: number | null; newComments: number | null }
  | { type: 'reply'; at: string; status: CommentReplyStatus; text: string; errorCode: string | null; replyId: string }
export interface FeedCollectState {
  unsupported: string | null; instanceId: string | null; halted: boolean; kind: 'social' | 'tracked'
  settings: { hours: number | null; posts: number; commentsPerPost: number }
  last: { taskId: string; status: string; at: string; errorCode: string | null; result: Record<string, unknown> | null } | null
  pending: { taskId: string; status: string; runAt: string | null } | null
}
export interface FeedResponse {
  account: { id: string; platform: string; handle: string; instanceId?: string | null; userId: string }
  collect: FeedCollectState
  send?: { testMode: boolean; deviceCapable: boolean }
  activity: FeedActivity[]
  posts: { items: FeedPost[]; total: number }
}

export interface CommentLog {
  id: string; at: string; level: 'debug' | 'info' | 'warn' | 'error'; action: string; code: string | null; message: string | null
  data: Record<string, unknown> | null; taskId: string | null; actorName: string | null; commentTaskId: string | null
}
export type TemplateKind = 'comment' | 'post'
/** 人设 as embedded in a template. Public ones are usable by every template, personal ones only by their owner's. */
export interface PersonaRef { id: string; name: string; description: string | null; ownerType: 'public' | 'user'; ownerId: string | null }
/** A row of a scoped name list (人设, 内容分类, 素材分类): public (admin-managed) or personal; `count` = uses the viewer can see. */
export interface ScopedItem extends PersonaRef {
  sort: number; createdAt: string; updatedAt: string
  count: number; writable: boolean; ownerName: string | null
  /** 人设 only: social accounts with this 账号人设 that the viewer can see. */
  accounts?: number
  /** 人设 only: 人设每日草稿 (AI) on and drafts per day. */
  draftEnabled?: boolean; draftsPerDay?: number
  /** 人设 only: newest generation task, on rows the viewer manages (else null). */
  lastDraftRun?: PersonaDraftRun | null
}
/** A 人设每日草稿 generation task (trigger schedule|manual; `created` = drafts written, null until it succeeded). */
export interface PersonaDraftRun { id: string; status: TaskStatus; errorCode: string | null; createdAt: string; finishedAt: string | null; trigger: string | null; created: number | null }
/** 人设内容设定 (GET/PUT /api/personas/:id/drafts). */
export interface PersonaBrief {
  tone?: string; topics?: string[]; audience?: string; lang?: string | null; hashtags?: string[]; bannedWords?: string[]
  exampleTemplateIds?: string[]; notes?: string
}
export interface PersonaDraftSettings {
  id: string; name: string; ownerType: 'public' | 'user'; ownerId: string | null
  draftEnabled: boolean; draftsPerDay: number; brief: PersonaBrief
  draftOwnerId: string | null; draftOwnerName: string | null; draftOwnerDisabled: boolean | null
  runs: PersonaDraftRun[]
}
export interface AiSettingsState { enabled: boolean; keySet: boolean; model: string; hour: number; updatedAt: string | null }
/** 人设 (count = templates using it). */
export type Persona = ScopedItem
/** 内容分类 (count = contents using it). */
export type ContentCategory = ScopedItem
export interface ContentCategoryRef { id: string; name: string; ownerType: 'public' | 'user'; ownerId: string | null }
export interface CommentTemplate {
  id: string; userId: string | null; name: string; text: string; shared: boolean; ownerName: string | null; writable: boolean; updatedAt: string
  /** 话术库: reply (comment) or post/caption template, optional persona (人设) and lowercase tags. */
  kind: TemplateKind; personaId: string | null; persona: PersonaRef | null; tags: string[]
}

/** Intervals offered for 定时采集 (hours; the API accepts exactly these). */
export const TRACKED_SCHEDULE_HOURS = [1, 2, 3, 6, 12, 24, 48, 72, 168] as const
/** GET /api/tracked-accounts/capacity: scheduled collector-device load of all users (aggregates only). */
export interface TrackedCapacity {
  pace: { minIntervalSec: number; maxPerHour: number; capacityPerHour: number }
  platforms: { platform: string; scheduledAccounts: number; visitsPerHour: number; capacityPerHour: number; overloaded: boolean }[]
}

/** 趋势热点 */
export interface TrendingSettings { regions: string[]; categoryId: string | null; intervalHours: number; maxResults: number; retentionDays: number; updatedAt: string | null }
export interface TrendingItem {
  id: string; rank: number; videoId: string; title: string | null; channelId: string | null; channelTitle: string | null; categoryId: string | null
  views: number | null; likes: number | null; comments: number | null; publishedAt: string | null; tags: string[]
  url: string; channelUrl: string | null; prevRank: number | null; rankChange: number | null; isNew: boolean
}
export interface TrendingSnapshotRef { id: string; region: string; categoryId: string | null; slotAt: string; capturedAt: string; itemCount: number }
export interface TrendingData {
  configured: boolean; notice: string | null; settings: TrendingSettings; nextSlotAt: string | null
  regions: { id: string; region: string; categoryId: string | null; capturedAt: string; itemCount: number }[]
  snapshot: TrendingSnapshotRef | null
  previous: { id: string; capturedAt: string; slotAt: string } | null
  history: { id: string; slotAt: string; capturedAt: string; itemCount: number }[]
  lastTasks: { label: string | null; status: TaskStatus; errorCode: string | null; error: string | null; createdAt: string; finishedAt: string | null }[]
  items: TrendingItem[]
}


// ---------------------------------------------------------------- account analytics (账号分析)
export interface AnalyticsSums { followersGained: number | null; views: number | null; likes: number | null; shares: number | null; comments: number | null }
export interface AnalyticsAccount {
  id: string; userId: string; ownerName: string | null; platform: string; handle: string; displayName: string | null
  latest: { day: string; followers: number | null; following: number | null; posts: number | null; capturedAt: string; source: 'api' | 'manual' | 'device'; approx: string[] } | null
  /** Metrics the official API could not provide when the row was collected (history). */
  missing: string[]
}
export interface AnalyticsSummary {
  from: string; to: string
  days: ({ day: string } & AnalyticsSums)[]
  totals: AnalyticsSums & { accounts: number; withData: number; followers: number }
  accounts: (AnalyticsAccount & { range: AnalyticsSums })[]
}
export interface AnalyticsDay extends Partial<AnalyticsSums> {
  day: string; source: 'api' | 'manual' | 'device' | null; approx?: string[]
  followers?: number | null; following?: number | null; posts?: number | null; totalViews?: number | null; totalLikes?: number | null
}
export interface AnalyticsSeries { account: AnalyticsAccount; from: string; to: string; days: AnalyticsDay[] }
/** One of the account's own posts (GET /api/analytics/accounts/:id/posts; collected before the official APIs were removed). */
export interface AnalyticsPost {
  id: string; externalId: string; mediaType: string | null; productType: string | null; caption: string | null; permalink: string | null
  publishedAt: string | null; likes: number | null; comments: number | null; firstSeenAt: string; fetchedAt: string
  /** The publish task that published it (same account + platform post id). */
  publish: { taskId: string; contentId: string; title: string | null } | null
}
export interface AnalyticsPosts {
  total: number; likes: number | null; comments: number | null; lastFetchedAt: string | null; posts: AnalyticsPost[]
}
export interface DashboardAnalytics {
  accounts: number; withData: number; followers: number
  followersGained7d: number | null; views7d: number | null; shares7d: number | null; likes7d: number | null; comments7d: number | null
  trend: ({ day: string } & AnalyticsSums)[]
  top: { id: string; platform: string; handle: string; displayName: string | null; followers: number | null; gain: number | null }[]
}
/** Local-midnight timestamp of a YYYY-MM-DD day (chart x values; the day itself is UTC on the server). */
export const dayTs = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y!, m! - 1, dd!).getTime() }

/** In-app alert (告警通知, GET /api/notifications); rendered by api/alerts.ts. */
export interface AppNotification {
  id: string; userId: string; kind: string; severity: 'info' | 'warning' | 'error'; recovered: boolean
  params: Record<string, string | number>; refType: string | null; refId: string | null; readAt: string | null; createdAt: string
}

// ---------------------------------------------------------------- 风控 (risk control, admin)
export interface RiskDeviceSettings {
  minIntervalSec: number; maxPerHour: number; busyRetrySec: number; accountCheckHours: number | null
  /** 帖子与评论采集: every N hours (null = off), newest posts per account, comments per post. */
  feedCollectHours: number | null; feedPosts: number; feedCommentsPerPost: number
}
export interface RiskSettings { device: RiskDeviceSettings; defaults: RiskDeviceSettings; capacityPerHour: number; eventRetentionDays: number }
export interface RiskDevice {
  id: string; name: string; status: string; adbState: string | null; external: boolean; online: boolean
  /** Platforms this phone collects tracked accounts for. */
  collectorFor: string[]
  /** Social accounts on this phone that the automatic check covers. */
  checkedAccounts: number
  halted: { at: string; code: string; source: 'collector' | 'account_check' | 'feed' | 'reply'; platform: string; account: { platform: string; handle: string; kind: 'social' | 'tracked' } | null } | null
  visitsLastHour: number; lastVisitAt: string | null
}
export interface RiskEvent {
  id: string; at: string; instanceId: string | null; instanceName: string | null; source: 'collector' | 'account_check' | 'feed' | 'reply'; code: string; detail: string | null
  socialAccountId: string | null; trackedAccountId: string | null; userId: string | null
  socialHandle: string | null; trackedHandle: string | null; username: string | null
}
