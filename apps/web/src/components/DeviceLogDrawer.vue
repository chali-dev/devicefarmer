<script setup lang="ts">
import { dateLocale } from '../i18n'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import { TASK_STATUS_COLOR, taskStatusText, taskText, type Instance, type Task } from '../api/types'
import { useInstancesStore } from '../stores/instances'

/** Per-device log: task history (live) and Android logcat on demand. */
const props = defineProps<{ instance: Instance | null }>()
const open = defineModel<boolean>('open', { required: true })
const store = useInstancesStore()
const { t } = useI18n()

const tab = ref<'tasks' | 'logcat'>('tasks')

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
  { title: t('common.status'), key: 'status', width: 80 },
  { title: t('common.operator'), key: 'by', width: 100 },
  { title: t('common.error'), key: 'error' },
])

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
  void loadTasks()
}, { immediate: true })
watch(tab, (t) => { if (t === 'logcat' && !logLoaded.value) void loadLogcat() })
</script>

<template>
  <a-drawer v-model:open="open" :width="720" :title="t('logs.title', { name: instance?.name ?? '' })" destroy-on-close>
    <a-tabs v-model:active-key="tab">
      <a-tab-pane key="tasks" :tab="t('logs.tasks')">
        <a-alert v-if="tasksError" type="error" :message="tasksError" show-icon style="margin-bottom: 12px" />
        <a-table :data-source="taskRows" :columns="taskColumns" row-key="id" size="small" :loading="tasksLoading"
          :pagination="{ pageSize: 20, size: 'small', hideOnSinglePage: true }" :locale="{ emptyText: t('logs.noTasks') }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'time'">{{ new Date(record.createdAt).toLocaleString(dateLocale()) }}</template>
            <template v-else-if="column.key === 'type'">{{ taskText(record.type) }}</template>
            <template v-else-if="column.key === 'status'">
              <a-tag :color="TASK_STATUS_COLOR[record.status as Task['status']]">{{ taskStatusText(record.status) }}</a-tag>
            </template>
            <template v-else-if="column.key === 'by'">{{ operator(record as Task) }}</template>
            <template v-else-if="column.key === 'error'">
              <a-typography-text v-if="record.error" type="danger" :ellipsis="{ tooltip: record.error }" :content="record.error" />
            </template>
          </template>
        </a-table>
      </a-tab-pane>
      <a-tab-pane key="logcat" :tab="t('logs.logcat')">
        <a-space wrap style="margin-bottom: 12px">
          <a-select v-model:value="level" :options="LEVELS" style="width: 100px" @change="loadLogcat" />
          <a-input-search v-model:value="keyword" :placeholder="t('logs.keyword')" allow-clear style="width: 220px" @search="loadLogcat" />
          <a-button :loading="logLoading" @click="loadLogcat">{{ t('common.refresh') }}</a-button>
          <span class="count">{{ t('logs.lines', { n: lines.length }) }}</span>
        </a-space>
        <a-alert v-if="logError" type="error" :message="logError" show-icon style="margin-bottom: 12px" />
        <a-spin :spinning="logLoading">
          <div class="logcat">
            <div v-if="!lines.length" class="empty">{{ logLoaded ? t('logs.noMatch') : '' }}</div>
            <div v-for="(l, i) in lines" :key="i" :class="['line', `lv-${lineLevel(l)}`]">{{ l }}</div>
          </div>
        </a-spin>
      </a-tab-pane>
    </a-tabs>
  </a-drawer>
</template>

<style scoped>
.logcat {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  background: var(--cp-fill-alter);
  border: 1px solid var(--cp-border-secondary);
  border-radius: 6px;
  padding: 8px;
  height: calc(100vh - 230px);
  min-height: 240px;
  overflow: auto;
}
.line { white-space: pre-wrap; word-break: break-all; }
/* Dark red / orange on light backgrounds; lighter tints (red-4 / orange-5) on dark ones. */
.lv-E, .lv-F { color: #cf1322; }
.lv-W { color: #d46b08; }
:root[data-theme='dark'] .lv-E, :root[data-theme='dark'] .lv-F { color: #ff7875; }
:root[data-theme='dark'] .lv-W { color: #ffa940; }
.empty { color: var(--cp-text-tertiary); padding: 16px; text-align: center; }
.count { color: var(--cp-text-tertiary); font-size: 12px; }
</style>
