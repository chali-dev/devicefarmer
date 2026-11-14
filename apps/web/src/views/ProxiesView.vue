<script setup lang="ts">
import { message, Modal } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Rule } from 'ant-design-vue/es/form'
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { api, errorText } from '../api/client'
import {
  PROXY_STATUS_COLOR, proxyLabel, type PoolProxy, type ProxyImportResult, type ProxyStatus, type ProxyType,
} from '../api/types'

const { t } = useI18n()
const router = useRouter()

const items = ref<PoolProxy[]>([])
const loading = ref(false)
const selectedKeys = ref<string[]>([])
const checkingIds = ref(new Set<string>())
const batchChecking = ref(false)

const filters = reactive({
  q: '',
  status: undefined as ProxyStatus | undefined,
  bound: undefined as 'bound' | 'free' | undefined,
  country: '',
})

async function load() {
  loading.value = true
  try {
    const p = new URLSearchParams()
    if (filters.q.trim()) p.set('q', filters.q.trim())
    if (filters.status) p.set('status', filters.status)
    if (filters.bound) p.set('bound', filters.bound)
    if (filters.country.trim()) p.set('country', filters.country.trim())
    items.value = (await api<{ proxies: PoolProxy[] }>('GET', `/api/proxies?${p}`)).proxies
    const ids = new Set(items.value.map((x) => x.id))
    selectedKeys.value = selectedKeys.value.filter((k) => ids.has(k))
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
onMounted(load)
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
  { title: '', key: 'ops', width: 190, align: 'right' as const },
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
async function checkBatch() {
  const ids = selectedKeys.value.length ? [...selectedKeys.value] : items.value.map((p) => p.id)
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
  label: '', type: 'socks5' as ProxyType, host: '', port: 1080 as number | undefined, username: '', password: '', clearPassword: false,
  country: '', region: '', city: '', provider: '', notes: '',
})
const form = reactive(blank())
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/
const rules = computed<Record<string, Rule[]>>(() => ({
  host: [{ required: true, message: t('proxies.required') }, { pattern: HOST_RE, message: t('proxies.hostInvalid') }],
  port: [{ required: true, message: t('proxies.required') }],
}))
function openAdd() { editing.value = null; Object.assign(form, blank()); formRef.value?.clearValidate(); editOpen.value = true }
function openEdit(p: PoolProxy) {
  editing.value = p
  Object.assign(form, {
    ...blank(), label: p.label ?? '', type: p.type, host: p.host, port: p.port, username: p.username ?? '',
    country: p.country ?? '', region: p.region ?? '', city: p.city ?? '', provider: p.provider ?? '', notes: p.notes ?? '',
  })
  formRef.value?.clearValidate()
  editOpen.value = true
}
async function save() {
  try { await formRef.value?.validate() } catch { return }
  saving.value = true
  const body: Record<string, unknown> = {
    label: form.label, type: form.type, host: form.host.trim(), port: form.port, username: form.username.trim() || null,
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
    } else {
      await api('POST', '/api/proxies', body)
      message.success(t('common.created'))
      void load()
    }
    form.password = ''
    editOpen.value = false
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}

function remove(p: PoolProxy) {
  if (p.boundInstance) { message.warning(t('proxies.boundNoDelete', { name: p.boundInstance.name })); return }
  Modal.confirm({
    title: t('proxies.confirmDelete', { name: proxyLabel(p) }),
    okType: 'danger', okText: t('common.delete'), cancelText: t('common.cancel'),
    onOk: async () => {
      try {
        await api('DELETE', `/api/proxies/${p.id}`)
        items.value = items.value.filter((x) => x.id !== p.id)
        message.success(t('common.deleted'))
      } catch (e) { message.error(errorText(e)) }
    },
  })
}

// ---- bulk import (preview = dry run, then import)
const importOpen = ref(false)
const importing = ref(false)
const imp = reactive({ text: '', defaultType: 'socks5' as ProxyType, provider: '', country: '' })
const preview = ref<ProxyImportResult | null>(null)
const IMPORT_FORMATS = ['socks5://user:pass@host:port', 'http://user:pass@host:port', 'http://host:port', 'host:port:user:pass', 'host:port']
function openImport() { Object.assign(imp, { text: '', defaultType: 'socks5', provider: '', country: '' }); preview.value = null; importOpen.value = true }
async function runImport(dryRun: boolean) {
  if (!imp.text.trim()) return
  importing.value = true
  try {
    const r = await api<ProxyImportResult>('POST', '/api/proxies/import', {
      text: imp.text, defaultType: imp.defaultType, dryRun, provider: imp.provider || undefined, country: imp.country || undefined,
    })
    preview.value = r
    if (!dryRun) {
      message.success(t('proxies.importDone', { created: r.created, duplicate: r.duplicate, invalid: r.invalid }))
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
  <a-card :title="t('proxies.title')" size="small">
    <template #extra>
      <a-space wrap>
        <a-tooltip :title="t('proxies.checkBatchHint')">
          <a-button :loading="batchChecking" :disabled="!items.length" @click="checkBatch">
            {{ t('proxies.checkBatch') }}{{ selectedKeys.length ? ` (${selectedKeys.length})` : '' }}
          </a-button>
        </a-tooltip>
        <a-button @click="openImport">{{ t('proxies.import') }}</a-button>
        <a-button type="primary" @click="openAdd">{{ t('proxies.add') }}</a-button>
      </a-space>
    </template>

    <a-space wrap style="margin-bottom: 12px">
      <a-input-search v-model:value="filters.q" :placeholder="t('proxies.searchPlaceholder')" allow-clear style="width: 280px" @search="load" />
      <a-select v-model:value="filters.status" :placeholder="t('proxies.filterStatus')" allow-clear style="width: 130px" @change="load">
        <a-select-option v-for="s in (['ok', 'failed', 'unchecked'] as const)" :key="s" :value="s">{{ statusText(s) }}</a-select-option>
      </a-select>
      <a-select v-model:value="filters.bound" :placeholder="t('proxies.filterBound')" allow-clear style="width: 120px" @change="load">
        <a-select-option value="free">{{ t('proxies.free') }}</a-select-option>
        <a-select-option value="bound">{{ t('proxies.bound') }}</a-select-option>
      </a-select>
      <a-input v-model:value="filters.country" :placeholder="t('proxies.filterCountry')" allow-clear style="width: 120px" @press-enter="load" />
      <a-button @click="load">{{ t('common.search') }}</a-button>
      <a-button @click="reset">{{ t('common.reset') }}</a-button>
      <span class="muted">{{ t('proxies.summary', summary) }}</span>
    </a-space>

    <a-table
      :data-source="items" :columns="columns" row-key="id" size="middle" :loading="loading" :scroll="{ x: 1310 }"
      :pagination="{ pageSize: 50, size: 'small', hideOnSinglePage: true, showSizeChanger: false }"
      :row-selection="{ selectedRowKeys: selectedKeys, onChange: (k: any[]) => (selectedKeys = k as string[]) }"
    >
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
              <a-tag :color="PROXY_STATUS_COLOR[record.status as ProxyStatus]">{{ statusText(record.status) }}</a-tag>
            </a-tooltip>
            <span v-if="record.lastCheck?.egressIp" class="mono small">{{ record.lastCheck.egressIp }}</span>
            <span v-if="record.lastCheck?.latencyMs != null" class="muted small">{{ record.lastCheck.latencyMs }} ms</span>
          </a-space>
          <div v-if="record.lastCheck" class="faint small">{{ t('proxies.checkedAt', { time: new Date(record.lastCheck.at).toLocaleString() }) }}</div>
        </template>
        <template v-else-if="column.key === 'device'">
          <a v-if="record.boundInstance" @click="router.push(`/instances/${record.boundInstance.id}`)">{{ record.boundInstance.name }}</a>
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
    <div class="faint small" style="margin-top: 8px">{{ t('proxies.checkHint') }}</div>
  </a-card>

  <a-modal v-model:open="editOpen" :title="editing ? t('proxies.edit') : t('proxies.add')" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" :confirm-loading="saving" :width="620" @ok="save">
    <a-form ref="formRef" :model="form" :rules="rules" layout="vertical">
      <a-form-item :label="t('proxies.label')" name="label">
        <a-input v-model:value="form.label" :maxlength="80" :placeholder="t('proxies.labelPlaceholder')" />
      </a-form-item>
      <a-row :gutter="12">
        <a-col :xs="24" :sm="6">
          <a-form-item :label="t('proxies.type')" name="type">
            <a-select v-model:value="form.type" :options="[{ value: 'socks5', label: 'SOCKS5' }, { value: 'http', label: 'HTTP' }]" />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('proxies.host')" name="host"><a-input v-model:value="form.host" :placeholder="t('proxies.hostPlaceholder')" /></a-form-item>
        </a-col>
        <a-col :xs="24" :sm="6">
          <a-form-item :label="t('proxies.port')" name="port"><a-input-number v-model:value="form.port" :min="1" :max="65535" style="width: 100%" /></a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('proxies.username')" name="username"><a-input v-model:value="form.username" autocomplete="off" :maxlength="200" /></a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('proxies.password')" name="password" :extra="editing?.hasPassword ? t('proxies.passwordKeep') : t('proxies.passwordHint')">
            <a-input-password v-model:value="form.password" autocomplete="new-password" :maxlength="200" :disabled="form.clearPassword" />
            <a-checkbox v-if="editing?.hasPassword" v-model:checked="form.clearPassword" style="margin-top: 4px">{{ t('proxies.clearPassword') }}</a-checkbox>
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="8"><a-form-item :label="t('proxies.country')"><a-input v-model:value="form.country" :maxlength="64" :placeholder="t('proxies.countryPlaceholder')" /></a-form-item></a-col>
        <a-col :xs="24" :sm="8"><a-form-item :label="t('proxies.region')"><a-input v-model:value="form.region" :maxlength="80" /></a-form-item></a-col>
        <a-col :xs="24" :sm="8"><a-form-item :label="t('proxies.city')"><a-input v-model:value="form.city" :maxlength="80" /></a-form-item></a-col>
      </a-row>
      <a-form-item :label="t('proxies.provider')"><a-input v-model:value="form.provider" :maxlength="80" /></a-form-item>
      <a-form-item :label="t('proxies.notes')"><a-textarea v-model:value="form.notes" :maxlength="500" :auto-size="{ minRows: 2, maxRows: 4 }" /></a-form-item>
    </a-form>
  </a-modal>

  <a-modal v-model:open="importOpen" :title="t('proxies.importTitle')" :width="760" :footer="null">
    <div class="muted small">{{ t('proxies.importFormats') }}</div>
    <ul class="formats mono small"><li v-for="f in IMPORT_FORMATS" :key="f">{{ f }}</li></ul>
    <a-textarea v-model:value="imp.text" :auto-size="{ minRows: 6, maxRows: 14 }" class="mono" spellcheck="false" autocomplete="off" @change="preview = null" />
    <a-row :gutter="12" style="margin-top: 12px">
      <a-col :xs="24" :sm="8">
        <div class="small muted">{{ t('proxies.defaultType') }}</div>
        <a-radio-group v-model:value="imp.defaultType" size="small" @change="preview = null">
          <a-radio-button value="socks5">SOCKS5</a-radio-button>
          <a-radio-button value="http">HTTP</a-radio-button>
        </a-radio-group>
      </a-col>
      <a-col :xs="24" :sm="8">
        <div class="small muted">{{ t('proxies.importProvider') }}</div>
        <a-input v-model:value="imp.provider" size="small" :maxlength="80" />
      </a-col>
      <a-col :xs="24" :sm="8">
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
      :pagination="{ pageSize: 20, size: 'small', hideOnSinglePage: true }"
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

  <a-modal v-model:open="usageOpen" :title="usageFor ? `${t('proxies.usage')} · ${proxyLabel(usageFor)}` : ''" :footer="null" :width="640">
    <a-spin :spinning="!usage">
      <template v-if="usage">
        <p>
          <span class="muted">{{ t('proxies.usageCurrent') }}：</span>
          <a v-if="usage.boundInstance" @click="usageOpen = false; router.push(`/instances/${usage.boundInstance.id}`)">{{ usage.boundInstance.name }}</a>
          <a-tag v-else color="green">{{ t('proxies.free') }}</a-tag>
        </p>
        <a-timeline v-if="usage.history.length">
          <a-timeline-item v-for="(h, i) in usage.history" :key="i" :color="h.ok ? (h.event === 'unbind' ? 'gray' : 'green') : 'red'">
            {{ new Date(h.at).toLocaleString() }} · {{ t(`proxies.usageEvents.${h.event}`) }} · {{ h.device ?? '—' }}
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
.muted { color: var(--cp-text-tertiary); }
.faint { color: var(--cp-text-quaternary); }
.small { font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.formats { margin: 4px 0 8px; padding-left: 18px; color: var(--cp-text-secondary); }
</style>
