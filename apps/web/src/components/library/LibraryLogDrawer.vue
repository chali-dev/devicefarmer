<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import type { LibraryApp, LibraryInstallLog } from '../../api/types'
import { dateLocale } from '../../i18n'
import { useInstancesStore } from '../../stores/instances'
import StatusTag from '../common/StatusTag.vue'
import { DRAWER_WIDTH, pagination } from '../common/ui'

/** Install log of a library app's package (every version): the install-apk tasks from the task centre. */
const props = defineProps<{ app: LibraryApp | null }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const store = useInstancesStore()

const PAGE = 20
const items = ref<LibraryInstallLog[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
const error = ref<string | null>(null)

async function load() {
  if (!props.app) return
  loading.value = true
  error.value = null
  try {
    const r = await api<{ items: LibraryInstallLog[]; total: number }>('GET', `/api/library/${props.app.id}/logs?limit=${PAGE}&offset=${(page.value - 1) * PAGE}`)
    items.value = r.items; total.value = r.total
  } catch (e) { error.value = errorText(e) }
  finally { loading.value = false }
}
watch(() => props.app, (a) => { items.value = []; total.value = 0; page.value = 1; if (a) void load() }, { immediate: true })

// Live: status changes of listed tasks are applied in place; a new install task reloads (debounced).
let timer: ReturnType<typeof setTimeout> | undefined
const off = store.onTaskEvent((ev) => {
  if (!props.app || ev.type !== 'task.updated' || ev.task.type !== 'install-apk') return
  const row = items.value.find((x) => x.taskId === ev.task.id)
  if (row) { row.status = ev.task.status; row.errorCode = ev.task.errorCode ?? null; row.error = ev.task.error ?? null; row.finishedAt = ev.task.finishedAt ?? null; return }
  clearTimeout(timer)
  timer = setTimeout(() => void load(), 800)
})
onBeforeUnmount(() => { off(); clearTimeout(timer) })

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString(dateLocale()) : '—')
const version = (r: LibraryInstallLog) => (r.versionName ? `${r.versionName} (${r.versionCode})` : r.versionCode ?? '—')
const columns = computed(() => [
  { title: t('common.time'), key: 'time', width: 150 },
  { title: t('common.device'), key: 'device', width: 130 },
  { title: t('common.operator'), key: 'operator', width: 100 },
  { title: t('library.version'), key: 'version', width: 140 },
  { title: t('library.result'), key: 'result' },
  { title: '', key: 'task', width: 60 },
])
</script>

<template>
  <a-drawer :open="!!app" :width="DRAWER_WIDTH.lg" :title="t('library.logsTitle', { pkg: app?.package ?? '' })" @close="emit('close')">
    <a-alert v-if="error" type="error" :message="error" show-icon style="margin-bottom: 12px" />
    <a-table :data-source="items" :columns="columns" row-key="taskId" size="small" :loading="loading" :scroll="{ x: 680 }"
      :locale="{ emptyText: t('library.logsEmpty') }"
      :pagination="pagination({ current: page, pageSize: PAGE, total, showSizeChanger: false, onChange: (p: number) => { page = p; void load() } })">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'time'">{{ fmt(record.createdAt) }}</template>
        <template v-else-if="column.key === 'device'">
          <router-link v-if="record.instanceId && record.deviceExists" :to="`/instances/${record.instanceId}`">{{ record.instanceName }}</router-link>
          <span v-else>{{ record.instanceName || '—' }}</span>
        </template>
        <template v-else-if="column.key === 'operator'">{{ record.operator ?? t('common.system') }}</template>
        <template v-else-if="column.key === 'version'">
          {{ version(record) }} <a-tag v-if="record.preinstall">{{ t('library.preinstallTag') }}</a-tag>
        </template>
        <template v-else-if="column.key === 'result'">
          <StatusTag kind="task" :status="record.status" />
          <span v-if="record.status === 'failed'" class="muted">
            {{ codeText(record.errorCode, undefined, record.error ?? '') }}<span v-if="record.errorCode" class="mono"> ({{ record.errorCode }})</span>
          </span>
        </template>
        <template v-else-if="column.key === 'task'">
          <router-link :to="{ path: '/tasks', query: { task: record.taskId } }">{{ t('common.view') }}</router-link>
        </template>
      </template>
    </a-table>
  </a-drawer>
</template>
