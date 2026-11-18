<script setup lang="ts">
import { PlusOutlined, QuestionCircleOutlined } from '@ant-design/icons-vue'
import { dateLocale } from '../i18n'
import { message, Modal } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Rule } from 'ant-design-vue/es/form'
import { computed, h, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { deviceListLink, queryParam } from '../api/query'
import { api, codeText, errorText, type ErrorParams } from '../api/client'
import {
  PROXY_KINDS, proxyLabel, type PoolProxy, type ProxyCheck, type ProxyImportResult, type ProxyKind, type ProxyStatus, type ProxyType,
} from '../api/types'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import StatusTag from '../components/common/StatusTag.vue'
import BatchActions, { type BatchItem } from '../components/common/BatchActions.vue'
import { actionColumn, confirmDanger, MODAL_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'

const { t } = useI18n()
const router = useRouter()

const items = ref<PoolProxy[]>([])
const loading = ref(false)
const selectedKeys = ref<string[]>([])
const checkingIds = ref(new Set<string>())
const batchChecking = ref(false)

const route = useRoute()
// Active IP kind tab (静态 / 动态 / 移动); counts are totals per kind, independent of the other filters.
const kind = ref<ProxyKind>(queryParam(route.query, 'kind', PROXY_KINDS) ?? 'static')
const kindCounts = ref<Record<ProxyKind, number>>({ static: 0, mobile: 0 })
const kindOptions = computed(() => PROXY_KINDS.map((k) => ({ value: k, payload: { count: kindCounts.value[k] } })))
function switchKind() { selectedKeys.value = []; void load() }

const filters = reactive({
  q: '',
  status: queryParam<ProxyStatus>(route.query, 'status', ['unchecked', 'ok', 'failed']),
  bound: queryParam(route.query, 'bound', ['bound', 'free'] as const),
  country: '',
})

async function load() {
  loading.value = true
  try {
    const p = new URLSearchParams({ kind: kind.value })
    if (filters.q.trim()) p.set('q', filters.q.trim())
    if (filters.status) p.set('status', filters.status)
    if (filters.bound) p.set('bound', filters.bound)
    if (filters.country.trim()) p.set('country', filters.country.trim())
    const r = await api<{ proxies: PoolProxy[]; kindCounts: Record<ProxyKind, number> }>('GET', `/api/proxies?${p}`)
    items.value = r.proxies
    kindCounts.value = r.kindCounts
    const ids = new Set(items.value.map((x) => x.id))
    selectedKeys.value = selectedKeys.value.filter((k) => ids.has(k))
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
onMounted(load)
const hasFilters = computed(() => Boolean(filters.q.trim() || filters.status || filters.bound || filters.country.trim()))
function reset() { Object.assign(filters, { q: '', status: undefined, bound: undefined, country: '' }); void load() }

const summary = computed(() => ({
  total: items.value.length,
  free: items.value.filter((p) => !p.boundInstance).length,
  ok: items.value.filter((p) => p.status === 'ok').length,
  failed: items.value.filter((p) => p.status === 'failed').length,
}))

const columns = computed(() => [
  { title: t('proxies.colLabel'), key: 'label', width: 170 },
  { title: t('proxies.colType'), key: 'type', width: 90 },
  { title: t('proxies.colEndpoint'), key: 'endpoint', width: 220 },
  { title: t('proxies.colLocation'), key: 'location', width: 150 },
  { title: t('proxies.colProvider'), key: 'provider', width: 120 },
  { title: t('proxies.colStatus'), key: 'status', width: 230 },
  { title: t('proxies.colDevice'), key: 'device', width: 140 },
  actionColumn(220),
])
const statusText = (s: ProxyStatus) => t(`proxies.statusText.${s}`)
const location = (p: PoolProxy) => [p.country, p.region, p.city].filter(Boolean).join(' · ') || '—'
const replace = (row: PoolProxy) => { items.value = items.value.map((x) => (x.id === row.id ? row : x)) }

// ---- checks (from the API host through the proxy)
async function checkOne(p: PoolProxy) {
  checkingIds.value.add(p.id)
  try {
    const r = await api<{ proxy: PoolProxy }>('POST', `/api/proxies/${p.id}/check`)
    replace(r.proxy)
    if (r.proxy.status === 'ok') message.success(t('proxies.checkDone', { ok: 1, failed: 0 }))
    else message.warning(r.proxy.lastCheck?.error ?? statusText('failed'))
  } catch (e) { message.error(errorText(e)) }
  finally { checkingIds.value.delete(p.id) }
}
/** Checks the selected rows (批量栏) or, without `selectedOnly`, every row of the current list. */
async function checkBatch(selectedOnly = false) {
  const ids = selectedOnly ? [...selectedKeys.value] : items.value.map((p) => p.id)
  if (!ids.length) return
  batchChecking.value = true
  ids.forEach((id) => checkingIds.value.add(id))
  try {
    const r = await api<{ proxies: PoolProxy[]; ok: number; failed: number }>('POST', '/api/proxies/check', { ids })
    r.proxies.forEach(replace)
    message.info(t('proxies.checkDone', { ok: r.ok, failed: r.failed }))
  } catch (e) { message.error(errorText(e)) }
  finally {
    ids.forEach((id) => checkingIds.value.delete(id))
    batchChecking.value = false
  }
}

// ---- add / edit (password write-only)
const editOpen = ref(false)
const saving = ref(false)
const editing = ref<PoolProxy | null>(null)
const formRef = ref<FormInstance>()
const blank = () => ({
  label: '', type: 'socks5' as ProxyType, kind: kind.value as ProxyKind, host: '', port: 1080 as number | undefined, username: '', password: '', clearPassword: false,
  country: '', region: '', city: '', provider: '', notes: '',
})
const form = reactive(blank())
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/
const rules = computed<Record<string, Rule[]>>(() => ({
  host: [{ required: true, message: t('proxies.required') }, { pattern: HOST_RE, message: t('proxies.hostInvalid') }],
  port: [{ required: true, message: t('proxies.required') }, { type: 'integer', min: 1, max: 65535, message: t('proxies.portInvalid') }],
}))
function openAdd() { editing.value = null; Object.assign(form, blank()); testResult.value = null; formRef.value?.clearValidate(); editOpen.value = true }
function openEdit(p: PoolProxy) {
  editing.value = p
  Object.assign(form, {
    ...blank(), label: p.label ?? '', type: p.type, kind: p.kind, host: p.host, port: p.port, username: p.username ?? '',
    country: p.country ?? '', region: p.region ?? '', city: p.city ?? '', provider: p.provider ?? '', notes: p.notes ?? '',
  })
  testResult.value = null
  formRef.value?.clearValidate()
  editOpen.value = true
}

// ---- 网络检测: probe the values in the form before saving (nothing stored; with `id`, an empty password uses the stored one)
const testing = ref(false)
const testResult = ref<ProxyCheck | null>(null)
async function testForm() {
  try { await formRef.value?.validateFields(['host', 'port']) } catch { return }
  testing.value = true
  testResult.value = null
  try {
    const body: Record<string, unknown> = {
      type: form.type, host: form.host.trim(), port: form.port, username: form.username.trim() || null, password: form.password || null,
    }
    if (editing.value && !form.clearPassword) body.id = editing.value.id
    testResult.value = (await api<{ result: ProxyCheck }>('POST', '/api/proxies/test', body)).result
  } catch (e) { message.error(errorText(e)) }
  finally { testing.value = false }
}
async function save() {
  try { await formRef.value?.validate() } catch { return }
  saving.value = true
  const body: Record<string, unknown> = {
    label: form.label, type: form.type, kind: form.kind, host: form.host.trim(), port: form.port, username: form.username.trim() || null,
    country: form.country, region: form.region, city: form.city, provider: form.provider, notes: form.notes,
  }
  // Write-only: omitted keeps the stored password, null removes it.
  if (form.password) body.password = form.password
  else if (editing.value && form.clearPassword) body.password = null
  try {
    if (editing.value) {
      const r = await api<{ proxy: PoolProxy; taskId: string | null }>('PUT', `/api/proxies/${editing.value.id}`, body)
      replace(r.proxy)
      message.success(r.taskId ? t('proxies.reapplied') : t('common.saved'))
      if (r.proxy.kind !== kind.value) void load()
    } else {
      await api('POST', '/api/proxies', body)
      message.success(t('common.created'))
      if (form.kind !== kind.value) kind.value = form.kind
      void load()
    }
    form.password = ''
    editOpen.value = false
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}

function remove(p: PoolProxy) {
  if (p.boundInstance) { message.warning(t('proxies.boundNoDelete', { name: p.boundInstance.name })); return }
  confirmDanger({
    title: t('proxies.confirmDelete', { name: proxyLabel(p) }),
    onOk: async () => {
      try {
        await api('DELETE', `/api/proxies/${p.id}`)
        items.value = items.value.filter((x) => x.id !== p.id)
        message.success(t('common.deleted'))
      } catch (e) { message.error(errorText(e)) }
    },
  })
}

// ---- batch (批量操作, POST /api/proxies/batch): delete skips proxies bound to a device; set-kind moves rows to another tab
interface BatchResult { ok: string[]; skipped: { id: string; code: string; params?: ErrorParams }[]; changed: number }
const batchBusy = ref(false)
function batch(action: 'delete' | 'set-kind', toKind?: ProxyKind) {
  const ids = [...selectedKeys.value]
  if (!ids.length) return
  // Name/address only, never credentials.
  const names = new Map(items.value.map((p) => [p.id, p.label ? `${p.label} (${p.host}:${p.port})` : `${p.host}:${p.port}`]))
  const run = async () => {
    batchBusy.value = true
    try {
      const body: Record<string, unknown> = { ids, action }
      if (action === 'set-kind') body.kind = toKind
      const r = await api<BatchResult>('POST', '/api/proxies/batch', body)
      const done = action === 'delete' ? t('proxies.batch.doneDelete', { n: r.ok.length }) : t('proxies.batch.doneKind', { n: r.changed })
      if (r.skipped.length) {
        Modal.warning({
          title: t('proxies.batch.skippedTitle', { ok: r.ok.length, skipped: r.skipped.length }),
          content: h('div', [
            h('p', done),
            h('ul', { style: 'padding-inline-start: 18px; margin: 0; max-height: 240px; overflow: auto' },
              r.skipped.map((x) => h('li', `${names.get(x.id) ?? x.id}: ${codeText(x.code, x.params, x.code)}`))),
          ]),
        })
      } else message.success(done)
      selectedKeys.value = []
      void load()
    } catch (e) { message.error(errorText(e)) }
    finally { batchBusy.value = false }
  }
  if (action === 'delete') {
    const bound = items.value.filter((p) => ids.includes(p.id) && p.boundInstance).length
    confirmDanger({ title: t('proxies.batch.confirmDelete', { n: ids.length }), content: t('proxies.batch.deleteHint', { bound }), onOk: run })
  } else void run()
}
/** 批量操作 menu: check, move to the other kind tab (the current kind is disabled: rows are already that kind), delete. */
const batchItems = computed<BatchItem[]>(() => [
  { key: 'check', label: t('proxies.check'), disabled: batchChecking.value || batchBusy.value },
  ...PROXY_KINDS.map((k) => ({ key: `kind:${k}`, label: t('proxies.batch.toKind', { kind: t(`proxies.kinds.${k}`) }), disabled: k === kind.value || batchBusy.value })),
  { key: 'delete', label: t('common.delete'), danger: true, disabled: batchBusy.value },
])
function onBatch(key: string) {
  if (key === 'check') void checkBatch(true)
  else if (key === 'delete') batch('delete')
  else if (key.startsWith('kind:')) batch('set-kind', key.slice(5) as ProxyKind)
}

// ---- bulk import (preview = dry run, then import)
const importOpen = ref(false)
const importing = ref(false)
const imp = reactive({ text: '', defaultType: 'socks5' as ProxyType, kind: 'static' as ProxyKind, provider: '', country: '' })
const preview = ref<ProxyImportResult | null>(null)
const IMPORT_FORMATS = ['socks5://user:pass@host:port', 'http://user:pass@host:port', 'http://host:port', 'host:port:user:pass', 'host:port']
function openImport() { Object.assign(imp, { text: '', defaultType: 'socks5', kind: kind.value, provider: '', country: '' }); preview.value = null; importOpen.value = true }
async function runImport(dryRun: boolean) {
  if (!imp.text.trim()) return
  importing.value = true
  try {
    const r = await api<ProxyImportResult>('POST', '/api/proxies/import', {
      text: imp.text, defaultType: imp.defaultType, kind: imp.kind, dryRun, provider: imp.provider || undefined, country: imp.country || undefined,
    })
    preview.value = r
    if (!dryRun) {
      message.success(t('proxies.importDone', { created: r.created, duplicate: r.duplicate, invalid: r.invalid }))
      kind.value = imp.kind
      void load()
    }
  } catch (e) { message.error(errorText(e)) }
  finally { importing.value = false }
}
const IMPORT_COLOR = { created: 'green', duplicate: 'orange', invalid: 'red' } as const
const importColumns = computed(() => [
  { title: t('proxies.line'), dataIndex: 'line', key: 'line', width: 64 },
  { title: t('proxies.input'), dataIndex: 'input', key: 'input' },
  { title: t('proxies.result'), key: 'status', width: 220 },
])

// ---- usage
interface Usage {
  boundInstance: { id: string; name: string; status: string } | null
  history: { at: string; username: string | null; ok: boolean; device: string | null; deviceId: string | null; event: 'bind' | 'unbind' | 'create' }[]
}
const usageOpen = ref(false)
const usageFor = ref<PoolProxy | null>(null)
const usage = ref<Usage | null>(null)
async function openUsage(p: PoolProxy) {
  usageFor.value = p; usage.value = null; usageOpen.value = true
  try { usage.value = await api<Usage>('GET', `/api/proxies/${p.id}/usage`) } catch (e) { message.error(errorText(e)) }
}
</script>

<template>
  <PageContainer :title="t('proxies.title')">
    <template #title-suffix>
      <a-popover trigger="click" placement="bottomLeft" :overlay-style="{ maxWidth: '440px' }">
        <template #title>{{ t('proxies.guideTitle') }}</template>
        <template #content>
          <div class="guide">
            <p v-for="k in PROXY_KINDS" :key="k"><b>{{ t(`proxies.kinds.${k}`) }}</b>：{{ t(`proxies.kindDesc.${k}`) }}</p>
            <p><b>{{ t('proxies.guideBindTitle') }}</b>：{{ t('proxies.guideBind') }}</p>
            <p class="muted">{{ t('proxies.checkHint') }}</p>
          </div>
        </template>
        <a-button size="small" type="text" class="guide-btn"><template #icon><QuestionCircleOutlined /></template>{{ t('proxies.guide') }}</a-button>
      </a-popover>
    </template>
    <template #extra>
      <a-button @click="openImport">{{ t('proxies.import') }}</a-button>
      <a-button type="primary" @click="openAdd"><template #icon><PlusOutlined /></template>{{ t('proxies.add') }}</a-button>
    </template>

    <a-segmented v-model:value="kind" :options="kindOptions" class="kind-tabs" @change="switchKind">
      <template #label="{ value, payload }">
        <span class="kind-label">{{ t(`proxies.kinds.${value}`) }}<span class="kind-count">{{ payload?.count ?? 0 }}</span></span>
      </template>
    </a-segmented>

    <a-card :bordered="false">
      <SearchBar :loading="loading" @reset="reset" @refresh="load">
        <a-input-search v-model:value="filters.q" :placeholder="t('proxies.searchPlaceholder')" allow-clear style="width: 280px" @search="load" />
        <a-select v-model:value="filters.status" :placeholder="t('proxies.filterStatus')" allow-clear style="width: 130px" @change="load">
          <a-select-option v-for="st in (['ok', 'failed', 'unchecked'] as const)" :key="st" :value="st">{{ statusText(st) }}</a-select-option>
        </a-select>
        <a-select v-model:value="filters.bound" :placeholder="t('proxies.filterBound')" allow-clear style="width: 120px" @change="load">
          <a-select-option value="free">{{ t('proxies.free') }}</a-select-option>
          <a-select-option value="bound">{{ t('proxies.bound') }}</a-select-option>
        </a-select>
        <a-input v-model:value="filters.country" :placeholder="t('proxies.filterCountry')" allow-clear style="width: 120px" @press-enter="load" />
        <template #actions>
          <span class="muted small">{{ t('proxies.summary', summary) }}</span>
          <a-tooltip :title="t('proxies.checkAllHint')">
            <a-button :loading="batchChecking && !selectedKeys.length" :disabled="!items.length || batchChecking" @click="checkBatch()">
              {{ t('proxies.checkAll') }}
            </a-button>
          </a-tooltip>
          <BatchActions :count="selectedKeys.length" :items="batchItems" :loading="(batchChecking && !!selectedKeys.length) || batchBusy"
            @select="onBatch" @clear="selectedKeys = []" />
        </template>
      </SearchBar>

      <a-table
        :data-source="items" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :scroll="{ x: 1340 }"
        :pagination="pagination({ defaultPageSize: 50 })"
        :row-selection="{ selectedRowKeys: selectedKeys, onChange: (k: any[]) => (selectedKeys = k as string[]) }"
      >
        <template #emptyText>
          <a-empty :description="hasFilters ? t('proxies.emptyFiltered') : t('proxies.empty', { kind: t(`proxies.kinds.${kind}`) })">
            <a-button v-if="!hasFilters" type="primary" @click="openAdd"><template #icon><PlusOutlined /></template>{{ t('proxies.add') }}</a-button>
            <a-button v-else @click="reset">{{ t('common.reset') }}</a-button>
          </a-empty>
        </template>
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'label'">
            <a-typography-text :ellipsis="{ tooltip: record.notes || undefined }" :content="record.label || '—'" />
          </template>
          <template v-else-if="column.key === 'type'"><a-tag>{{ record.type.toUpperCase() }}</a-tag></template>
          <template v-else-if="column.key === 'endpoint'">
            <span class="mono">{{ record.host }}:{{ record.port }}</span>
            <div v-if="record.username" class="muted small">{{ record.username }}{{ record.hasPassword ? ' · ******' : '' }}</div>
          </template>
          <template v-else-if="column.key === 'location'">{{ location(record as PoolProxy) }}</template>
          <template v-else-if="column.key === 'provider'">{{ record.provider || '—' }}</template>
          <template v-else-if="column.key === 'status'">
            <a-space :size="4" wrap>
              <a-tooltip :title="record.lastCheck?.error || undefined">
                <StatusTag kind="proxy" :status="record.status" />
              </a-tooltip>
              <span v-if="record.lastCheck?.egressIp" class="mono small">{{ record.lastCheck.egressIp }}</span>
              <span v-if="record.lastCheck?.latencyMs != null" class="muted small">{{ record.lastCheck.latencyMs }} ms</span>
            </a-space>
            <div v-if="record.lastCheck" class="faint small">{{ t('proxies.checkedAt', { time: new Date(record.lastCheck.at).toLocaleString(dateLocale()) }) }}</div>
          </template>
          <template v-else-if="column.key === 'device'">
            <a v-if="record.boundInstance" @click="router.push(deviceListLink(record.boundInstance.id))">{{ record.boundInstance.name }}</a>
            <a-tag v-else color="green">{{ t('proxies.free') }}</a-tag>
          </template>
          <template v-else-if="column.key === 'ops'">
            <a-space :size="0">
              <a-button size="small" type="link" :loading="checkingIds.has(record.id)" @click="checkOne(record as PoolProxy)">{{ t('proxies.check') }}</a-button>
              <a-button size="small" type="link" @click="openEdit(record as PoolProxy)">{{ t('common.edit') }}</a-button>
              <a-button size="small" type="link" @click="openUsage(record as PoolProxy)">{{ t('proxies.usage') }}</a-button>
              <a-tooltip :title="record.boundInstance ? t('proxies.boundNoDelete', { name: record.boundInstance.name }) : undefined">
                <a-button size="small" type="link" danger :disabled="!!record.boundInstance" @click="remove(record as PoolProxy)">{{ t('common.delete') }}</a-button>
              </a-tooltip>
            </a-space>
          </template>
        </template>
      </a-table>
      <div class="faint small">{{ t('proxies.checkHint') }}</div>
    </a-card>
  </PageContainer>

  <a-modal v-model:open="editOpen" :title="editing ? t('proxies.edit') : t('proxies.add')" :width="MODAL_WIDTH.md">
    <a-form ref="formRef" :model="form" :rules="rules" layout="vertical" class="proxy-form">
      <a-row :gutter="12">
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('proxies.type')" name="type" required>
            <a-select v-model:value="form.type" :options="[{ value: 'socks5', label: 'SOCKS5' }, { value: 'http', label: 'HTTP' }]" @change="testResult = null" />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('proxies.kind')" name="kind">
            <a-select v-model:value="form.kind" :options="PROXY_KINDS.map((k) => ({ value: k, label: t(`proxies.kinds.${k}`) }))" />
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item :label="t('proxies.label')" name="label">
        <a-input v-model:value="form.label" :maxlength="80" :placeholder="t('proxies.labelPlaceholder')" />
      </a-form-item>
      <a-row :gutter="12">
        <a-col :xs="24" :sm="16">
          <a-form-item :label="t('proxies.host')" name="host"><a-input v-model:value="form.host" :placeholder="t('proxies.hostPlaceholder')" @change="testResult = null" /></a-form-item>
        </a-col>
        <a-col :xs="24" :sm="8">
          <a-form-item :label="t('proxies.port')" name="port"><a-input-number v-model:value="form.port" :min="1" :max="65535" :precision="0" style="width: 100%" @change="testResult = null" /></a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('proxies.username')" name="username"><a-input v-model:value="form.username" autocomplete="off" :maxlength="200" @change="testResult = null" /></a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('proxies.password')" name="password" :extra="editing?.hasPassword ? t('proxies.passwordKeep') : t('proxies.passwordHint')">
            <a-input-password v-model:value="form.password" autocomplete="new-password" :maxlength="200" :disabled="form.clearPassword" @change="testResult = null" />
            <a-checkbox v-if="editing?.hasPassword" v-model:checked="form.clearPassword" style="margin-top: 4px" @change="testResult = null">{{ t('proxies.clearPassword') }}</a-checkbox>
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item :label="t('proxies.notes')"><a-textarea v-model:value="form.notes" :maxlength="500" :auto-size="{ minRows: 2, maxRows: 4 }" /></a-form-item>
      <a-collapse ghost size="small" class="more">
        <a-collapse-panel key="more" :header="t('proxies.moreInfo')">
          <a-row :gutter="12">
            <a-col :xs="12" :sm="6"><a-form-item :label="t('proxies.country')"><a-input v-model:value="form.country" :maxlength="64" :placeholder="t('proxies.countryPlaceholder')" /></a-form-item></a-col>
            <a-col :xs="12" :sm="6"><a-form-item :label="t('proxies.region')"><a-input v-model:value="form.region" :maxlength="80" /></a-form-item></a-col>
            <a-col :xs="12" :sm="6"><a-form-item :label="t('proxies.city')"><a-input v-model:value="form.city" :maxlength="80" /></a-form-item></a-col>
            <a-col :xs="12" :sm="6"><a-form-item :label="t('proxies.provider')"><a-input v-model:value="form.provider" :maxlength="80" /></a-form-item></a-col>
          </a-row>
        </a-collapse-panel>
      </a-collapse>
      <a-alert v-if="testResult" :type="testResult.ok ? 'success' : 'error'" show-icon class="test-result">
        <template #message>{{ testResult.ok ? t('proxies.testOk') : t('proxies.testFailed') }}</template>
        <template #description>
          <div v-if="testResult.ok" class="small">
            {{ t('proxies.egressIp') }}：<span class="mono">{{ testResult.egressIp }}</span>
            · {{ t('proxies.location') }}：{{ [testResult.country, testResult.city].filter(Boolean).join(' · ') || '—' }}
            · {{ t('proxies.latency') }}：{{ testResult.latencyMs }} ms
          </div>
          <div v-else class="small mono">{{ testResult.error }}</div>
        </template>
      </a-alert>
    </a-form>
    <template #footer>
      <div class="modal-foot">
        <a-tooltip :title="t('proxies.testHint')">
          <a-button type="link" class="test-btn" :loading="testing" @click="testForm">{{ t('proxies.test') }}</a-button>
        </a-tooltip>
        <a-space>
          <a-button @click="editOpen = false">{{ t('common.cancel') }}</a-button>
          <a-button type="primary" :loading="saving" @click="save">{{ t('common.ok') }}</a-button>
        </a-space>
      </div>
    </template>
  </a-modal>

  <a-modal v-model:open="importOpen" :title="t('proxies.importTitle')" :width="MODAL_WIDTH.lg" :footer="null">
    <div class="muted small">{{ t('proxies.importFormats') }}</div>
    <ul class="formats mono small"><li v-for="f in IMPORT_FORMATS" :key="f">{{ f }}</li></ul>
    <a-textarea v-model:value="imp.text" :auto-size="{ minRows: 6, maxRows: 14 }" class="mono" spellcheck="false" autocomplete="off" @change="preview = null" />
    <a-row :gutter="12" style="margin-top: 12px">
      <a-col :xs="24" :sm="6">
        <div class="small muted">{{ t('proxies.kind') }}</div>
        <a-select v-model:value="imp.kind" size="small" style="width: 100%" :options="PROXY_KINDS.map((k) => ({ value: k, label: t(`proxies.kinds.${k}`) }))" />
      </a-col>
      <a-col :xs="24" :sm="6">
        <div class="small muted">{{ t('proxies.defaultType') }}</div>
        <a-radio-group v-model:value="imp.defaultType" size="small" @change="preview = null">
          <a-radio-button value="socks5">SOCKS5</a-radio-button>
          <a-radio-button value="http">HTTP</a-radio-button>
        </a-radio-group>
      </a-col>
      <a-col :xs="24" :sm="6">
        <div class="small muted">{{ t('proxies.importProvider') }}</div>
        <a-input v-model:value="imp.provider" size="small" :maxlength="80" />
      </a-col>
      <a-col :xs="24" :sm="6">
        <div class="small muted">{{ t('proxies.importCountry') }}</div>
        <a-input v-model:value="imp.country" size="small" :maxlength="64" :placeholder="t('proxies.countryPlaceholder')" />
      </a-col>
    </a-row>
    <a-space style="margin-top: 12px">
      <a-button :loading="importing" :disabled="!imp.text.trim()" @click="runImport(true)">{{ t('proxies.preview') }}</a-button>
      <a-button type="primary" :loading="importing" :disabled="!imp.text.trim() || (!!preview && !preview.dryRun)" @click="runImport(false)">{{ t('proxies.importNow') }}</a-button>
      <span v-if="preview" class="muted">
        {{ preview.dryRun ? t('proxies.previewSummary', preview) : t('proxies.importDone', preview) }}
      </span>
    </a-space>
    <a-table
      v-if="preview" :data-source="preview.results" :columns="importColumns" row-key="line" size="small" style="margin-top: 12px"
      :pagination="pagination({ size: 'small', hideOnSinglePage: true })"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'input'"><span class="mono small">{{ record.input }}</span></template>
        <template v-else-if="column.key === 'status'">
          <a-tag :color="IMPORT_COLOR[record.status as keyof typeof IMPORT_COLOR]">{{ t(`proxies.lineStatus.${record.status}`) }}</a-tag>
          <span v-if="record.error" class="muted small">{{ record.error }}</span>
        </template>
      </template>
    </a-table>
  </a-modal>

  <a-modal v-model:open="usageOpen" :title="usageFor ? `${t('proxies.usage')} · ${proxyLabel(usageFor)}` : ''" :footer="null" :width="MODAL_WIDTH.md">
    <a-spin :spinning="!usage">
      <template v-if="usage">
        <p>
          <span class="muted">{{ t('proxies.usageCurrent') }}：</span>
          <a v-if="usage.boundInstance" @click="usageOpen = false; router.push(deviceListLink(usage.boundInstance.id))">{{ usage.boundInstance.name }}</a>
          <a-tag v-else color="green">{{ t('proxies.free') }}</a-tag>
        </p>
        <a-timeline v-if="usage.history.length">
          <a-timeline-item v-for="(h, i) in usage.history" :key="i" :color="h.ok ? (h.event === 'unbind' ? 'gray' : 'green') : 'red'">
            {{ new Date(h.at).toLocaleString(dateLocale()) }} · {{ t(`proxies.usageEvents.${h.event}`) }} · {{ h.device ?? '—' }}
            <span class="muted">· {{ h.username ?? t('common.system') }}</span>
            <a-tag v-if="!h.ok" color="red">{{ t('common.failed') }}</a-tag>
          </a-timeline-item>
        </a-timeline>
        <a-empty v-else :description="t('proxies.noHistory')" />
      </template>
    </a-spin>
  </a-modal>
</template>

<style scoped>
.formats { margin: 4px 0 8px; padding-left: 18px; color: var(--cp-text-secondary); }
.guide-btn { color: var(--cp-text-secondary); }
.guide p { margin: 0 0 8px; }
.guide p:last-child { margin-bottom: 0; }
.kind-tabs { align-self: flex-start; max-width: 100%; overflow-x: auto; }
.kind-label { display: inline-flex; align-items: center; gap: 6px; padding: 0 4px; }
.kind-count { min-width: 20px; padding: 0 6px; border-radius: 10px; font-size: 12px; line-height: 18px; text-align: center; background: var(--cp-fill-alter); color: var(--cp-text-secondary); }
.more { margin: -8px 0 8px; }
.more :deep(.ant-collapse-header) { padding-left: 0 !important; color: var(--cp-text-secondary); }
.more :deep(.ant-collapse-content-box) { padding: 0 !important; }
.test-result { margin-top: 4px; }
.modal-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.test-btn { padding-left: 0; }
</style>
