<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import { deviceListLink } from '../api/query'
import type { Instance, InstanceStatus } from '../api/types'
import { fmtDateTime } from '../i18n'
import DeviceLogDrawer from '../components/DeviceLogDrawer.vue'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import StatusTag from '../components/common/StatusTag.vue'
import { actionColumn, pagination, TABLE_SIZE } from '../components/common/ui'
import { useInstancesStore } from '../stores/instances'

/**
 * Connection monitoring (连线监控): every device the viewer can see with its live link state
 * (GET /api/system/connections, admin only since 2026-11-18), polled every 10 s. 日志 opens the shared device log drawer
 * (its 连线 tab has the status/adb change history).
 */
interface Row {
  id: string; name: string; engine: string; sourceId: string | null; status: InstanceStatus
  adbState: string | null; bootCompleted: boolean; stfReady: boolean; lastError: string | null
  proxyId: string | null; proxyStatus: Instance['proxyStatus']
  lastOfflineAt: string | null
  adbRttMs: number | null; adbRttAt: string | null
  scrcpy: { viewers: number; link: 'relay' | 'adb' } | null
}

const { t } = useI18n()
const store = useInstancesStore()
const rows = ref<Row[]>([])
const loading = ref(false)
const search = ref('')
const onlyIssues = ref(false)

const issue = (r: Row) => r.status === 'error' || (r.status === 'running' && (r.adbState !== 'device' || !r.stfReady)) || r.proxyStatus?.ok === false
const shown = computed(() => {
  const q = search.value.trim().toLowerCase()
  return rows.value.filter((r) => (!q || r.name.toLowerCase().includes(q)) && (!onlyIssues.value || issue(r)))
})

async function load(quiet = false) {
  if (!quiet) loading.value = true
  try { rows.value = (await api<{ devices: Row[] }>('GET', '/api/system/connections')).devices }
  catch (e) { if (!quiet) message.error(errorText(e)) }
  finally { loading.value = false }
}
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { void load(); timer = setInterval(() => { if (!document.hidden) void load(true) }, 10_000) })
onBeforeUnmount(() => clearInterval(timer))

const adbColor = (s: string | null) => (s === 'device' ? 'green' : s ? 'red' : 'default')
const rttColor = (ms: number) => (ms < 100 ? 'green' : ms < 500 ? 'orange' : 'red')

// 日志 (shared device log drawer)
const logOpen = ref(false)
const logInstance = ref<Instance | null>(null)
async function openLogs(r: Row) {
  if (!store.byId.get(r.id)) await store.refresh()
  logInstance.value = store.byId.get(r.id) ?? null
  if (logInstance.value) logOpen.value = true
}

const columns = computed(() => [
  { title: t('common.device'), key: 'name', fixed: 'left' as const, width: 180 },
  { title: t('common.status'), key: 'status', width: 100 },
  { title: t('sysadmin.conn.adb'), key: 'adb', width: 110 },
  { title: t('sysadmin.conn.stf'), key: 'stf', width: 90 },
  { title: t('sysadmin.conn.scrcpy'), key: 'scrcpy', width: 140 },
  { title: t('sysadmin.conn.proxy'), key: 'proxy', width: 170 },
  { title: t('sysadmin.conn.rtt'), key: 'rtt', width: 110 },
  { title: t('sysadmin.conn.lastOffline'), key: 'lastOffline', width: 170 },
  actionColumn(110),
])
</script>

<template>
  <PageContainer>
    <a-card :bordered="false">
      <SearchBar :loading="loading" @refresh="load()">
        <a-input-search v-model:value="search" :placeholder="t('sysadmin.conn.search')" allow-clear style="width: 220px" />
        <a-checkbox v-model:checked="onlyIssues">{{ t('sysadmin.conn.onlyIssues') }}</a-checkbox>
        <template #actions><span class="muted small">{{ t('sysadmin.conn.autoRefresh') }}</span></template>
      </SearchBar>
      <a-table :data-source="shown" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :pagination="pagination({ defaultPageSize: 50 })" :scroll="{ x: 1180 }">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <router-link :to="deviceListLink(record.id)">{{ record.name }}</router-link>
          </template>
          <template v-else-if="column.key === 'status'">
            <a-tooltip :title="record.lastError"><StatusTag :status="record.status" /></a-tooltip>
          </template>
          <template v-else-if="column.key === 'adb'">
            <a-tag :color="adbColor(record.adbState)">{{ record.adbState ?? '—' }}</a-tag>
          </template>
          <template v-else-if="column.key === 'stf'">
            <a-tag :color="record.stfReady ? 'green' : 'default'">{{ record.stfReady ? t('sysadmin.conn.ready') : t('sysadmin.conn.notReady') }}</a-tag>
          </template>
          <template v-else-if="column.key === 'scrcpy'">
            <template v-if="record.scrcpy">
              <a-tag color="blue">{{ t(`sysadmin.conn.link.${record.scrcpy.link}`) }}</a-tag>
              <span class="muted small">{{ t('sysadmin.conn.viewers', { n: record.scrcpy.viewers }) }}</span>
            </template>
            <span v-else class="muted">{{ t('sysadmin.conn.idle') }}</span>
          </template>
          <template v-else-if="column.key === 'proxy'">
            <span v-if="!record.proxyId" class="muted">{{ t('sysadmin.conn.noProxy') }}</span>
            <a-tooltip v-else-if="record.proxyStatus" :title="`${record.proxyStatus.error ?? ''} ${fmtDateTime(record.proxyStatus.checkedAt)}`">
              <a-tag :color="record.proxyStatus.ok ? 'green' : 'red'">{{ record.proxyStatus.ok ? t('sysadmin.conn.egressOk') : t('sysadmin.conn.egressFail') }}</a-tag>
              <span class="small">{{ record.proxyStatus.egressIp ?? '' }}</span>
            </a-tooltip>
            <span v-else class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'rtt'">
            <a-tooltip v-if="record.adbRttMs !== null" :title="t('sysadmin.conn.measuredAt', { at: fmtDateTime(record.adbRttAt) })">
              <a-tag :color="rttColor(record.adbRttMs)">{{ record.adbRttMs }} ms</a-tag>
            </a-tooltip>
            <span v-else class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'lastOffline'">{{ fmtDateTime(record.lastOfflineAt) }}</template>
          <template v-else-if="column.key === 'ops'">
            <a-button size="small" type="link" @click="openLogs(record as Row)">{{ t('devices.log') }}</a-button>
          </template>
        </template>
      </a-table>
    </a-card>

    <DeviceLogDrawer v-model:open="logOpen" :instance="logInstance" />
  </PageContainer>
</template>
