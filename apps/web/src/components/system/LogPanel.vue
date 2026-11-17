<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { dateLocale } from '../../i18n'
import { fmtSize } from '../media/media'
import SearchBar from '../common/SearchBar.vue'
import { pagination } from '../common/ui'

/**
 * System logs (系统日志): the API's own log lines (requests included), redacted by the API. Recent lines
 * come from memory, older days from the daily files. Per-device logs stay in the device log drawer.
 */
type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
interface Entry { time: number; level: number; msg?: string; reqId?: string; req?: { method?: string; url?: string }; res?: { statusCode?: number }; [k: string]: unknown }
interface SystemSettings { logRetentionDays: number; historyRetentionDays: number }

const { t } = useI18n()
const LEVELS: [Level, number][] = [['trace', 10], ['debug', 20], ['info', 30], ['warn', 40], ['error', 50], ['fatal', 60]]
const levelName = (n: number) => [...LEVELS].reverse().find(([, v]) => n >= v)?.[0] ?? 'trace'
const LEVEL_COLOR: Record<Level, string> = { trace: 'default', debug: 'default', info: 'blue', warn: 'orange', error: 'red', fatal: 'red' }

const filters = reactive({ level: 'info' as Level, q: '', range: null as [string, string] | null, source: '' as string, limit: 200 })
const entries = ref<Entry[]>([])
const capacity = ref(0)
const files = ref<{ date: string; size: number }[]>([])
const loading = ref(false)
const retention = reactive({ logRetentionDays: 14, historyRetentionDays: 7 })
const saving = ref(false)

async function load() {
  loading.value = true
  const p = new URLSearchParams({ level: filters.level, limit: String(filters.limit) })
  if (filters.q.trim()) p.set('q', filters.q.trim())
  if (filters.range) { p.set('from', filters.range[0]); p.set('to', filters.range[1]) }
  if (filters.source) p.set('date', filters.source)
  try {
    const r = await api<{ entries: Entry[]; capacity: number }>('GET', `/api/system/logs?${p}`)
    entries.value = r.entries
    capacity.value = r.capacity
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
onMounted(async () => {
  void load()
  try {
    files.value = (await api<{ files: { date: string; size: number }[] }>('GET', '/api/system/logs/files')).files
    Object.assign(retention, (await api<{ settings: SystemSettings }>('GET', '/api/system/settings')).settings)
  } catch (e) { message.error(errorText(e)) }
})
function reset() { Object.assign(filters, { level: 'info', q: '', range: null, source: '', limit: 200 }); void load() }

async function saveRetention() {
  saving.value = true
  try {
    await api('PUT', '/api/system/settings', { logRetentionDays: retention.logRetentionDays, historyRetentionDays: retention.historyRetentionDays })
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}

const request = (e: Entry) => [e.req?.method, e.req?.url, e.res?.statusCode].filter((x) => x !== undefined).join(' ')
/** Everything but the columns already shown, for the expanded row. */
const extra = (e: Entry) => { const { time: _t, level: _l, msg: _m, pid: _p, hostname: _h, ...rest } = e; return JSON.stringify(rest, null, 2) }
const columns = computed(() => [
  { title: t('common.time'), key: 'time', width: 180 },
  { title: t('sysadmin.logs.levelCol'), key: 'level', width: 90 },
  { title: t('sysadmin.logs.message'), key: 'msg', ellipsis: true, width: 320 },
  { title: t('sysadmin.logs.request'), key: 'req', width: 320, ellipsis: true },
  { title: 'reqId', key: 'reqId', width: 100 },
])
</script>

<template>
  <div>
    <SearchBar :loading="loading" @search="load" @reset="reset">
      <a-select v-model:value="filters.source" style="width: 280px" :aria-label="t('sysadmin.logs.source')">
        <a-select-option value="">{{ t('sysadmin.logs.memory', { n: capacity || '…' }) }}</a-select-option>
        <a-select-option v-for="f in files" :key="f.date" :value="f.date">{{ t('sysadmin.logs.file', { date: f.date, size: fmtSize(f.size) }) }}</a-select-option>
      </a-select>
      <a-select v-model:value="filters.level" option-label-prop="label" style="width: 190px" :aria-label="t('sysadmin.logs.level')">
        <a-select-option
          v-for="[l] in LEVELS" :key="l" :value="l" :label="`${t('sysadmin.logs.level')}: ${t(`sysadmin.logs.levels.${l}`)}`"
        >{{ t(`sysadmin.logs.levels.${l}`) }}</a-select-option>
      </a-select>
      <a-range-picker v-model:value="filters.range" show-time value-format="YYYY-MM-DDTHH:mm:ssZ" />
      <a-input v-model:value="filters.q" :placeholder="t('sysadmin.logs.keywordPlaceholder')" allow-clear style="width: 200px" @press-enter="load" />
      <a-select v-model:value="filters.limit" option-label-prop="label" style="width: 120px" :aria-label="t('sysadmin.logs.limit')">
        <a-select-option v-for="n in [100, 200, 500, 1000, 2000]" :key="n" :value="n" :label="`${t('sysadmin.logs.limit')}: ${n}`">{{ n }}</a-select-option>
      </a-select>
    </SearchBar>

    <a-table
      :data-source="entries" :columns="columns" :row-key="(e: Entry) => `${e.time}-${e.reqId ?? ''}-${e.msg ?? ''}`" size="small" :loading="loading"
      :pagination="pagination({ defaultPageSize: 50, hideOnSinglePage: true })" :locale="{ emptyText: t('sysadmin.logs.empty') }" :scroll="{ x: 1010 }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'time'">{{ new Date(record.time).toLocaleString(dateLocale()) }}</template>
        <template v-else-if="column.key === 'level'">
          <a-tag :color="LEVEL_COLOR[levelName(record.level)]">{{ t(`sysadmin.logs.levels.${levelName(record.level)}`) }}</a-tag>
        </template>
        <template v-else-if="column.key === 'msg'">{{ record.msg ?? '' }}</template>
        <template v-else-if="column.key === 'req'"><span class="mono">{{ request(record as Entry) }}</span></template>
        <template v-else-if="column.key === 'reqId'"><span class="mono">{{ record.reqId ?? '' }}</span></template>
      </template>
      <template #expandedRowRender="{ record }"><pre class="json mono small">{{ extra(record as Entry) }}</pre></template>
    </a-table>

    <a-divider />
    <a-typography-title :level="5">{{ t('sysadmin.logs.retention') }}</a-typography-title>
    <a-form layout="inline" class="retention">
      <a-form-item :label="t('sysadmin.logs.logRetention')">
        <a-input-number v-model:value="retention.logRetentionDays" :min="1" :max="365" :precision="0" :addon-after="t('sysadmin.dayUnit')" style="width: 150px" />
      </a-form-item>
      <a-form-item :label="t('sysadmin.logs.historyRetention')">
        <a-input-number v-model:value="retention.historyRetentionDays" :min="1" :max="90" :precision="0" :addon-after="t('sysadmin.dayUnit')" style="width: 150px" />
      </a-form-item>
      <a-form-item><a-button type="primary" :loading="saving" @click="saveRetention">{{ t('common.save') }}</a-button></a-form-item>
    </a-form>
  </div>
</template>

<style scoped>
.retention { row-gap: 8px; }
.json { margin: 0; white-space: pre-wrap; word-break: break-all; max-height: 360px; overflow: auto; }
</style>
