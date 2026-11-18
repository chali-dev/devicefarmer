<script setup lang="ts">
import { ReloadOutlined } from '@ant-design/icons-vue'
import { dateLocale } from '../i18n'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import { taskText, type Instance, type Task } from '../api/types'
import StatusTag from './common/StatusTag.vue'
import { DRAWER_WIDTH, pagination } from './common/ui'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

/**
 * Per-device log (日志): task history (live), connection history (status/adb changes; admins only, like 连线监控) and
 * Android logcat on demand.
 */
const props = defineProps<{ instance: Instance | null }>()
const open = defineModel<boolean>('open', { required: true })
const store = useInstancesStore()
const auth = useAuthStore()
const { t } = useI18n()

const tab = ref<'tasks' | 'conn' | 'logcat'>('tasks')

// ---- 操作记录
const fetched = ref<Task[]>([])
const tasksLoading = ref(false)
const tasksError = ref<string | null>(null)
async function loadTasks() {
  if (!props.instance) return
  tasksLoading.value = true
  tasksError.value = null
  try {
    fetched.value = (await api<{ tasks: Task[] }>('GET', `/api/tasks?instanceId=${props.instance.id}&limit=200`)).tasks
  } catch (e) { tasksError.value = errorText(e) } finally { tasksLoading.value = false }
}
/** Fetched history merged with the store's live task events (newer status wins, resolved names kept). */
const taskRows = computed(() => {
  const id = props.instance?.id
  const m = new Map(fetched.value.map((t) => [t.id, t]))
  for (const t of store.tasks) {
    if (t.instanceId !== id) continue
    const prev = m.get(t.id)
    m.set(t.id, { ...t, createdByName: t.createdByName ?? prev?.createdByName })
  }
  return [...m.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
})
function operator(task: Task) {
  if (task.createdByName) return task.createdByName
  return task.createdBy ? '—' : t('common.system')
}
const taskColumns = computed(() => [
  { title: t('common.time'), key: 'time', width: 160 },
  { title: t('common.action'), key: 'type', width: 130 },
  { title: t('common.status'), key: 'status', width: 90 },
  { title: t('common.operator'), key: 'by', width: 100 },
  { title: t('common.error'), key: 'error' },
])

// ---- 连线: status/adb changes (instance_status_events, GET /api/system/connections/:id/history, admin only)
interface ConnEvent { id: number; field: 'status' | 'adb'; from: string | null; to: string | null; status: string; at: string; offline: boolean }
const CONN_HOURS = [24, 72, 168, 720] as const
const connHours = ref<number>(24)
const connRanges = computed(() => CONN_HOURS.map((h) => ({ value: h, label: h < 48 ? t('logs.connRangeHours', { n: h }) : t('logs.connRangeDays', { n: h / 24 }) })))
const connEvents = ref<ConnEvent[]>([])
const connLoading = ref(false)
const connError = ref<string | null>(null)
const connLoaded = ref(false)
async function loadConn() {
  if (!props.instance) return
  connLoading.value = true
  connError.value = null
  try {
    connEvents.value = (await api<{ events: ConnEvent[] }>('GET', `/api/system/connections/${props.instance.id}/history?hours=${connHours.value}`)).events
    connLoaded.value = true
  } catch (e) { connError.value = errorText(e) } finally { connLoading.value = false }
}
const stateText = (field: string, v: string | null) => (v === null ? '—' : field === 'status' ? t(`status.${v}`) : v)

// ---- 系统日志
const LEVELS = computed(() => (['E', 'W', 'I', 'D'] as const).map((value) => ({ value, label: t(`logs.level${value}`) })))
const level = ref<'E' | 'W' | 'I' | 'D'>('W')
const keyword = ref('')
const lines = ref<string[]>([])
const logLoading = ref(false)
const logError = ref<string | null>(null)
const logLoaded = ref(false)
async function loadLogcat() {
  if (!props.instance) return
  if (props.instance.status !== 'running') { logError.value = t('logs.notRunning'); lines.value = []; return }
  logLoading.value = true
  logError.value = null
  try {
    lines.value = await store.logcat(props.instance.id, { lines: 500, level: level.value, q: keyword.value.trim() || undefined })
    logLoaded.value = true
  } catch (e) { logError.value = errorText(e) } finally { logLoading.value = false }
}
function lineLevel(l: string) {
  return /^\S+ \S+ ([VDIWEF])\//.exec(l)?.[1] ?? ''
}

watch([open, () => props.instance?.id], ([o]) => {
  if (!o) return
  tab.value = 'tasks'
  fetched.value = []
  lines.value = []
  logLoaded.value = false
  logError.value = null
  keyword.value = ''
  connEvents.value = []
  connLoaded.value = false
  connError.value = null
  connHours.value = 24
  void loadTasks()
}, { immediate: true })
watch(tab, (t) => {
  if (t === 'logcat' && !logLoaded.value) void loadLogcat()
  if (t === 'conn' && !connLoaded.value) void loadConn()
})
</script>

<template>
  <a-drawer v-model:open="open" :width="DRAWER_WIDTH.lg" :title="t('logs.title', { name: instance?.name ?? '' })" destroy-on-close>
    <a-tabs v-model:active-key="tab">
      <a-tab-pane key="tasks" :tab="t('logs.tasks')">
        <a-alert v-if="tasksError" type="error" :message="tasksError" show-icon style="margin-bottom: 12px" />
        <a-table :data-source="taskRows" :columns="taskColumns" row-key="id" size="small" :loading="tasksLoading" :scroll="{ x: 640 }"
          :pagination="pagination({ defaultPageSize: 20, hideOnSinglePage: true })" :locale="{ emptyText: t('logs.noTasks') }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'time'">{{ new Date(record.createdAt).toLocaleString(dateLocale()) }}</template>
            <template v-else-if="column.key === 'type'">{{ taskText(record.type) }}</template>
            <template v-else-if="column.key === 'status'">
              <StatusTag kind="task" :status="record.status" />
            </template>
            <template v-else-if="column.key === 'by'">{{ operator(record as Task) }}</template>
            <template v-else-if="column.key === 'error'">
              <a-typography-text v-if="record.error" type="danger" :ellipsis="{ tooltip: record.error }" :content="record.error" />
            </template>
          </template>
        </a-table>
      </a-tab-pane>
      <a-tab-pane v-if="auth.isAdmin" key="conn" :tab="t('logs.conn')">
        <a-space wrap style="margin-bottom: 12px">
          <a-select v-model:value="connHours" :options="connRanges" style="width: 140px" @change="loadConn" />
          <a-tooltip :title="t('common.refresh')">
            <a-button :loading="connLoading" :aria-label="t('common.refresh')" @click="loadConn"><template #icon><ReloadOutlined /></template></a-button>
          </a-tooltip>
          <span v-if="connEvents.length >= 500" class="muted small">{{ t('logs.connLimit') }}</span>
        </a-space>
        <a-alert v-if="connError" type="error" :message="connError" show-icon style="margin-bottom: 12px" />
        <a-spin :spinning="connLoading">
          <a-empty v-if="connLoaded && !connEvents.length" :description="t('logs.noConn')" />
          <a-timeline v-else class="conn">
            <a-timeline-item v-for="e in connEvents" :key="e.id" :color="e.offline ? 'red' : 'blue'">
              <div class="muted small">{{ new Date(e.at).toLocaleString(dateLocale()) }}</div>
              {{ t(`logs.connField.${e.field}`) }}: {{ stateText(e.field, e.from) }} → {{ stateText(e.field, e.to) }}
              <a-tag v-if="e.offline" color="red" class="tag">{{ t('logs.offlineTag') }}</a-tag>
            </a-timeline-item>
          </a-timeline>
        </a-spin>
      </a-tab-pane>
      <a-tab-pane key="logcat" :tab="t('logs.logcat')">
        <a-space wrap style="margin-bottom: 12px">
          <a-select v-model:value="level" :options="LEVELS" style="width: 100px" @change="loadLogcat" />
          <a-input-search v-model:value="keyword" :placeholder="t('logs.keyword')" allow-clear style="width: 220px; max-width: 100%" @search="loadLogcat" />
          <a-tooltip :title="t('common.refresh')">
            <a-button :loading="logLoading" :aria-label="t('common.refresh')" @click="loadLogcat"><template #icon><ReloadOutlined /></template></a-button>
          </a-tooltip>
          <span class="muted small">{{ t('logs.lines', { n: lines.length }) }}</span>
        </a-space>
        <a-alert v-if="logError" type="error" :message="logError" show-icon style="margin-bottom: 12px" />
        <a-spin :spinning="logLoading">
          <div class="logcat mono">
            <div v-if="!lines.length" class="empty muted">{{ logLoaded ? t('logs.noMatch') : '' }}</div>
            <div v-for="(l, i) in lines" :key="i" :class="['line', `lv-${lineLevel(l)}`]">{{ l }}</div>
          </div>
        </a-spin>
      </a-tab-pane>
    </a-tabs>
  </a-drawer>
</template>

<style scoped>
.logcat {
  font-size: 12px; line-height: 1.5; padding: 8px; overflow: auto;
  height: calc(100vh - 230px); min-height: 240px;
  background: var(--cp-fill-alter); border: 1px solid var(--cp-border-secondary); border-radius: var(--cp-radius);
}
.line { white-space: pre-wrap; word-break: break-all; }
.lv-E, .lv-F { color: var(--cp-error); }
.lv-W { color: var(--cp-warning); }
.empty { padding: 16px; text-align: center; }
.conn { padding-top: 6px; }
.tag { margin-left: 6px; }
</style>
