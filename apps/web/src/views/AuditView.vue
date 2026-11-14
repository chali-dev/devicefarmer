<script setup lang="ts">
import { message } from 'ant-design-vue'
import { DownloadOutlined } from '@ant-design/icons-vue'
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText, getToken, responseError } from '../api/client'
import { auditActionText, type AuditLog } from '../api/types'

const { t } = useI18n()
const items = ref<AuditLog[]>([])
const total = ref(0)
const loading = ref(false)
const exporting = ref(false)
const actions = ref<string[]>([])

const filters = reactive({
  range: null as [string, string] | null,
  user: '',
  action: undefined as string | undefined,
  ok: '' as '' | 'true' | 'false',
  q: '',
})
const page = ref(1)
const pageSize = ref(50)

const actionLabel = (a: string) => auditActionText(a)

function query(extra: Record<string, string> = {}): string {
  const p = new URLSearchParams()
  if (filters.range) { p.set('from', filters.range[0]); p.set('to', filters.range[1]) }
  if (filters.user.trim()) p.set('user', filters.user.trim())
  if (filters.action) p.set('action', filters.action)
  if (filters.ok) p.set('ok', filters.ok)
  if (filters.q.trim()) p.set('q', filters.q.trim())
  for (const [k, v] of Object.entries(extra)) p.set(k, v)
  return p.toString()
}

async function load() {
  loading.value = true
  try {
    const r = await api<{ items: AuditLog[]; total: number }>('GET', `/api/audit?${query({ page: String(page.value), pageSize: String(pageSize.value) })}`)
    items.value = r.items
    total.value = r.total
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}

async function loadActions() {
  try { actions.value = (await api<{ actions: string[] }>('GET', '/api/audit/actions')).actions }
  catch { /* the filter still works by typing nothing */ }
}

function search() { page.value = 1; void load() }
function reset() {
  Object.assign(filters, { range: null, user: '', action: undefined, ok: '', q: '' })
  search()
}

const pagination = computed(() => ({
  current: page.value, pageSize: pageSize.value, total: total.value,
  showSizeChanger: true, pageSizeOptions: ['20', '50', '100', '200'],
  showTotal: (n: number) => t('audit.total', { n }),
}))
function onTableChange(p: { current?: number; pageSize?: number }) {
  if (p.pageSize && p.pageSize !== pageSize.value) { pageSize.value = p.pageSize; page.value = 1 }
  else if (p.current) page.value = p.current
  void load()
}

/** The token can't go in a URL, so download through fetch + blob. */
async function exportCsv() {
  exporting.value = true
  try {
    const token = getToken()
    const res = await fetch(`/api/audit/export.csv?${query()}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
    if (!res.ok) throw await responseError(res, 'audit.exportFailed')
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${t('audit.exportFile')}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    const rows = Number(res.headers.get('x-total-rows') ?? 0)
    if (rows >= 10000) message.warning(t('audit.exportLimited'))
  } catch (e) { message.error(errorText(e)) }
  finally { exporting.value = false }
}

onMounted(() => { void load(); void loadActions() })

const columns = computed(() => [
  { title: t('common.time'), key: 'at', width: 170 },
  { title: t('common.operator'), key: 'user', width: 130 },
  { title: t('common.action'), key: 'action', width: 170 },
  { title: t('audit.target'), key: 'target', ellipsis: true },
  { title: t('audit.result'), key: 'result', width: 110 },
  { title: 'IP', dataIndex: 'ip', key: 'ip', width: 130 },
])
</script>

<template>
  <a-card :title="t('audit.title')" size="small">
    <template #extra>
      <a-button :loading="exporting" @click="exportCsv"><DownloadOutlined /> {{ t('audit.exportCsv') }}</a-button>
    </template>

    <a-form layout="inline" style="margin-bottom: 12px; row-gap: 8px" @submit.prevent="search">
      <a-form-item :label="t('common.time')">
        <a-range-picker v-model:value="filters.range" show-time value-format="YYYY-MM-DDTHH:mm:ssZ" :placeholder="[t('audit.start'), t('audit.end')]" />
      </a-form-item>
      <a-form-item :label="t('common.operator')">
        <a-input v-model:value="filters.user" :placeholder="t('common.username')" allow-clear style="width: 140px" />
      </a-form-item>
      <a-form-item :label="t('common.action')">
        <a-select v-model:value="filters.action" :placeholder="t('common.all')" allow-clear show-search style="width: 200px" :filter-option="(input: string, opt: any) => `${opt.value} ${actionLabel(opt.value)}`.toLowerCase().includes(input.toLowerCase())">
          <a-select-option v-for="a in actions" :key="a" :value="a">{{ actionLabel(a) }}</a-select-option>
        </a-select>
      </a-form-item>
      <a-form-item :label="t('audit.result')">
        <a-select v-model:value="filters.ok" style="width: 100px">
          <a-select-option value="">{{ t('common.all') }}</a-select-option>
          <a-select-option value="true">{{ t('common.success') }}</a-select-option>
          <a-select-option value="false">{{ t('common.failed') }}</a-select-option>
        </a-select>
      </a-form-item>
      <a-form-item :label="t('audit.keyword')">
        <a-input v-model:value="filters.q" :placeholder="t('audit.keywordPlaceholder')" allow-clear style="width: 180px" @press-enter="search" />
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
      :pagination="pagination" :scroll="{ x: 900 }" @change="onTableChange"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'at'">{{ new Date(record.at).toLocaleString() }}</template>
        <template v-else-if="column.key === 'user'">
          <span v-if="record.username">{{ record.username }}</span>
          <a-typography-text v-else type="secondary">{{ record.userId ? t('common.system') : t('audit.anonymous') }}</a-typography-text>
        </template>
        <template v-else-if="column.key === 'action'">
          <a-tooltip :title="record.action">{{ actionLabel(record.action) }}</a-tooltip>
        </template>
        <template v-else-if="column.key === 'target'">
          <a-tooltip :title="`${record.method} ${record.path}`">{{ record.target || '—' }}</a-tooltip>
        </template>
        <template v-else-if="column.key === 'result'">
          <a-tag :color="record.ok ? 'success' : 'error'">{{ record.ok ? t('common.success') : t('common.failed') }} {{ record.status }}</a-tag>
        </template>
      </template>
      <template #expandedRowRender="{ record }">
        <a-descriptions size="small" :column="1">
          <a-descriptions-item :label="t('audit.request')">{{ record.method }} {{ record.path }}</a-descriptions-item>
          <a-descriptions-item v-if="record.targetId" :label="t('audit.targetId')">{{ record.targetId }}</a-descriptions-item>
          <a-descriptions-item :label="t('audit.detail')">
            <pre v-if="record.detail" style="margin: 0; white-space: pre-wrap; word-break: break-all">{{ JSON.stringify(record.detail, null, 2) }}</pre>
            <span v-else>—</span>
          </a-descriptions-item>
        </a-descriptions>
      </template>
    </a-table>
  </a-card>
</template>
