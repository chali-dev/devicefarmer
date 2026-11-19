<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import { deviceListLink } from '../../api/query'
import type { RiskDevice, RiskEvent } from '../../api/types'
import { fmtDateTime } from '../../i18n'
import SearchBar from '../common/SearchBar.vue'
import { pagination, TABLE_SIZE } from '../common/ui'

/** 风控 → 风控记录: what the automatic device work ran into, newest first (kept 90 days). */
const { t } = useI18n()
const events = ref<RiskEvent[]>([])
const codes = ref<{ code: string; n: number }[]>([])
const total = ref(0)
const devices = ref<RiskDevice[]>([])
const loading = ref(false)
const filters = reactive({ instanceId: undefined as string | undefined, code: undefined as string | undefined })
const page = reactive({ current: 1, pageSize: 20 })

async function load() {
  loading.value = true
  try {
    const p = new URLSearchParams({ limit: String(page.pageSize), offset: String((page.current - 1) * page.pageSize) })
    if (filters.instanceId) p.set('instanceId', filters.instanceId)
    if (filters.code) p.set('code', filters.code)
    const r = await api<{ events: RiskEvent[]; total: number; codes: { code: string; n: number }[] }>('GET', `/api/risk/events?${p}`)
    events.value = r.events; total.value = r.total; codes.value = r.codes
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
onMounted(async () => {
  void load()
  try { devices.value = (await api<{ devices: RiskDevice[] }>('GET', '/api/risk/devices')).devices } catch { /* filter only */ }
})
const search = () => { page.current = 1; void load() }
function reset() { Object.assign(filters, { instanceId: undefined, code: undefined }); search() }
function onChange(p: { current?: number; pageSize?: number }) { page.current = p.current ?? 1; page.pageSize = p.pageSize ?? page.pageSize; void load() }

const columns = computed(() => [
  { title: t('risk.events.colTime'), key: 'at', width: 170 },
  { title: t('risk.events.colDevice'), key: 'device', width: 150 },
  { title: t('risk.events.colSource'), key: 'source', width: 110 },
  { title: t('risk.events.colCode'), key: 'code', width: 240 },
  { title: t('risk.events.colAccount'), key: 'account', width: 170 },
  { title: t('risk.events.colDetail'), key: 'detail', width: 260, ellipsis: true },
])
</script>

<template>
  <SearchBar :loading="loading" @reset="reset" @refresh="load">
    <a-select v-model:value="filters.instanceId" :placeholder="t('risk.events.colDevice')" allow-clear show-search option-filter-prop="label" style="width: 180px"
      :options="devices.map((d) => ({ value: d.id, label: d.name }))" @change="search" />
    <a-select v-model:value="filters.code" :placeholder="t('risk.events.colCode')" allow-clear style="width: 260px"
      :options="codes.map((c) => ({ value: c.code, label: `${codeText(c.code, undefined, c.code)} (${c.n})` }))" @change="search" />
  </SearchBar>
  <a-table :data-source="events" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :scroll="{ x: 1100 }"
    :pagination="pagination({ current: page.current, pageSize: page.pageSize, total })" :locale="{ emptyText: t('risk.events.empty') }" @change="onChange">
    <template #bodyCell="{ column, record }">
      <template v-if="column.key === 'at'">{{ fmtDateTime(record.at) }}</template>
      <template v-else-if="column.key === 'device'">
        <router-link v-if="record.instanceId" :to="deviceListLink(record.instanceId)">{{ record.instanceName ?? record.instanceId.slice(0, 8) }}</router-link>
        <span v-else class="muted">{{ record.instanceName ?? '—' }}</span>
      </template>
      <template v-else-if="column.key === 'source'">{{ t(`risk.sources.${record.source}`) }}</template>
      <template v-else-if="column.key === 'code'">{{ codeText(record.code, undefined, record.code) }}</template>
      <template v-else-if="column.key === 'account'">
        <span v-if="record.socialHandle">{{ t('risk.events.social') }} @{{ record.socialHandle }}</span>
        <span v-else-if="record.trackedHandle">{{ t('risk.events.tracked') }} @{{ record.trackedHandle }}</span>
        <span v-else class="muted">—</span>
        <div v-if="record.username" class="muted small">{{ record.username }}</div>
      </template>
      <template v-else-if="column.key === 'detail'"><span class="muted">{{ record.detail ?? '—' }}</span></template>
    </template>
  </a-table>
</template>

<style scoped>
.muted { color: var(--cp-text-tertiary); }
.small { font-size: 12px; }
</style>
