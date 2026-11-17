<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import type { Instance, InstanceStatus } from '../api/types'
import { dateLocale } from '../i18n'
import DeviceLogDrawer from '../components/DeviceLogDrawer.vue'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import StatusTag from '../components/common/StatusTag.vue'
import { actionColumn, DRAWER_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'
import { useInstancesStore } from '../stores/instances'

/**
 * Connection monitoring (连线监控): every device the viewer can see with its live link state
 * (GET /api/system/connections, RBAC-scoped), polled every 10 s. Per-device history on demand;
 * device logs open the existing log drawer.
 */
interface Row {
  id: string; name: string; engine: string; sourceId: string | null; status: InstanceStatus
  adbState: string | null; bootCompleted: boolean; stfReady: boolean; lastError: string | null
  proxyId: string | null; proxyStatus: Instance['proxyStatus']
  changes24h: number; offline24h: number; lastOfflineAt: string | null
  adbRttMs: number | null; adbRttAt: string | null
  scrcpy: { viewers: number; link: 'relay' | 'adb' } | null
}
interface HistoryEvent { id: number; field: 'status' | 'adb'; from: string | null; to: string | null; status: string; at: string; offline: boolean }

const { t } = useI18n()
const store = useInstancesStore()
const rows = ref<Row[]>([])
const loading = ref(false)
const search = ref('')
const onlyIssues = ref(false)

const issue = (r: Row) => r.offline24h > 0 || r.status === 'error' || (r.status === 'running' && (r.adbState !== 'device' || !r.stfReady)) || r.proxyStatus?.ok === false
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
onMounted(() => { void load(); timer = setInterval(() => void load(true), 10_000) })
onBeforeUnmount(() => clearInterval(timer))

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(dateLocale()) : '—')
const adbColor = (s: string | null) => (s === 'device' ? 'green' : s ? 'red' : 'default')
const rttColor = (ms: number) => (ms < 100 ? 'green' : ms < 500 ? 'orange' : 'red')

// history drawer
const historyOpen = ref(false)
const historyFor = ref<Row | null>(null)
const history = ref<HistoryEvent[]>([])
const historyLoading = ref(false)
async function openHistory(r: Row) {
  historyFor.value = r
  historyOpen.value = true
  historyLoading.value = true
  history.value = []
  try { history.value = (await api<{ events: HistoryEvent[] }>('GET', `/api/system/connections/${r.id}/history`)).events }
  catch (e) { message.error(errorText(e)) }
  finally { historyLoading.value = false }
}
const stateText = (field: string, v: string | null) => (v === null ? '—' : field === 'status' ? t(`status.${v}`) : v)

// device logs (existing drawer)
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
  { title: t('sysadmin.conn.offline24h'), key: 'offline', width: 120 },
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
      <a-table :data-source="shown" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :pagination="pagination({ defaultPageSize: 50 })" :scroll="{ x: 1300 }">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <router-link :to="`/instances/${record.id}`">{{ record.name }}</router-link>
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
            <a-tooltip v-else-if="record.proxyStatus" :title="`${record.proxyStatus.error ?? ''} ${fmt(record.proxyStatus.checkedAt)}`">
              <a-tag :color="record.proxyStatus.ok ? 'green' : 'red'">{{ record.proxyStatus.ok ? t('sysadmin.conn.egressOk') : t('sysadmin.conn.egressFail') }}</a-tag>
              <span class="small">{{ record.proxyStatus.egressIp ?? '' }}</span>
            </a-tooltip>
            <span v-else class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'rtt'">
            <a-tooltip v-if="record.adbRttMs !== null" :title="t('sysadmin.conn.measuredAt', { at: fmt(record.adbRttAt) })">
              <a-tag :color="rttColor(record.adbRttMs)">{{ record.adbRttMs }} ms</a-tag>
            </a-tooltip>
            <span v-else class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'offline'">
            <a @click="openHistory(record as Row)">
              <a-badge :count="record.offline24h" :show-zero="true" :number-style="record.offline24h ? {} : { backgroundColor: 'var(--cp-fill-alter)', color: 'var(--cp-text-secondary)' }" />
              <span class="small changes">{{ t('sysadmin.conn.changes', { n: record.changes24h }) }}</span>
            </a>
          </template>
          <template v-else-if="column.key === 'lastOffline'">{{ fmt(record.lastOfflineAt) }}</template>
          <template v-else-if="column.key === 'ops'">
            <a-button size="small" type="link" @click="openLogs(record as Row)">{{ t('sysadmin.conn.deviceLogs') }}</a-button>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-drawer v-model:open="historyOpen" :title="t('sysadmin.conn.historyTitle', { name: historyFor?.name ?? '' })" :width="DRAWER_WIDTH.md">
      <a-spin :spinning="historyLoading">
        <a-empty v-if="!historyLoading && !history.length" :description="t('sysadmin.conn.noHistory')" />
        <a-timeline v-else class="history">
          <a-timeline-item v-for="e in history" :key="e.id" :color="e.offline ? 'red' : 'blue'">
            <div class="muted small">{{ fmt(e.at) }}</div>
            {{ t(`sysadmin.conn.field.${e.field}`) }}: {{ stateText(e.field, e.from) }} → {{ stateText(e.field, e.to) }}
            <a-tag v-if="e.offline" color="red" class="tag">{{ t('sysadmin.conn.offlineTag') }}</a-tag>
          </a-timeline-item>
        </a-timeline>
      </a-spin>
    </a-drawer>
    <DeviceLogDrawer v-model:open="logOpen" :instance="logInstance" />
  </PageContainer>
</template>

<style scoped>
.changes { margin-left: 8px; }
.history { padding-top: 6px; }
.tag { margin-left: 6px; }
</style>
