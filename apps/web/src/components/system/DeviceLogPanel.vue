<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { fmtDateTime } from '../../i18n'
import { useInstancesStore } from '../../stores/instances'
import SearchBar from '../common/SearchBar.vue'
import { pagination, TABLE_SIZE } from '../common/ui'

/**
 * 系统日志 → 设备日志 (admin): every device's status and adb changes in one paged list (GET /api/system/device-logs,
 * from instance_status_events). A single device's tasks, connection history and logcat stay in its log drawer.
 */
interface DeviceLog {
  id: number; instanceId: string; instanceName: string; sourceId: string; field: 'status' | 'adb'
  from: string | null; to: string | null; status: string; at: string; offline: boolean
}
const { t } = useI18n()
const store = useInstancesStore()
const filters = reactive({ instanceId: undefined as string | undefined, type: undefined as 'status' | 'adb' | 'offline' | undefined, range: null as [string, string] | null })
const items = ref<DeviceLog[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(50)
const loading = ref(false)

async function load() {
  loading.value = true
  const p = new URLSearchParams({ limit: String(pageSize.value), offset: String((page.value - 1) * pageSize.value) })
  if (filters.instanceId) p.set('instanceId', filters.instanceId)
  if (filters.type) p.set('type', filters.type)
  if (filters.range) { p.set('from', filters.range[0]); p.set('to', filters.range[1]) }
  try {
    const r = await api<{ items: DeviceLog[]; total: number }>('GET', `/api/system/device-logs?${p}`)
    items.value = r.items
    total.value = r.total
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
onMounted(load)
function search() { page.value = 1; void load() }
function reset() { Object.assign(filters, { instanceId: undefined, type: undefined, range: null }); search() }
function onPage(p: number, size: number) { page.value = p; pageSize.value = size; void load() }

const deviceOptions = computed(() => store.list.map((i) => ({ value: i.id, label: i.name })))
const typeOptions = computed(() => (['status', 'adb', 'offline'] as const).map((v) => ({ value: v, label: t(`sysadmin.deviceLogs.types.${v}`) })))
const stateText = (field: string, v: string | null) => (v === null ? '—' : field === 'status' ? t(`status.${v}`) : v)
const columns = computed(() => [
  { title: t('common.time'), key: 'at', width: 180 },
  { title: t('sysadmin.deviceLogs.device'), key: 'device', width: 200, ellipsis: true },
  { title: t('sysadmin.deviceLogs.type'), key: 'field', width: 110 },
  { title: t('sysadmin.deviceLogs.change'), key: 'change' },
])
</script>

<template>
  <div>
    <SearchBar :loading="loading" @reset="reset" @refresh="load">
      <a-select
        v-model:value="filters.instanceId" :options="deviceOptions" show-search option-filter-prop="label" allow-clear
        :placeholder="t('sysadmin.deviceLogs.allDevices')" style="width: 220px" @change="search"
      />
      <a-select v-model:value="filters.type" :options="typeOptions" allow-clear :placeholder="t('sysadmin.deviceLogs.allTypes')" style="width: 160px" @change="search" />
      <a-range-picker v-model:value="filters.range" show-time value-format="YYYY-MM-DDTHH:mm:ssZ" @change="search" />
    </SearchBar>
    <a-table
      :data-source="items" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :scroll="{ x: 720 }"
      :locale="{ emptyText: t('sysadmin.deviceLogs.empty') }"
      :pagination="pagination({ current: page, pageSize, total, onChange: onPage })"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'at'">{{ fmtDateTime(record.at) }}</template>
        <template v-else-if="column.key === 'device'">
          <router-link :to="{ path: '/instances', query: { id: record.instanceId } }">{{ record.instanceName }}</router-link>
        </template>
        <template v-else-if="column.key === 'field'">{{ t(`logs.connField.${record.field}`) }}</template>
        <template v-else-if="column.key === 'change'">
          {{ stateText(record.field, record.from) }} → {{ stateText(record.field, record.to) }}
          <a-tag v-if="record.offline" color="red" class="tag">{{ t('logs.offlineTag') }}</a-tag>
          <span v-if="record.field === 'adb'" class="muted small"> · {{ t(`status.${record.status}`) }}</span>
        </template>
      </template>
    </a-table>
  </div>
</template>

<style scoped>
.tag { margin-inline-start: 8px; }
</style>
