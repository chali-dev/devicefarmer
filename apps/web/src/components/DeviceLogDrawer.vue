<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '../api/client'
import { TASK_STATUS, TASK_TEXT, type Instance, type Task } from '../api/types'
import { useInstancesStore } from '../stores/instances'

/** Per-device log: task history (live) and Android logcat on demand. */
const props = defineProps<{ instance: Instance | null }>()
const open = defineModel<boolean>('open', { required: true })
const store = useInstancesStore()

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
  } catch (e) { tasksError.value = (e as Error).message } finally { tasksLoading.value = false }
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
function operator(t: Task) {
  if (t.createdByName) return t.createdByName
  return t.createdBy ? '—' : '系统'
}
const taskColumns = [
  { title: '时间', key: 'time', width: 160 },
  { title: '操作', key: 'type', width: 130 },
  { title: '状态', key: 'status', width: 80 },
  { title: '操作人', key: 'by', width: 100 },
  { title: '错误', key: 'error' },
]

// ---- 系统日志
const LEVELS = [{ value: 'E', label: '错误' }, { value: 'W', label: '警告' }, { value: 'I', label: '信息' }, { value: 'D', label: '调试' }] as const
const level = ref<'E' | 'W' | 'I' | 'D'>('W')
const keyword = ref('')
const lines = ref<string[]>([])
const logLoading = ref(false)
const logError = ref<string | null>(null)
const logLoaded = ref(false)
async function loadLogcat() {
  if (!props.instance) return
  if (props.instance.status !== 'running') { logError.value = '设备未运行，无法读取系统日志'; lines.value = []; return }
  logLoading.value = true
  logError.value = null
  try {
    lines.value = await store.logcat(props.instance.id, { lines: 500, level: level.value, q: keyword.value.trim() || undefined })
    logLoaded.value = true
  } catch (e) { logError.value = (e as Error).message } finally { logLoading.value = false }
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
  <a-drawer v-model:open="open" :width="720" :title="`${instance?.name ?? ''} · 设备日志`" destroy-on-close>
    <a-tabs v-model:active-key="tab">
      <a-tab-pane key="tasks" tab="操作记录">
        <a-alert v-if="tasksError" type="error" :message="tasksError" show-icon style="margin-bottom: 12px" />
        <a-table :data-source="taskRows" :columns="taskColumns" row-key="id" size="small" :loading="tasksLoading"
          :pagination="{ pageSize: 20, size: 'small', hideOnSinglePage: true }" :locale="{ emptyText: '暂无操作记录' }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'time'">{{ new Date(record.createdAt).toLocaleString() }}</template>
            <template v-else-if="column.key === 'type'">{{ TASK_TEXT[record.type] ?? record.type }}</template>
            <template v-else-if="column.key === 'status'">
              <a-tag :color="TASK_STATUS[record.status as Task['status']]?.color">{{ TASK_STATUS[record.status as Task['status']]?.text ?? record.status }}</a-tag>
            </template>
            <template v-else-if="column.key === 'by'">{{ operator(record as Task) }}</template>
            <template v-else-if="column.key === 'error'">
              <a-typography-text v-if="record.error" type="danger" :ellipsis="{ tooltip: record.error }" :content="record.error" />
            </template>
          </template>
        </a-table>
      </a-tab-pane>
      <a-tab-pane key="logcat" tab="系统日志">
        <a-space wrap style="margin-bottom: 12px">
          <a-select v-model:value="level" :options="LEVELS as any" style="width: 100px" @change="loadLogcat" />
          <a-input-search v-model:value="keyword" placeholder="关键字过滤" allow-clear style="width: 220px" @search="loadLogcat" />
          <a-button :loading="logLoading" @click="loadLogcat">刷新</a-button>
          <span style="color: #8c8c8c; font-size: 12px">{{ lines.length }} 行（最近 500 行，级别及以上）</span>
        </a-space>
        <a-alert v-if="logError" type="error" :message="logError" show-icon style="margin-bottom: 12px" />
        <a-spin :spinning="logLoading">
          <div class="logcat">
            <div v-if="!lines.length" class="empty">{{ logLoaded ? '没有匹配的日志' : '' }}</div>
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
  background: #fafafa;
  border: 1px solid #f0f0f0;
  border-radius: 6px;
  padding: 8px;
  height: calc(100vh - 230px);
  min-height: 240px;
  overflow: auto;
}
.line { white-space: pre-wrap; word-break: break-all; }
.lv-E, .lv-F { color: #cf1322; }
.lv-W { color: #d46b08; }
.empty { color: #8c8c8c; padding: 16px; text-align: center; }
</style>
