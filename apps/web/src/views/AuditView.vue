<script setup lang="ts">
import { message } from 'ant-design-vue'
import { DownloadOutlined } from '@ant-design/icons-vue'
import { computed, onMounted, reactive, ref } from 'vue'
import { api, getToken } from '../api/client'
import { AUDIT_ACTION_TEXT, type AuditLog } from '../api/types'

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

const actionLabel = (a: string) => AUDIT_ACTION_TEXT[a] ?? a

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
  } catch (e) { message.error((e as Error).message) }
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
  showTotal: (t: number) => `共 ${t} 条`,
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
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error ?? `导出失败 (${res.status})`)
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `操作日志-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    const rows = Number(res.headers.get('x-total-rows') ?? 0)
    if (rows >= 10000) message.warning('仅导出了最新的 10000 条，请缩小筛选范围')
  } catch (e) { message.error((e as Error).message) }
  finally { exporting.value = false }
}

onMounted(() => { void load(); void loadActions() })

const columns = [
  { title: '时间', key: 'at', width: 170 },
  { title: '操作人', key: 'user', width: 130 },
  { title: '操作', key: 'action', width: 170 },
  { title: '对象', key: 'target', ellipsis: true },
  { title: '结果', key: 'result', width: 110 },
  { title: 'IP', dataIndex: 'ip', key: 'ip', width: 130 },
]
</script>

<template>
  <a-card title="操作日志" size="small">
    <template #extra>
      <a-button :loading="exporting" @click="exportCsv"><DownloadOutlined /> 导出 CSV</a-button>
    </template>

    <a-form layout="inline" style="margin-bottom: 12px; row-gap: 8px" @submit.prevent="search">
      <a-form-item label="时间">
        <a-range-picker v-model:value="filters.range" show-time value-format="YYYY-MM-DDTHH:mm:ssZ" :placeholder="['开始时间', '结束时间']" />
      </a-form-item>
      <a-form-item label="操作人">
        <a-input v-model:value="filters.user" placeholder="用户名" allow-clear style="width: 140px" />
      </a-form-item>
      <a-form-item label="操作">
        <a-select v-model:value="filters.action" placeholder="全部" allow-clear show-search style="width: 200px" :filter-option="(input: string, opt: any) => `${opt.value} ${actionLabel(opt.value)}`.toLowerCase().includes(input.toLowerCase())">
          <a-select-option v-for="a in actions" :key="a" :value="a">{{ actionLabel(a) }}</a-select-option>
        </a-select>
      </a-form-item>
      <a-form-item label="结果">
        <a-select v-model:value="filters.ok" style="width: 100px">
          <a-select-option value="">全部</a-select-option>
          <a-select-option value="true">成功</a-select-option>
          <a-select-option value="false">失败</a-select-option>
        </a-select>
      </a-form-item>
      <a-form-item label="关键字">
        <a-input v-model:value="filters.q" placeholder="对象 / 路径 / 用户名" allow-clear style="width: 180px" @press-enter="search" />
      </a-form-item>
      <a-form-item>
        <a-space>
          <a-button type="primary" html-type="submit">查询</a-button>
          <a-button @click="reset">重置</a-button>
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
          <a-typography-text v-else type="secondary">{{ record.userId ? '系统' : '匿名' }}</a-typography-text>
        </template>
        <template v-else-if="column.key === 'action'">
          <a-tooltip :title="record.action">{{ actionLabel(record.action) }}</a-tooltip>
        </template>
        <template v-else-if="column.key === 'target'">
          <a-tooltip :title="`${record.method} ${record.path}`">{{ record.target || '—' }}</a-tooltip>
        </template>
        <template v-else-if="column.key === 'result'">
          <a-tag :color="record.ok ? 'success' : 'error'">{{ record.ok ? '成功' : '失败' }} {{ record.status }}</a-tag>
        </template>
      </template>
      <template #expandedRowRender="{ record }">
        <a-descriptions size="small" :column="1">
          <a-descriptions-item label="请求">{{ record.method }} {{ record.path }}</a-descriptions-item>
          <a-descriptions-item v-if="record.targetId" label="对象 ID">{{ record.targetId }}</a-descriptions-item>
          <a-descriptions-item label="详情">
            <pre v-if="record.detail" style="margin: 0; white-space: pre-wrap; word-break: break-all">{{ JSON.stringify(record.detail, null, 2) }}</pre>
            <span v-else>—</span>
          </a-descriptions-item>
        </a-descriptions>
      </template>
    </a-table>
  </a-card>
</template>
