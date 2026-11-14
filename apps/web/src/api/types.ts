export type Role = 'admin' | 'user'
export const ROLE_TEXT: Record<Role, string> = { admin: '管理员', user: '用户' }
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
  proxy: { type: 'socks5' | 'http'; host: string; port: number; username?: string; hasPassword: boolean } | null
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

export interface ProxyInput { type: 'socks5' | 'http'; host: string; port: number; username?: string; password?: string }

export interface Profile { id: string; label: string; engine: string; gapps: boolean; available: boolean; reason: string | null }

export interface Task {
  id: string
  type: string
  instanceId: string | null
  instanceName: string | null
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  error: string | null
  createdBy?: string | null
  /** Username of createdBy (GET /api/tasks only; null = system task). */
  createdByName?: string | null
  createdAt: string
  finishedAt: string | null
}

export const TASK_TEXT: Record<string, string> = { create: '创建', start: '启动', stop: '停止', restart: '重启', delete: '删除', 'install-apk': '安装/更新应用', 'uninstall-app': '卸载应用', 'apply-settings': '应用设备参数', 'set-proxy': '设置代理', 'import-app': '导入应用库', 'push-asset': '推送素材' }
export const TASK_STATUS: Record<Task['status'], { color: string; text: string }> = {
  queued: { color: 'default', text: '排队' }, running: { color: 'processing', text: '执行中' },
  succeeded: { color: 'success', text: '成功' }, failed: { color: 'error', text: '失败' },
}

export type PlatformEvent =
  | { type: 'instance.updated'; instance: Instance }
  | { type: 'instance.deleted'; instanceId: string }
  | { type: 'task.updated'; task: Task }

export const BUSY_STATUSES: InstanceStatus[] = ['creating', 'starting', 'stopping', 'restarting', 'deleting']

export interface Asset {
  id: string; name: string; mime: string; size: number; sha256: string
  storage: 'local' | 's3'; key: string; tags: string[]; createdBy: string | null; createdAt: string
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
/** Chinese labels for known audit actions (unknown ones are shown raw). */
export const AUDIT_ACTION_TEXT: Record<string, string> = {
  'auth.login': '登录',
  'auth.login_failed': '登录失败',
  'auth.password_change': '修改密码',
  'profile.update': '修改个人信息',
  'user.create': '创建用户',
  'user.update': '修改用户',
  'user.delete': '删除用户',
  'grants.update': '修改设备授权',
  'device.create': '创建设备',
  'device.action.start': '启动设备',
  'device.action.stop': '停止设备',
  'device.action.restart': '重启设备',
  'device.action.delete': '删除设备',
  'device.settings': '修改设备参数',
  'proxy.set': '设置代理',
  'app.install': '安装/更新应用',
  'app.uninstall': '卸载应用',
  'file.upload': '上传文件到设备',
  'library.import': '导入应用库',
  'library.update': '修改应用库预装',
  'library.install': '从应用库安装',
  'library.delete': '删除应用库条目',
  'asset.upload': '上传素材',
  'asset.update': '修改素材',
  'asset.delete': '删除素材',
  'asset.push': '推送素材',
  'storage.update': '修改存储设置',
}
