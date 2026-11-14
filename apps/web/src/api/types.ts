export type Role = 'admin' | 'operator' | 'viewer'
export type InstanceStatus = 'creating' | 'starting' | 'running' | 'stopping' | 'stopped' | 'restarting' | 'deleting' | 'error'

export interface User { id: string; username: string; role: Role }
export interface ManagedUser extends User { disabled: boolean; createdAt: string; instanceIds: string[] }

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
  spec: { width: number; height: number; dpi: number; memoryMb?: number }
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
