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
}

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
  createdAt: string
  finishedAt: string | null
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
