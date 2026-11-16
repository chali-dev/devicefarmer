<script setup lang="ts">
import { dateLocale } from '../i18n'
import { message } from 'ant-design-vue'
import { ReloadOutlined } from '@ant-design/icons-vue'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { logText } from '../api/logText'
import { useRoute } from 'vue-router'
import { api, codeText, errorText } from '../api/client'
import {
  TASK_STATUSES, TASK_STATUS_COLOR, taskStatusText, taskText,
  type ManagedUser, type Task, type TaskDetail, type TaskLog, type TaskStats, type TaskStatus,
} from '../api/types'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

/** Task centre (任务中心): every background job, live via the events WebSocket. */
const { t } = useI18n()
const auth = useAuthStore()
const store = useInstancesStore()
const route = useRoute()

const items = ref<Task[]>([])
const total = ref(0)
const loading = ref(false)
const stats = ref<TaskStats | null>(null)
const users = ref<ManagedUser[]>([])
const page = ref(1)
const pageSize = ref(20)
const tab = ref<'all' | TaskStatus>('all')
const filters = reactive({
  type: undefined as string | undefined,
  instanceId: undefined as string | undefined,
  userId: undefined as string | undefined,
  range: null as [string, string] | null,
  q: '',
  refType: undefined as string | undefined,
  refId: undefined as string | undefined,
})

function query(withStatus: boolean, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams()
  if (withStatus && tab.value !== 'all') p.set('status', tab.value)
  if (filters.type) p.set('type', filters.type)
  if (filters.instanceId) p.set('instanceId', filters.instanceId)
  if (filters.userId) p.set('userId', filters.userId)
  if (filters.refType) p.set('refType', filters.refType)
  if (filters.refId) p.set('refId', filters.refId)
  if (filters.range) { p.set('from', filters.range[0]); p.set('to', filters.range[1]) }
  if (filters.q.trim()) p.set('q', filters.q.trim())
  for (const [k, v] of Object.entries(extra)) p.set(k, v)
  return p.toString()
}

async function load() {
  loading.value = true
  try {
    const [l, s] = await Promise.all([
      api<{ tasks: Task[]; total: number }>('GET', `/api/tasks?${query(true, { limit: String(pageSize.value), offset: String((page.value - 1) * pageSize.value) })}`),
      api<TaskStats>('GET', `/api/tasks/stats?${query(false)}`),
    ])
    items.value = l.tasks
    total.value = l.total
    stats.value = s
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}

function search() { page.value = 1; void load() }
function reset() {
  Object.assign(filters, { type: undefined, instanceId: undefined, userId: undefined, range: null, q: '', refType: undefined, refId: undefined })
  tab.value = 'all'
  search()
}
watch(tab, () => search())

const typeOptions = computed(() => {
  const set = new Set([...(stats.value?.types ?? []), ...Object.keys(stats.value?.byType ?? {})])
  return [...set].map((v) => ({ value: v, label: taskText(v) })).sort((a, b) => a.label.localeCompare(b.label))
})
const deviceOptions = computed(() => store.list.map((i) => ({ value: i.id, label: i.name })))
const userOptions = computed(() => users.value.map((u) => ({ value: u.id, label: u.displayName ? `${u.displayName} (${u.username})` : u.username })))
const allCount = computed(() => Object.values(stats.value?.byStatus ?? {}).reduce((a, b) => a + b, 0))

const pagination = computed(() => ({
  current: page.value, pageSize: pageSize.value, total: total.value,
  showSizeChanger: true, pageSizeOptions: ['20', '50', '100', '200'],
  showTotal: (n: number) => t('taskCenter.total', { n }),
}))
function onTableChange(p: { current?: number; pageSize?: number }) {
  if (p.pageSize && p.pageSize !== pageSize.value) { pageSize.value = p.pageSize; page.value = 1 }
  else if (p.current) page.value = p.current
  void load()
}

// ---- display helpers
const fmtTime = (s: string | null) => (s ? new Date(s).toLocaleString(dateLocale()) : '—')
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const s = Math.round(ms / 100) / 10
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} m ${Math.round(s % 60)} s` : `${Math.floor(m / 60)} h ${m % 60} m`
}
const now = ref(Date.now())
const ticker = setInterval(() => { now.value = Date.now() }, 1000)
function duration(task: Task): string {
  if (!task.startedAt) return '—'
  const end = task.finishedAt ? Date.parse(task.finishedAt) : task.status === 'running' ? now.value : null
  return end ? fmtDuration(Math.max(0, end - Date.parse(task.startedAt))) : '—'
}
const errText = (task: Pick<Task, 'error' | 'errorCode'>) => codeText(task.errorCode, undefined, task.error ?? '') || task.error || ''
function owner(task: Task) {
  if (task.createdByName) return task.createdByName
  return task.createdBy ? '—' : t('common.system')
}
function targetLink(task: Task): string | null {
  if (task.instanceId && store.byId.has(task.instanceId)) return `/instances/${task.instanceId}`
  if (task.refType === 'media') return '/media'
  if (task.refType === 'social-account') return '/social'
  return null
}

const columns = computed(() => [
  { title: t('taskCenter.type'), key: 'type', width: 150 },
  { title: t('taskCenter.target'), key: 'target', ellipsis: true, width: 240 },
  { title: t('common.status'), key: 'status', width: 150 },
  { title: t('taskCenter.attempts'), key: 'attempts', width: 90 },
  { title: t('taskCenter.createdAt'), key: 'createdAt', width: 170 },
  { title: t('taskCenter.runAt'), key: 'runAt', width: 170 },
  { title: t('taskCenter.duration'), key: 'duration', width: 100 },
  ...(auth.isAdmin ? [{ title: t('taskCenter.owner'), key: 'owner', width: 110 }] : []),
  { title: t('common.action'), key: 'actions', width: 170, fixed: 'right' as const },
])

// ---- actions
const busy = ref<string | null>(null)
async function cancel(task: Task) {
  busy.value = task.id
  try {
    const r = await api<{ task: TaskDetail }>('POST', `/api/tasks/${task.id}/cancel`)
    message.success(r.task.status === 'cancelled' ? t('taskCenter.cancelDone') : t('taskCenter.cancelRequested'))
    void load()
    if (detail.value?.id === task.id) void openDetail(task.id)
  } catch (e) { message.error(errorText(e)) }
  finally { busy.value = null }
}
async function retry(task: Task) {
  busy.value = task.id
  try {
    const r = await api<{ task: TaskDetail }>('POST', `/api/tasks/${task.id}/retry`)
    message.success(t('taskCenter.retried'))
    void load()
    void openDetail(r.task.id)
  } catch (e) { message.error(errorText(e)) }
  finally { busy.value = null }
}
const canCancel = (task: Task) => !['success', 'failed', 'cancelled'].includes(task.status) && !(task.status === 'running' && task.cancelRequested)
const canRetry = (task: Task) => task.status === 'failed' || task.status === 'cancelled'

// ---- detail drawer
const drawerOpen = ref(false)
const detail = ref<TaskDetail | null>(null)
const logs = ref<TaskLog[]>([])
const detailLoading = ref(false)
async function openDetail(id: string) {
  drawerOpen.value = true
  detailLoading.value = true
  try {
    const r = await api<{ task: TaskDetail; logs: TaskLog[] }>('GET', `/api/tasks/${id}`)
    detail.value = r.task
    logs.value = r.logs
  } catch (e) { message.error(errorText(e)); drawerOpen.value = false }
  finally { detailLoading.value = false }
}
const LOG_COLOR: Record<TaskLog['level'], string> = { debug: 'gray', info: 'blue', warn: 'orange', error: 'red' }
const json = (v: unknown) => JSON.stringify(v, null, 2)

// ---- live updates
let reloadTimer: ReturnType<typeof setTimeout> | null = null
function scheduleReload() {
  if (reloadTimer) return
  reloadTimer = setTimeout(() => { reloadTimer = null; void load() }, 1000)
}
const off = store.onTaskEvent((ev) => {
  if (ev.type === 'task.log') {
    if (detail.value?.id === ev.taskId && !logs.value.some((l) => l.id === ev.log.id)) logs.value = [...logs.value, ev.log]
    return
  }
  const idx = items.value.findIndex((x) => x.id === ev.task.id)
  if (idx >= 0) items.value[idx] = { ...ev.task, createdByName: ev.task.createdByName ?? items.value[idx]!.createdByName }
  if (detail.value?.id === ev.task.id) detail.value = { ...detail.value, ...ev.task, createdByName: detail.value.createdByName }
  // Counts and new rows: refetch, debounced.
  scheduleReload()
})

onMounted(() => {
  const q = route.query
  if (typeof q.instanceId === 'string') filters.instanceId = q.instanceId
  if (typeof q.type === 'string') filters.type = q.type
  if (typeof q.refType === 'string') filters.refType = q.refType
  if (typeof q.refId === 'string') filters.refId = q.refId
  if (typeof q.status === 'string' && (TASK_STATUSES as string[]).includes(q.status)) tab.value = q.status as TaskStatus
  void load()
  if (auth.isAdmin) void api<{ users: ManagedUser[] }>('GET', '/api/users').then((r) => { users.value = r.users }).catch(() => undefined)
  if (typeof q.task === 'string') void openDetail(q.task)
})
onBeforeUnmount(() => { off(); clearInterval(ticker); if (reloadTimer) clearTimeout(reloadTimer) })
</script>

<template>
  <a-card :title="t('taskCenter.title')" size="small">
    <template #extra>
      <a-button :loading="loading" @click="load"><ReloadOutlined /> {{ t('common.refresh') }}</a-button>
    </template>

    <a-tabs v-model:active-key="tab" size="small">
      <a-tab-pane key="all" :tab="`${t('taskCenter.all')} (${allCount})`" />
      <a-tab-pane v-for="s in TASK_STATUSES" :key="s" :tab="`${taskStatusText(s)} (${stats?.byStatus[s] ?? 0})`" />
    </a-tabs>

    <a-form layout="inline" class="filters" @submit.prevent="search">
      <a-form-item :label="t('taskCenter.type')">
        <a-select v-model:value="filters.type" :options="typeOptions" :placeholder="t('common.all')" allow-clear show-search option-filter-prop="label" style="width: 170px" @change="search" />
      </a-form-item>
      <a-form-item :label="t('common.device')">
        <a-select v-model:value="filters.instanceId" :options="deviceOptions" :placeholder="t('common.all')" allow-clear show-search option-filter-prop="label" style="width: 150px" @change="search" />
      </a-form-item>
      <a-form-item v-if="auth.isAdmin" :label="t('taskCenter.owner')">
        <a-select v-model:value="filters.userId" :options="userOptions" :placeholder="t('taskCenter.ownerPlaceholder')" allow-clear show-search option-filter-prop="label" style="width: 150px" @change="search" />
      </a-form-item>
      <a-form-item :label="t('taskCenter.createdAt')">
        <a-range-picker v-model:value="filters.range" show-time value-format="YYYY-MM-DDTHH:mm:ssZ" :placeholder="[t('taskCenter.start'), t('taskCenter.end')]" @change="search" />
      </a-form-item>
      <a-form-item :label="t('taskCenter.keyword')">
        <a-input v-model:value="filters.q" :placeholder="t('taskCenter.keywordPlaceholder')" allow-clear style="width: 190px" @press-enter="search" />
      </a-form-item>
      <a-form-item>
        <a-space>
          <a-button type="primary" html-type="submit">{{ t('common.search') }}</a-button>
          <a-button @click="reset">{{ t('common.reset') }}</a-button>
        </a-space>
      </a-form-item>
    </a-form>

    <a-table
      :data-source="items" :columns="columns" row-key="id" :loading="loading" size="middle"
      :pagination="pagination" :scroll="{ x: 1150 }" :locale="{ emptyText: t('taskCenter.empty') }" @change="onTableChange"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'type'">
          <a @click="openDetail(record.id)">{{ taskText(record.type) }}</a>
        </template>
        <template v-else-if="column.key === 'target'">
          <router-link v-if="targetLink(record as Task)" :to="targetLink(record as Task)!">{{ record.instanceName ?? record.refId }}</router-link>
          <span v-else>{{ record.instanceName ?? '—' }}</span>
        </template>
        <template v-else-if="column.key === 'status'">
          <a-tooltip :title="record.error ? errText(record as Task) : undefined">
            <a-tag :color="TASK_STATUS_COLOR[record.status as TaskStatus]">{{ taskStatusText(record.status) }}</a-tag>
          </a-tooltip>
          <a-tag v-if="record.cancelRequested && record.status === 'running'" color="warning">{{ t('taskCenter.cancelRequested') }}</a-tag>
        </template>
        <template v-else-if="column.key === 'attempts'">{{ record.attempts }}/{{ record.maxAttempts }}</template>
        <template v-else-if="column.key === 'createdAt'">{{ fmtTime(record.createdAt) }}</template>
        <template v-else-if="column.key === 'runAt'">{{ fmtTime(record.runAt) }}</template>
        <template v-else-if="column.key === 'duration'">{{ duration(record as Task) }}</template>
        <template v-else-if="column.key === 'owner'">{{ owner(record as Task) }}</template>
        <template v-else-if="column.key === 'actions'">
          <a-space :size="4">
            <a-button type="link" size="small" @click="openDetail(record.id)">{{ t('taskCenter.detail') }}</a-button>
            <a-popconfirm v-if="canCancel(record as Task)" :title="t('taskCenter.cancelConfirm')" :ok-text="t('common.ok')" :cancel-text="t('common.cancel')" @confirm="cancel(record as Task)">
              <a-button type="link" size="small" danger :loading="busy === record.id">{{ t('common.cancel') }}</a-button>
            </a-popconfirm>
            <a-popconfirm v-if="canRetry(record as Task)" :title="t('taskCenter.retryConfirm')" :ok-text="t('common.ok')" :cancel-text="t('common.cancel')" @confirm="retry(record as Task)">
              <a-button type="link" size="small" :loading="busy === record.id">{{ t('taskCenter.retry') }}</a-button>
            </a-popconfirm>
          </a-space>
        </template>
      </template>
    </a-table>
  </a-card>

  <a-drawer v-model:open="drawerOpen" :width="680" :title="detail ? `${taskText(detail.type)} · ${detail.instanceName ?? ''}` : t('taskCenter.detail')" destroy-on-close>
    <a-spin :spinning="detailLoading">
      <template v-if="detail">
        <a-space style="margin-bottom: 12px">
          <a-popconfirm v-if="detail.canCancel && canCancel(detail)" :title="t('taskCenter.cancelConfirm')" :ok-text="t('common.ok')" :cancel-text="t('common.cancel')" @confirm="cancel(detail)">
            <a-button danger :loading="busy === detail.id">{{ t('taskCenter.cancel') }}</a-button>
          </a-popconfirm>
          <a-popconfirm v-if="detail.canRetry && canRetry(detail)" :title="t('taskCenter.retryConfirm')" :ok-text="t('common.ok')" :cancel-text="t('common.cancel')" @confirm="retry(detail)">
            <a-button type="primary" :loading="busy === detail.id">{{ t('taskCenter.retry') }}</a-button>
          </a-popconfirm>
        </a-space>
        <a-descriptions :column="1" size="small" bordered>
          <a-descriptions-item label="ID"><a-typography-text copyable>{{ detail.id }}</a-typography-text></a-descriptions-item>
          <a-descriptions-item :label="t('common.status')">
            <a-tag :color="TASK_STATUS_COLOR[detail.status]">{{ taskStatusText(detail.status) }}</a-tag>
            <a-tag v-if="detail.cancelRequested && detail.status === 'running'" color="warning">{{ t('taskCenter.cancelRequested') }}</a-tag>
          </a-descriptions-item>
          <a-descriptions-item :label="t('taskCenter.type')">{{ taskText(detail.type) }} <span class="muted">({{ detail.type }})</span></a-descriptions-item>
          <a-descriptions-item :label="t('taskCenter.target')">
            <router-link v-if="targetLink(detail)" :to="targetLink(detail)!">{{ detail.instanceName ?? detail.refId }}</router-link>
            <span v-else>{{ detail.instanceName ?? '—' }}</span>
          </a-descriptions-item>
          <a-descriptions-item :label="t('taskCenter.attempts')">
            {{ detail.attempts }}/{{ detail.maxAttempts }}<span v-if="detail.timeoutMs" class="muted"> · {{ t('taskCenter.timeout', { s: Math.round(detail.timeoutMs / 1000) }) }}</span>
          </a-descriptions-item>
          <a-descriptions-item :label="t('taskCenter.owner')">{{ owner(detail) }}</a-descriptions-item>
          <a-descriptions-item :label="t('taskCenter.createdAt')">{{ fmtTime(detail.createdAt) }}</a-descriptions-item>
          <a-descriptions-item v-if="detail.runAt" :label="t('taskCenter.runAt')">{{ fmtTime(detail.runAt) }}</a-descriptions-item>
          <a-descriptions-item :label="t('taskCenter.startedAt')">{{ fmtTime(detail.startedAt) }}</a-descriptions-item>
          <a-descriptions-item :label="t('taskCenter.finishedAt')">{{ fmtTime(detail.finishedAt) }} <span class="muted">({{ duration(detail) }})</span></a-descriptions-item>
          <a-descriptions-item v-if="detail.retryOf" :label="t('taskCenter.retryOf')"><a @click="openDetail(detail.retryOf)">{{ detail.retryOf }}</a></a-descriptions-item>
          <a-descriptions-item v-if="detail.error" :label="t('taskCenter.lastError')">
            <a-typography-text type="danger">{{ errText(detail) }}</a-typography-text>
            <div v-if="detail.errorCode" class="muted">{{ t('taskCenter.errorCode') }}: {{ detail.errorCode }}<span v-if="errText(detail) !== detail.error"> · {{ detail.error }}</span></div>
          </a-descriptions-item>
        </a-descriptions>

        <h4 class="section">{{ t('taskCenter.payload') }}</h4>
        <pre class="json">{{ json(detail.payload ?? {}) }}</pre>
        <template v-if="detail.result !== null && detail.result !== undefined">
          <h4 class="section">{{ t('taskCenter.result') }}</h4>
          <pre class="json">{{ json(detail.result) }}</pre>
        </template>

        <h4 class="section">{{ t('taskCenter.logs') }}</h4>
        <a-empty v-if="!logs.length" :description="t('taskCenter.noLogs')" />
        <a-timeline v-else>
          <a-timeline-item v-for="l in logs" :key="l.id" :color="LOG_COLOR[l.level]">
            <div class="log-head"><span class="muted">{{ new Date(l.ts).toLocaleString(dateLocale()) }}</span> {{ logText(l.message, l.data) }}</div>
            <pre v-if="l.data && Object.keys(l.data).length" class="log-data">{{ json(l.data) }}</pre>
          </a-timeline-item>
        </a-timeline>
      </template>
    </a-spin>
  </a-drawer>
</template>

<style scoped>
.filters { margin: 4px 0 12px; row-gap: 8px; }
.muted { color: var(--cp-text-tertiary); font-size: 12px; }
.section { margin: 16px 0 8px; }
.json, .log-data {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; background: var(--cp-fill-alter); border: 1px solid var(--cp-border-secondary);
  border-radius: 6px; padding: 8px; margin: 0; max-height: 240px; overflow: auto; white-space: pre-wrap; word-break: break-all;
}
.log-data { margin-top: 4px; max-height: 160px; }
.log-head { word-break: break-word; }
</style>
