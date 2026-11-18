import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, getToken, wsUrl } from '../api/client'
import type { Instance, PlatformEvent, Task } from '../api/types'

/** Instance + task state, kept live by the /api/events WebSocket. */
export const useInstancesStore = defineStore('instances', () => {
  const byId = ref(new Map<string, Instance>())
  const tasks = ref<Task[]>([])
  const loading = ref(false)
  const connected = ref(false)
  let ws: WebSocket | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let stopped = true
  /** Task-centre views subscribe to task events (task.updated / task.log) instead of keeping their own socket. */
  const taskListeners = new Set<(ev: Extract<PlatformEvent, { type: 'task.updated' | 'task.log' }>) => void>()
  function onTaskEvent(fn: (ev: Extract<PlatformEvent, { type: 'task.updated' | 'task.log' }>) => void) {
    taskListeners.add(fn)
    return () => { taskListeners.delete(fn) }
  }

  const list = computed(() => [...byId.value.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })))

  async function refresh() {
    loading.value = true
    try {
      const [i, t] = await Promise.all([
        api<{ instances: Instance[] }>('GET', '/api/instances'),
        api<{ tasks: Task[] }>('GET', '/api/tasks?limit=100'),
      ])
      byId.value = new Map(i.instances.map((x) => [x.id, x]))
      tasks.value = t.tasks
    } finally {
      loading.value = false
    }
  }

  function apply(ev: PlatformEvent) {
    if (ev.type === 'instance.updated') {
      // Events don't carry admin-only `owners`; keep what the last list load returned.
      const prev = byId.value.get(ev.instance.id)
      byId.value.set(ev.instance.id, prev?.owners && !ev.instance.owners ? { ...ev.instance, owners: prev.owners } : ev.instance)
    } else if (ev.type === 'instance.deleted') {
      byId.value.delete(ev.instanceId)
    } else if (ev.type === 'task.updated') {
      const idx = tasks.value.findIndex((t) => t.id === ev.task.id)
      // Events carry the raw row; keep the createdByName resolved by GET /api/tasks.
      if (idx >= 0) tasks.value[idx] = { ...ev.task, createdByName: ev.task.createdByName ?? tasks.value[idx]!.createdByName }
      else tasks.value = [ev.task, ...tasks.value].slice(0, 100)
    }
    if (ev.type === 'task.updated' || ev.type === 'task.log') taskListeners.forEach((fn) => fn(ev))
    if (ev.type === 'notification.created') notificationListeners.forEach((fn) => fn(ev))
  }
  /** Alerts (notification bell) subscribe to their events on the shared socket. */
  const notificationListeners = new Set<(ev: Extract<PlatformEvent, { type: 'notification.created' }>) => void>()
  function onNotification(fn: (ev: Extract<PlatformEvent, { type: 'notification.created' }>) => void) {
    notificationListeners.add(fn)
    return () => { notificationListeners.delete(fn) }
  }

  function connect() {
    stopped = false
    if (ws) return
    const token = getToken()
    if (!token) return
    ws = new WebSocket(wsUrl('/api/events'))
    ws.onopen = () => ws?.send(JSON.stringify({ type: 'auth', token }))
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data)
      if (ev.type === 'ready') {
        connected.value = true
        void refresh() // resync anything missed while disconnected
        return
      }
      apply(ev as PlatformEvent)
    }
    ws.onclose = () => {
      ws = null
      connected.value = false
      if (!stopped) retry = setTimeout(connect, 2000)
    }
  }

  function disconnect() {
    stopped = true
    if (retry) clearTimeout(retry)
    ws?.close()
    ws = null
    byId.value = new Map()
    tasks.value = []
  }

  async function create(body: { proxyMode: 'auto' | 'none' | 'pick'; proxyIds?: string[]; profile: string; count: number; namePrefix: string; width: number; height: number; dpi: number; memoryMb?: number; locale?: string; timezone?: string; deviceName?: string; appIds?: string[] }) {
    const r = await api<{ instances: Instance[]; taskIds: string[] }>('POST', '/api/instances', body)
    r.instances.forEach((i) => byId.value.set(i.id, i))
    return r
  }

  async function action(action: 'start' | 'stop' | 'restart' | 'delete', ids: string[]) {
    return api<{ accepted: { instanceId: string; taskId: string }[]; skipped: { instanceId: string; reason: string; code?: string }[] }>(
      'POST', '/api/instances/actions', { action, ids })
  }

  type BatchResult = { accepted: { instanceId: string; taskId: string }[]; skipped: { instanceId: string; reason: string }[] }

  /** APK or split bundle (.apks/.xapk/.apkm/.zip) to one or more instances; -r = update. */
  async function installApp(ids: string[], file: File) {
    const fd = new FormData()
    fd.append('instanceIds', JSON.stringify(ids)) // must precede the file part
    fd.append('file', file, file.name)
    return api<BatchResult & { apks: number }>('POST', '/api/apps/install', fd)
  }

  async function uninstallApp(ids: string[], pkg: string) {
    return api<BatchResult>('POST', '/api/apps/uninstall', { instanceIds: ids, package: pkg })
  }

  /** Android logcat (read-only); keyword filtering happens server-side. */
  async function logcat(id: string, q: { lines: number; level: 'E' | 'W' | 'I' | 'D'; q?: string }) {
    const p = new URLSearchParams({ lines: String(q.lines), level: q.level, ...(q.q ? { q: q.q } : {}) })
    return (await api<{ lines: string[] }>('GET', `/api/instances/${id}/logcat?${p}`)).lines
  }

  async function updateSettings(id: string, body: { locale?: string; timezone?: string; deviceName?: string }) {
    return api<{ taskId: string | null }>('PATCH', `/api/instances/${id}/settings`, body)
  }

  async function googleCheck(id: string) {
    const r = await api<{ google: Instance['google'] }>('POST', `/api/instances/${id}/google/check`)
    const inst = byId.value.get(id)
    if (inst) byId.value.set(id, { ...inst, google: r.google })
    return r.google
  }

  return { onTaskEvent, onNotification, googleCheck, byId, list, tasks, loading, connected, refresh, connect, disconnect, create, action, installApp, uninstallApp, updateSettings, logcat }
})
