<script setup lang="ts">
import { fmtDateTime } from '../i18n'
import { DownOutlined, ExclamationCircleOutlined, MenuFoldOutlined, MenuUnfoldOutlined, MoreOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons-vue'
import { message, Modal } from 'ant-design-vue'
import { computed, defineAsyncComponent, h, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../api/client'
import { useRoute, useRouter } from 'vue-router'
import { deviceListLink, queryParam } from '../api/query'
import { BUSY_STATUSES, egressGeo, taskText, type DeviceAutomation, type DeviceSource, type Instance, type InstanceOwner, type SourcePhone, type Task } from '../api/types'
import DeviceAssignModal from '../components/DeviceAssignModal.vue'
import DeviceLogDrawer from '../components/DeviceLogDrawer.vue'
import DeviceState from '../components/DeviceState.vue'
import DeviceThumb from '../components/DeviceThumb.vue'
import OwnerBadge from '../components/OwnerBadge.vue'
import BatchActions, { type BatchItem } from '../components/common/BatchActions.vue'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import SyncFromDeviceModal from '../components/social/SyncFromDeviceModal.vue'
import StoreInstallModal from '../components/library/StoreInstallModal.vue'
import { actionColumn, confirmDanger, MODAL_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

const store = useInstancesStore()
const auth = useAuthStore()
const router = useRouter()
const { t } = useI18n()
const selectedKeys = ref<string[]>([])

type Action = 'start' | 'stop' | 'restart' | 'delete'
const actionText = (a: Action) => t(`devices.${a}`)

const counts = computed(() => {
  const c = { total: store.list.length, running: 0, stopped: 0, busy: 0, error: 0 }
  for (const i of store.list) {
    if (i.status === 'running') c.running++
    else if (i.status === 'stopped') c.stopped++
    else if (BUSY_STATUSES.includes(i.status)) c.busy++
    else if (i.status === 'error') c.error++
  }
  return c
})

const columns = computed(() => [
  { title: t('common.name'), dataIndex: 'name', key: 'name', width: 180, fixed: 'left' as const },
  { title: t('devices.colKind'), key: 'kind', width: 130 },
  { title: t('common.status'), key: 'status', width: 170 },
  ...(auth.isAdmin ? [{ title: t('devices.colOwners'), key: 'owners', width: 200 }] : []),
  { title: t('devices.colEgress'), key: 'egress', width: 170 },
  { title: t('devices.colAdbPort'), dataIndex: 'adbPort', key: 'adbPort', width: 100 },
  { title: t('devices.colResolution'), key: 'spec', width: 140 },
  ...(connOn.value ? [
    { title: t('sysadmin.conn.adb'), key: 'adb', width: 110 },
    { title: t('sysadmin.conn.stf'), key: 'stf', width: 90 },
    { title: t('sysadmin.conn.scrcpy'), key: 'scrcpy', width: 140 },
    { title: t('sysadmin.conn.rtt'), key: 'rtt', width: 110 },
    { title: t('sysadmin.conn.lastOffline'), key: 'lastOffline', width: 170 },
  ] : []),
  actionColumn(190),
])

// ---- status group filter (?status= from dashboard links) and owner filter (admin only)
type StatusGroup = 'running' | 'stopped' | 'busy' | 'error' | 'issue'
const statusFilter = ref<StatusGroup | undefined>(queryParam<StatusGroup>(useRoute().query, 'status', ['running', 'stopped', 'busy', 'error', 'issue']))
/**
 * 仅异常 (from the former 连线监控, merged 2026-11-21): error, a running phone whose adb or STF isn't ready,
 * a failed egress check, or 风控暂停.
 */
const isIssue = (i: Instance) => i.status === 'error' || (i.status === 'running' && (i.adbState !== 'device' || !i.stfReady))
  || i.proxyStatus?.ok === false || !!automation.value[i.id]?.halted
const inGroup = (i: Instance, g: StatusGroup) => (g === 'issue' ? isIssue(i) : g === 'busy' ? BUSY_STATUSES.includes(i.status) : i.status === g)
const ownerFilter = ref<InstanceOwner | null>(null)
// ?id= from device-name links on other pages (deviceListLink): only that device, highlighted; never opens remote control.
const route = useRoute()
const focusId = ref<string | undefined>(queryParam(route.query, 'id'))
watch(() => route.query.id, () => { focusId.value = queryParam(route.query, 'id') })
function clearFocus() {
  focusId.value = undefined
  if (route.query.id) void router.replace({ query: { ...route.query, id: undefined } })
}
// Search: name / id / phone id / egress IP; several terms separated by comma or space match any.
const search = ref('')
const terms = computed(() => search.value.toLowerCase().split(/[\s,，;；]+/).filter(Boolean))
function matches(i: Instance) {
  if (!terms.value.length) return true
  const hay = [i.name, i.id, i.externalId, i.proxyStatus?.egressIp]
    .filter(Boolean).join(' ').toLowerCase()
  return terms.value.some((q) => hay.includes(q))
}
const rows = computed(() => {
  const f = ownerFilter.value
  const s = statusFilter.value
  const id = focusId.value
  return store.list.filter((i) => (!id || i.id === id) && (!f || i.owners?.some((o) => o.id === f.id)) && (!s || inGroup(i, s)) && matches(i))
})
const statusOptions = computed(() => [
  { value: '', label: t('cloud.allPhones', { n: counts.value.total }) },
  { value: 'running', label: `${t('devices.running')} (${counts.value.running})` },
  { value: 'stopped', label: `${t('status.stopped')} (${counts.value.stopped})` },
  { value: 'busy', label: `${t('devices.busy')} (${counts.value.busy})` },
  { value: 'error', label: `${t('devices.error')} (${counts.value.error})` },
  { value: 'issue', label: `${t('devices.onlyIssues')} (${store.list.filter(isIssue).length})` },
])

// ---- selection over the visible rows
const allSelected = computed(() => rows.value.length > 0 && rows.value.every((i) => selectedKeys.value.includes(i.id)))
const someSelected = computed(() => !allSelected.value && rows.value.some((i) => selectedKeys.value.includes(i.id)))
function toggleAll(on: boolean) {
  const visible = new Set(rows.value.map((i) => i.id))
  selectedKeys.value = on ? [...new Set([...selectedKeys.value, ...visible])] : selectedKeys.value.filter((k) => !visible.has(k))
}
function toggleOne(id: string, on: boolean) {
  selectedKeys.value = on ? [...selectedKeys.value, id] : selectedKeys.value.filter((k) => k !== id)
}

// ---- layout preferences (per browser)
const PREF_KEY = 'devicefarmer.cloudPhones.view'
function readPref(): { view: 'grid' | 'table'; panel: boolean; conn: boolean } {
  try { const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}'); return { view: p.view === 'table' ? 'table' : 'grid', panel: p.panel !== false, conn: p.conn === true } }
  catch { return { view: 'grid', panel: true, conn: false } }
}
const pref = reactive(readPref())
// /connections (the former 连线监控 page) redirects to ?view=table&conn=1.
if (route.query.conn === '1') { pref.view = 'table'; pref.conn = true }
watch(pref, (p) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)) } catch { /* private mode */ } })
/**
 * 我的云机 (every role; owner's menu list 2026-11-18). Non-admins: grid only, no side list, no selection / batch menu /
 * status filter, the name search only with more than 6 devices; per card only 远控, the status, 日志 and 同步媒体号
 * (no power buttons: every device is an external phone, powering it is admin only, BitBrowser power-on is billed).
 * Admins additionally add phones from device sources, assign users and have the full menu. The API's RBAC is unchanged.
 */
const view = computed(() => (auth.isAdmin ? pref.view : 'grid'))
const showSearch = computed(() => auth.isAdmin || store.list.length > 6)

// ---- slide-in remote control
const phoneOpen = ref(false)
const phoneId = ref<string | null>(null)
/** The remote-control drawer (with the player) is its own chunk, rendered from the first time a phone is opened. */
const CloudPhoneDrawer = defineAsyncComponent(() => import('../components/CloudPhoneDrawer.vue'))
const phoneUsed = ref(false)
function openPhone(id: string) { phoneId.value = id; phoneOpen.value = true; phoneUsed.value = true }
function filterByOwner(o: InstanceOwner) {
  ownerFilter.value = o
  const visible = new Set(rows.value.map((i) => i.id))
  selectedKeys.value = selectedKeys.value.filter((k) => visible.has(k))
}
const ownerName = (o: InstanceOwner) => o.displayName ? t('permissions.userLabel', { display: o.username, username: o.displayName }) : o.username

// ---- actions menu (row and batch)
type MenuKey = Action | 'install' | 'sync' | 'assign' | 'assign-batch' | 'unassign'
const isBusy = (i: Instance) => BUSY_STATUSES.includes(i.status)
/** Whether an action makes sense for this device's current status. */
function canDo(key: MenuKey, i: Instance) {
  if (isBusy(i)) return false
  if ((key === 'start' || key === 'stop' || key === 'restart') && !auth.isAdmin) return false
  if (key === 'start') return i.status !== 'running'
  if (key === 'stop' || key === 'restart') return i.status !== 'stopped'
  if (key === 'install' && !auth.isAdmin) return false
  if (key === 'install' || key === 'sync') return i.status === 'running'
  return true
}
/** 批量操作 menu; confirmations (delete/stop/restart, billed power-on) stay in run(). */
const batchItems = computed<BatchItem[]>(() => [
  { key: 'start', label: t('devices.start') },
  { key: 'stop', label: t('devices.stop') },
  { key: 'restart', label: t('devices.restart') },
  ...(auth.isAdmin ? [
    { key: 'install', label: t('devices.installApp') },
    { key: 'assign-batch', label: t('permissions.assignToSelected') },
    { key: 'unassign', label: t('permissions.unassignSelected') },
    { key: 'delete', label: t('devices.delete'), danger: true },
  ] : []),
])
function onMenu(key: MenuKey, ids: string[]) {
  if (key === 'assign' || key === 'assign-batch' || key === 'unassign') openAssign(key === 'assign' ? 'set' : key === 'assign-batch' ? 'assign' : 'clear', ids)
  else if (key === 'sync') void openSync(ids[0]!)
  else if (key === 'install') storeIds.value = [...ids]
  else void run(key, ids)
}

// ---- 分配 (admin): a phone belongs to one user or none; one device (更多 → 分配), or the selection (分配给用户 / 取消分配).
const assignOpen = ref(false)
const assignMode = ref<'set' | 'assign' | 'clear'>('set')
const assignIds = ref<string[]>([])
function openAssign(mode: 'set' | 'assign' | 'clear', ids: string[]) {
  if (!ids.length) return
  assignMode.value = mode; assignIds.value = [...ids]; assignOpen.value = true
}

// ---- 同步媒体号: the shared 从云手机同步 dialog (POST /api/social/sync-from-device) with this device preselected;
// the account goes to the phone's assigned user (unassigned: the admin running it), shown read only there.
const syncOpen = ref(false)
const syncId = ref<string | undefined>()
function openSync(id: string) {
  syncId.value = id
  syncOpen.value = true
}
function onSynced(accountId: string) {
  message.success({ content: () => h('span', [t('devices.syncDone'), ' ', h('a', { onClick: () => router.push({ path: '/social', query: { instanceId: syncId.value } }) }, t('devices.syncView'))]), key: accountId })
}

async function run(action: Action, ids: string[]) {
  if (!ids.length) return
  const go = async () => {
    try {
      const r = await store.action(action, ids)
      if (r.accepted.length) message.success(t('devices.submitted', { n: r.accepted.length, action: actionText(action) }))
      if (r.skipped.length) message.warning(t('common.skipped', { n: r.skipped.length, reasons: [...new Set(r.skipped.map((s) => (s.code ? codeText(s.code, undefined, s.reason) : s.reason)))].join(t('common.reasonSep')) }))
      if (action === 'delete') selectedKeys.value = selectedKeys.value.filter((k) => !ids.includes(k))
    } catch (e) {
      message.error(errorText(e))
    }
  }
  // Cloud phones (BitBrowser) are billed while on; phones are only removed from the platform on delete.
  const sel = ids.map((id) => store.byId.get(id)).filter((i): i is Instance => !!i)
  const bitNames = sel.filter((i) => i.engine === 'bitbrowser').map((i) => i.name)
  const billed = (action === 'start' || action === 'restart') && bitNames.length > 0
  if (action === 'delete' || action === 'restart' || action === 'stop' || billed) {
    const names = ids.map((id) => store.byId.get(id)?.name).filter(Boolean)
    const notes = [
      billed ? t('devices.ext.billingList', { names: bitNames.join(t('common.listSep')) }) : '',
      action === 'delete' ? t('devices.ext.deleteNote') : '',
    ].filter(Boolean)
    Modal.confirm({
      title: t('devices.confirmAction', { action: actionText(action), n: ids.length }),
      content: h('div', { style: 'white-space: pre-line' }, [action === 'delete'
        ? t('devices.confirmDelete', { names: names.join(t('common.listSep')) })
        : names.join(t('common.listSep')), ...notes].join('\n')),
      okType: action === 'delete' ? 'danger' : 'primary',
      okText: actionText(action),
      cancelText: t('common.cancel'),
      onOk: go,
    })
  } else {
    await go()
  }
}

// ---- 安装应用 (admin): the 应用市场 list of the phones' source types (StoreInstallModal)
const storeIds = ref<string[] | null>(null)

// ---- 新增云手机: phones of a device source (BitBrowser); nothing is powered on here
const createOpen = ref(false)
const creating = ref(false)
const kind = ref<DeviceSource['type']>('bitbrowser')
const kindLabel = (i: Pick<Instance, 'engine'>) => t(`devices.ext.kinds.${i.engine}`)
function openCreate() { createOpen.value = true }
const sources = ref<DeviceSource[]>([])
const sourceId = ref<string | undefined>()
const kindSources = computed(() => sources.value.filter((s) => s.type === kind.value))
const phones = ref<SourcePhone[]>([])
const phonesLoading = ref(false)
const pickedPhones = ref<string[]>([])
const phoneColumns = computed(() => [
  { title: t('common.name'), key: 'name' },
  { title: t('devices.ext.model'), key: 'model', width: 140 },
  { title: t('devices.ext.region'), key: 'region', width: 120 },
  { title: t('devices.ext.power'), key: 'power', width: 80 },
])
async function loadSources() {
  try {
    sources.value = (await api<{ sources: DeviceSource[] }>('GET', '/api/device-sources')).sources
    if (!kindSources.value.some((s) => s.id === sourceId.value)) sourceId.value = kindSources.value[0]?.id
  } catch (e) { message.error(errorText(e)) }
}
async function loadPhones() {
  phones.value = []; pickedPhones.value = []
  if (!sourceId.value) return
  phonesLoading.value = true
  try { phones.value = (await api<{ phones: SourcePhone[] }>('GET', `/api/device-sources/${sourceId.value}/phones`)).phones }
  catch (e) { message.error(errorText(e)) }
  finally { phonesLoading.value = false }
}
watch(createOpen, (open) => { if (open) void loadSources() })
watch(sourceId, () => void loadPhones())

// source editor: BitBrowser = the client's local API address (host + port), optional Local API Token
// (write-only: empty keeps the saved one) and the client machine's time zone
const srcEdit = reactive({
  open: false, id: null as string | null, name: '', host: '127.0.0.1', port: 54345, saving: false,
  apiKey: '', apiKeySet: false, clearKey: false, timeZone: undefined as string | undefined,
})
const TIME_ZONES: string[] = (() => { try { return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone') } catch { return [] } })()
const selectedSource = computed(() => kindSources.value.find((s) => s.id === sourceId.value))
function editSource(s?: DeviceSource) {
  let host = '127.0.0.1'; let port = 54345
  if (s && typeof s.config.apiUrl === 'string') {
    try { const u = new URL(s.config.apiUrl); host = u.hostname; port = Number(u.port) || 80 } catch { /* keep defaults */ }
  }
  Object.assign(srcEdit, {
    open: true, id: s?.id ?? null, name: s?.name ?? t('devices.ext.defaultName'), host, port,
    apiKey: '', apiKeySet: s?.config.apiKeySet === true, clearKey: false, timeZone: typeof s?.config.timeZone === 'string' ? s.config.timeZone : undefined,
  })
}
async function saveSource() {
  srcEdit.saving = true
  try {
    const config: Record<string, unknown> = { apiUrl: `http://${srcEdit.host.trim()}:${srcEdit.port}` }
    if (srcEdit.apiKey.trim()) config.apiKey = srcEdit.apiKey.trim()
    else if (srcEdit.clearKey) config.apiKey = null
    if (srcEdit.timeZone) config.timeZone = srcEdit.timeZone
    const body = { name: srcEdit.name.trim(), config }
    const r = srcEdit.id
      ? await api<{ source: DeviceSource }>('PATCH', `/api/device-sources/${srcEdit.id}`, body)
      : await api<{ source: DeviceSource }>('POST', '/api/device-sources', { type: kind.value, ...body })
    srcEdit.open = false
    message.success(t('devices.ext.sourceSaved'))
    await loadSources()
    if (sourceId.value === r.source.id) await loadPhones(); else sourceId.value = r.source.id
  } catch (e) { message.error(errorText(e)) }
  finally { srcEdit.saving = false }
}
function deleteSource() {
  const id = srcEdit.id
  if (!id) return
  confirmDanger({
    title: t('devices.ext.deleteSource'),
    onOk: async () => {
      try { await api('DELETE', `/api/device-sources/${id}`); srcEdit.open = false; await loadSources() }
      catch (e) { message.error(errorText(e)) }
    },
  })
}
async function submitCreate() {
  if (!sourceId.value || !pickedPhones.value.length) { message.error(t('devices.ext.pickPhones')); return }
  creating.value = true
  try {
    const r = await api<{ instances: Instance[] }>('POST', '/api/instances/external', { sourceId: sourceId.value, phoneIds: pickedPhones.value })
    message.success(t('devices.ext.added', { names: r.instances.map((i) => i.name).join(t('common.listSep')) }))
    createOpen.value = false
    await store.refresh()
  } catch (e) { message.error(errorText(e)) }
  finally { creating.value = false }
}

function netTitle(i: Instance) {
  const s = i.proxyStatus
  return s?.egressIp ? `${t('devices.colEgress')} ${s.egressIp}${egressGeo(s) ? ` (${egressGeo(s)})` : ''}` : ''
}
/** Country for the compact badges: the measured egress. */
const countryOf = (i: Instance) => i.proxyStatus?.country ?? null

// ---- automation state (风控暂停 / busy) of the visible devices, for the one status per device (DeviceState)
const automation = ref<Record<string, DeviceAutomation>>({})
async function loadAutomation() {
  try { automation.value = (await api<{ devices: Record<string, DeviceAutomation> }>('GET', '/api/instances/automation')).devices } catch { /* status without it */ }
}
void loadAutomation()
const automationTimer = setInterval(() => { if (!document.hidden) void loadAutomation() }, 10_000)
onUnmounted(() => clearInterval(automationTimer))

// ---- 连线详情 (admin, table view; the former 连线监控 page merged here 2026-11-21, owner 「按方案合并」):
// extra columns from GET /api/system/connections (admin only), polled with the automation state.
interface ConnRow {
  id: string; adbState: string | null; stfReady: boolean; lastOfflineAt: string | null
  adbRttMs: number | null; adbRttAt: string | null; scrcpy: { viewers: number; link: 'relay' | 'adb' } | null
}
const connOn = computed(() => auth.isAdmin && view.value === 'table' && pref.conn)
const conn = ref<Record<string, ConnRow>>({})
async function loadConn() {
  if (!connOn.value) return
  try { conn.value = Object.fromEntries((await api<{ devices: ConnRow[] }>('GET', '/api/system/connections')).devices.map((d) => [d.id, d])) }
  catch { /* columns show — */ }
}
watch(connOn, (on) => { if (on) void loadConn() }, { immediate: true })
const connTimer = setInterval(() => { if (!document.hidden) void loadConn() }, 10_000)
onUnmounted(() => clearInterval(connTimer))
const adbColor = (s: string | null) => (s === 'device' ? 'green' : s ? 'red' : 'default')
const rttColor = (ms: number) => (ms < 100 ? 'green' : ms < 500 ? 'orange' : 'red')

// ---- per-device log drawer
const logOpen = ref(false)
const logId = ref<string | null>(null)
const logInstance = computed(() => (logId.value ? store.byId.get(logId.value) ?? null : null))
function openLog(id: string) { logId.value = id; logOpen.value = true }

// ---- failed tasks in the last 24 h (visible devices only)
const now = ref(Date.now())
const tick = setInterval(() => (now.value = Date.now()), 60_000)
onUnmounted(() => clearInterval(tick))
const failedTasks = computed(() => store.tasks.filter((t) =>
  t.status === 'failed' && t.instanceId && store.byId.has(t.instanceId) && now.value - Date.parse(t.createdAt) < 86_400_000))
const failedAt = (t: Task) => Date.parse(t.finishedAt ?? t.createdAt)
const newestFailure = computed(() => Math.max(0, ...failedTasks.value.map(failedAt)))
const SEEN_KEY = 'devicefarmer.failedTasksSeenAt'
function readSeen() { try { return Number(localStorage.getItem(SEEN_KEY)) || 0 } catch { return 0 } }
const seenAt = ref(readSeen())
const showFailed = computed(() => failedTasks.value.length > 0 && newestFailure.value > seenAt.value)
function dismissFailed() {
  seenAt.value = newestFailure.value
  try { localStorage.setItem(SEEN_KEY, String(seenAt.value)) } catch { /* private mode: hide for this session only */ }
}
const failedOpen = ref(false)
const failedColumns = computed(() => [
  { title: t('common.time'), key: 'time', width: 170 },
  { title: t('common.device'), key: 'device', width: 120 },
  { title: t('common.action'), key: 'type', width: 120 },
  { title: t('common.error'), key: 'error' },
])
watch(showFailed, (v) => { if (!v) failedOpen.value = false })
</script>

<template>
  <PageContainer>
    <template #extra>
      <a-button v-if="auth.isAdmin" type="primary" @click="openCreate"><template #icon><PlusOutlined /></template>{{ t('devices.createDevice') }}</a-button>
    </template>

    <a-alert v-if="showFailed" type="error" show-icon>
      <template #icon><ExclamationCircleOutlined /></template>
      <template #message>{{ t('devices.failedRecent', { n: failedTasks.length }) }}</template>
      <template #action>
        <a-space :size="0">
          <a-button size="small" type="link" @click="failedOpen = true">{{ t('common.view') }}</a-button>
          <a-button size="small" type="text" @click="dismissFailed">{{ t('common.ignore') }}</a-button>
        </a-space>
      </template>
    </a-alert>

    <a-card :bordered="false">
      <SearchBar :loading="store.loading" @refresh="store.refresh()">
        <a-tooltip v-if="view === 'grid' && auth.isAdmin" :title="t('cloud.togglePanel')">
          <a-button :aria-label="t('cloud.togglePanel')" @click="pref.panel = !pref.panel"><template #icon><MenuFoldOutlined v-if="pref.panel" /><MenuUnfoldOutlined v-else /></template></a-button>
        </a-tooltip>
        <a-tooltip v-if="view === 'grid' && auth.isAdmin" :title="t('cloud.selectAll')">
          <a-checkbox :checked="allSelected" :indeterminate="someSelected" :disabled="!rows.length" @change="(e: any) => toggleAll(e.target.checked)" />
        </a-tooltip>
        <a-input v-if="showSearch" v-model:value="search" allow-clear :placeholder="t('cloud.search')" style="width: 320px">
          <template #prefix><SearchOutlined class="muted" /></template>
        </a-input>
        <a-select v-if="auth.isAdmin" :value="statusFilter ?? ''" :options="statusOptions" style="width: 150px" @change="(v: any) => (statusFilter = v || undefined)" />
        <a-tag v-if="ownerFilter" closable color="blue" @close="ownerFilter = null">{{ t('devices.ownerTag', { name: ownerFilter.username }) }}</a-tag>
        <a-tag v-if="focusId" closable color="blue" @close="clearFocus">{{ t('devices.focusTag', { name: store.byId.get(focusId)?.name ?? focusId.slice(0, 8) }) }}</a-tag>
        <template v-if="auth.isAdmin" #actions>
          <BatchActions :count="selectedKeys.length" :items="batchItems" @select="(k: string) => onMenu(k as MenuKey, selectedKeys)" @clear="selectedKeys = []" />
          <a-checkbox v-if="view === 'table'" v-model:checked="pref.conn">{{ t('devices.connDetail') }}</a-checkbox>
          <a-segmented v-model:value="pref.view" :options="[{ value: 'grid', label: t('cloud.viewGrid') }, { value: 'table', label: t('cloud.viewTable') }]" />
        </template>
      </SearchBar>

      <a-table
        v-if="view === 'table'"
        :data-source="rows"
        :columns="columns"
        row-key="id"
        :size="TABLE_SIZE"
        :pagination="pagination({ defaultPageSize: 50 })"
        :scroll="{ x: auth.isAdmin ? (connOn ? 1920 : 1300) : 1100 }"
        :row-class-name="(r: Instance) => (r.id === focusId ? 'row-focus' : '')"
        :row-selection="{ selectedRowKeys: selectedKeys, onChange: (k: any[]) => (selectedKeys = k as string[]) }"
      >
        <template #emptyText>
          <a-empty :description="store.list.length ? t('cloud.noMatch') : auth.isAdmin ? t('devices.emptyAdmin') : t('devices.emptyUser')">
            <a-button v-if="auth.isAdmin && !store.list.length" type="primary" @click="openCreate"><template #icon><PlusOutlined /></template>{{ t('devices.createDevice') }}</a-button>
          </a-empty>
        </template>
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <a @click="openPhone(record.id)">{{ record.name }}</a>
          </template>
          <template v-else-if="column.key === 'kind'">{{ kindLabel(record as Instance) }}</template>
          <template v-else-if="column.key === 'status'">
            <DeviceState :instance="record as Instance" :automation="automation[record.id]" :resumable="auth.isAdmin" :admin="auth.isAdmin" @resumed="loadAutomation" />
          </template>
          <template v-else-if="column.key === 'owners'">
            <OwnerBadge :owners="record.owners ?? []" :label="ownerName" @filter="filterByOwner" />
          </template>
          <template v-else-if="column.key === 'egress'">
            <a-tooltip v-if="record.proxyStatus" :title="[egressGeo(record.proxyStatus), record.proxyStatus.error, fmtDateTime(record.proxyStatus.checkedAt)].filter(Boolean).join(' · ')">
              <a-space :size="4">
                <a-tag v-if="record.proxyStatus.country" :color="record.proxyStatus.ok ? 'blue' : 'red'" style="margin: 0">{{ record.proxyStatus.country }}</a-tag>
                <span :class="{ faint: !record.proxyStatus.ok }">{{ record.proxyStatus.egressIp ?? t('devices.egressNone') }}</span>
              </a-space>
            </a-tooltip>
            <span v-else class="faint">—</span>
          </template>
          <template v-else-if="column.key === 'spec'">
            {{ record.spec.width }}×{{ record.spec.height }}
          </template>
          <template v-else-if="column.key === 'adb'">
            <a-tag :color="adbColor(record.adbState)">{{ record.adbState ?? '—' }}</a-tag>
          </template>
          <template v-else-if="column.key === 'stf'">
            <a-tag :color="record.stfReady ? 'green' : 'default'">{{ record.stfReady ? t('sysadmin.conn.ready') : t('sysadmin.conn.notReady') }}</a-tag>
          </template>
          <template v-else-if="column.key === 'scrcpy'">
            <template v-if="conn[record.id]?.scrcpy">
              <a-tag color="blue">{{ t(`sysadmin.conn.link.${conn[record.id]!.scrcpy!.link}`) }}</a-tag>
              <span class="muted small">{{ t('sysadmin.conn.viewers', { n: conn[record.id]!.scrcpy!.viewers }) }}</span>
            </template>
            <span v-else class="muted">{{ t('sysadmin.conn.idle') }}</span>
          </template>
          <template v-else-if="column.key === 'rtt'">
            <a-tooltip v-if="conn[record.id]?.adbRttMs != null" :title="t('sysadmin.conn.measuredAt', { at: fmtDateTime(conn[record.id]!.adbRttAt) })">
              <a-tag :color="rttColor(conn[record.id]!.adbRttMs!)">{{ conn[record.id]!.adbRttMs }} ms</a-tag>
            </a-tooltip>
            <span v-else class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'lastOffline'">{{ conn[record.id]?.lastOfflineAt ? fmtDateTime(conn[record.id]!.lastOfflineAt) : '—' }}</template>
          <template v-else-if="column.key === 'ops'">
            <a-space :size="0">
              <a-button size="small" type="link" :disabled="record.status !== 'running'" @click="openPhone(record.id)">{{ t('devices.control') }}</a-button>
              <a-button size="small" type="link" @click="openLog(record.id)">{{ t('devices.log') }}</a-button>
              <a-dropdown :trigger="['click']" placement="bottomRight">
                <a-button size="small" type="link">{{ t('common.more') }} <DownOutlined /></a-button>
                <template #overlay>
                  <a-menu @click="({ key }: any) => onMenu(key as MenuKey, [record.id])">
                    <a-menu-item key="start" :disabled="!canDo('start', record as Instance)">{{ t('devices.start') }}</a-menu-item>
                    <a-menu-item key="stop" :disabled="!canDo('stop', record as Instance)">{{ t('devices.stop') }}</a-menu-item>
                    <a-menu-item key="restart" :disabled="!canDo('restart', record as Instance)">{{ t('devices.restart') }}</a-menu-item>
                    <a-menu-item v-if="auth.isAdmin" key="install" :disabled="!canDo('install', record as Instance)">{{ t('devices.installApp') }}</a-menu-item>
                    <a-menu-item key="sync" :disabled="!canDo('sync', record as Instance)">{{ t('devices.syncAccounts') }}</a-menu-item>
                    <a-menu-item v-if="auth.isAdmin" key="assign">{{ t('permissions.assign') }}</a-menu-item>
                    <template v-if="auth.isAdmin">
                      <a-menu-divider />
                      <a-menu-item key="delete" danger :disabled="!canDo('delete', record as Instance)">{{ t('devices.delete') }}</a-menu-item>
                    </template>
                  </a-menu>
                </template>
              </a-dropdown>
            </a-space>
          </template>
        </template>
      </a-table>

      <div v-else class="body">
        <aside v-if="pref.panel && auth.isAdmin" class="side">
          <div class="side-head">{{ statusOptions.find((o) => o.value === (statusFilter ?? ''))?.label }}</div>
          <div class="side-list">
            <div v-for="i in rows" :key="i.id" class="item" :class="{ active: phoneOpen && phoneId === i.id }" @click="openPhone(i.id)">
              <a-checkbox :checked="selectedKeys.includes(i.id)" @click.stop @change="(e: any) => toggleOne(i.id, e.target.checked)" />
              <div class="item-main">
                <div class="ellipsis">{{ i.name }}</div>
                <div class="ellipsis muted small">{{ kindLabel(i) }}<template v-if="countryOf(i)"> · {{ countryOf(i) }}</template></div>
              </div>
              <DeviceState :instance="i" :automation="automation[i.id]" :admin="auth.isAdmin" />
            </div>
            <div v-if="!rows.length" class="side-empty muted">{{ store.list.length ? t('cloud.noMatch') : '—' }}</div>
          </div>
        </aside>

        <section class="grid">
          <div v-for="i in rows" :key="i.id" class="phone" :class="{ selected: selectedKeys.includes(i.id), focus: i.id === focusId }">
            <div class="phone-head">
              <a-checkbox v-if="auth.isAdmin" :checked="selectedKeys.includes(i.id)" @change="(e: any) => toggleOne(i.id, e.target.checked)" />
              <span class="phone-name ellipsis" :title="i.name">{{ i.name }}</span>
              <a-dropdown v-if="auth.isAdmin" :trigger="['click']" placement="bottomRight">
                <a-button size="small" type="text" :aria-label="t('common.more')"><template #icon><MoreOutlined /></template></a-button>
                <template #overlay>
                  <a-menu @click="({ key }: any) => (key === 'log' ? openLog(i.id) : onMenu(key as MenuKey, [i.id]))">
                    <a-menu-item key="start" :disabled="!canDo('start', i)">{{ t('devices.start') }}</a-menu-item>
                    <a-menu-item key="stop" :disabled="!canDo('stop', i)">{{ t('devices.stop') }}</a-menu-item>
                    <a-menu-item key="restart" :disabled="!canDo('restart', i)">{{ t('devices.restart') }}</a-menu-item>
                    <a-menu-item v-if="auth.isAdmin" key="install" :disabled="!canDo('install', i)">{{ t('devices.installApp') }}</a-menu-item>
                    <a-menu-item key="sync" :disabled="!canDo('sync', i)">{{ t('devices.syncAccounts') }}</a-menu-item>
                    <a-menu-item key="assign">{{ t('permissions.assign') }}</a-menu-item>
                    <a-menu-item key="log">{{ t('devices.log') }}</a-menu-item>
                    <template v-if="auth.isAdmin">
                      <a-menu-divider />
                      <a-menu-item key="delete" danger :disabled="!canDo('delete', i)">{{ t('devices.delete') }}</a-menu-item>
                    </template>
                  </a-menu>
                </template>
              </a-dropdown>
            </div>
            <div v-if="auth.isAdmin && i.owners" class="phone-owners">
              <OwnerBadge :owners="i.owners" :label="ownerName" @filter="filterByOwner" />
            </div>
            <div class="phone-screen" role="button" tabindex="0" @click="openPhone(i.id)" @keydown.enter="openPhone(i.id)">
              <DeviceThumb :instance-id="i.id" :running="i.status === 'running'" :paused="phoneOpen" :slow="true" :width="i.spec.width" :height="i.spec.height">
                <DeviceState :instance="i" :automation="automation[i.id]" :resumable="auth.isAdmin" :admin="auth.isAdmin" @resumed="loadAutomation" />
              </DeviceThumb>
              <div class="badges">
                <span class="badge">{{ kindLabel(i) }}</span>
                <span v-if="countryOf(i)" class="badge" :class="{ bad: i.proxyStatus && !i.proxyStatus.ok }" :title="netTitle(i)">{{ countryOf(i) }}</span>
              </div>
              <div v-if="i.status === 'running'" class="hover"><span>{{ t('cloud.clickToControl') }}</span></div>
            </div>
            <div v-if="!auth.isAdmin" class="phone-actions">
              <a-button size="small" type="link" :disabled="i.status !== 'running'" @click="openPhone(i.id)">{{ t('devices.control') }}</a-button>
              <a-button size="small" type="link" @click="openLog(i.id)">{{ t('devices.log') }}</a-button>
              <a-tooltip :title="t('devices.syncAccountsHint')">
                <a-button size="small" type="link" :disabled="!canDo('sync', i)" @click="openSync(i.id)">{{ t('devices.syncAccounts') }}</a-button>
              </a-tooltip>
            </div>
          </div>

          <button v-if="auth.isAdmin" type="button" class="phone add" @click="openCreate">
            <span class="add-icon"><PlusOutlined /></span>
            <span>{{ t('devices.createDevice') }}</span>
          </button>
          <div v-if="!rows.length && !auth.isAdmin" class="empty"><a-empty :description="store.list.length ? t('cloud.noMatch') : t('devices.emptyUser')" /></div>
        </section>
      </div>
    </a-card>
  </PageContainer>

  <a-modal v-model:open="createOpen" :title="t('devices.createDevice')" :width="MODAL_WIDTH.lg">
    <a-form layout="vertical">
      <a-form-item :label="t('devices.ext.source')">
        <a-space wrap style="width: 100%">
          <a-select v-model:value="sourceId" :options="kindSources.map((s) => ({ value: s.id, label: `${s.name} · ${s.config.apiUrl ?? ''}` }))" :placeholder="t('devices.ext.noSource')" style="width: 360px; max-width: 100%" />
          <a-button v-if="sourceId" @click="editSource(kindSources.find((s) => s.id === sourceId))">{{ t('common.edit') }}</a-button>
          <a-button type="dashed" @click="editSource()"><template #icon><PlusOutlined /></template>{{ t('devices.ext.newSource') }}</a-button>
          <a-tooltip v-if="selectedSource?.health && selectedSource.health.ok !== null"
            :title="selectedSource.health.ok ? t('devices.ext.healthOkTip', { at: fmtDateTime(selectedSource.health.lastOkAt) }) : t('devices.ext.healthDownTip', { since: fmtDateTime(selectedSource.health.failingSince), error: selectedSource.health.lastError ?? '' })">
            <a-tag :color="selectedSource.health.ok ? 'success' : 'error'">{{ selectedSource.health.ok ? t('devices.ext.healthOk') : t('devices.ext.healthDown') }}</a-tag>
          </a-tooltip>
        </a-space>
      </a-form-item>
      <a-form-item v-if="sourceId" :label="t('devices.ext.phones')" :extra="t('devices.ext.addHint')">
        <a-table
          :data-source="phones" :columns="phoneColumns" row-key="id" size="small" :loading="phonesLoading" :pagination="false" :scroll="{ x: 560, y: 320 }"
          :row-selection="{ selectedRowKeys: pickedPhones, onChange: (k: any[]) => (pickedPhones = k as string[]), getCheckboxProps: (r: SourcePhone) => ({ disabled: !!r.instance }) }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              <div>{{ record.name }} <a-tag v-if="record.instance" color="blue">{{ t('devices.ext.alreadyAdded', { name: record.instance.name }) }}</a-tag></div>
              <div v-if="record.detail" class="muted small">{{ record.detail }}</div>
            </template>
            <template v-else-if="column.key === 'model'">{{ record.model ?? '—' }}</template>
            <template v-else-if="column.key === 'region'">{{ record.region ?? '—' }}</template>
            <template v-else-if="column.key === 'power'">
              <a-tag v-if="record.on !== null" :color="record.on ? 'green' : 'default'">{{ record.on ? t('devices.ext.on') : t('devices.ext.off') }}</a-tag>
              <span v-else class="faint">—</span>
            </template>
          </template>
        </a-table>
      </a-form-item>
    </a-form>
    <template #footer>
      <div class="modal-footer">
        <span class="grow" />
        <a-button @click="createOpen = false">{{ t('common.cancel') }}</a-button>
        <a-button type="primary" :loading="creating" :disabled="!pickedPhones.length" @click="submitCreate">
          {{ t('devices.ext.addN', { n: pickedPhones.length }) }}
        </a-button>
      </div>
    </template>
  </a-modal>

  <a-modal v-model:open="srcEdit.open" :title="srcEdit.id ? t('devices.ext.editSource') : t('devices.ext.newSource')" :width="MODAL_WIDTH.sm">
    <a-form layout="vertical">
      <a-form-item :label="t('common.name')"><a-input v-model:value="srcEdit.name" :maxlength="60" /></a-form-item>
      <a-row :gutter="12">
        <a-col :xs="24" :sm="16"><a-form-item :label="t('devices.ext.host')"><a-input v-model:value="srcEdit.host" placeholder="127.0.0.1" /></a-form-item></a-col>
        <a-col :xs="24" :sm="8"><a-form-item :label="t('devices.ext.port')"><a-input-number v-model:value="srcEdit.port" :min="1" :max="65535" style="width: 100%" /></a-form-item></a-col>
      </a-row>
      <a-form-item :label="t('devices.ext.apiKey')" :extra="t('devices.ext.apiKeyHint')">
        <a-input-password v-model:value="srcEdit.apiKey" autocomplete="new-password" :disabled="srcEdit.clearKey"
          :placeholder="srcEdit.apiKeySet ? t('devices.ext.apiKeyKeep') : t('common.optional')" />
        <a-checkbox v-if="srcEdit.apiKeySet" v-model:checked="srcEdit.clearKey" style="margin-top: 8px">{{ t('devices.ext.apiKeyClear') }}</a-checkbox>
      </a-form-item>
      <a-form-item :label="t('devices.ext.timeZone')" :extra="t('devices.ext.timeZoneHint')" style="margin-bottom: 0">
        <a-select v-model:value="srcEdit.timeZone" allow-clear show-search :placeholder="t('devices.ext.timeZoneDefault')" :options="TIME_ZONES.map((z) => ({ value: z, label: z }))" />
      </a-form-item>
    </a-form>
    <template #footer>
      <div class="modal-footer">
        <a-button v-if="srcEdit.id" danger @click="deleteSource">{{ t('devices.ext.deleteSource') }}</a-button>
        <span class="grow" />
        <a-button @click="srcEdit.open = false">{{ t('common.cancel') }}</a-button>
        <a-button type="primary" :loading="srcEdit.saving" @click="saveSource">{{ t('devices.ext.saveTest') }}</a-button>
      </div>
    </template>
  </a-modal>

  <StoreInstallModal :instance-ids="storeIds" @close="storeIds = null" />

  <a-modal v-model:open="failedOpen" :title="t('devices.failedTitle')" :footer="null" :width="MODAL_WIDTH.lg">
    <a-table :data-source="failedTasks" :columns="failedColumns" row-key="id" size="small" :scroll="{ x: 640 }" :pagination="pagination({ defaultPageSize: 10, hideOnSinglePage: true })">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'time'">{{ fmtDateTime(record.createdAt) }}</template>
        <template v-else-if="column.key === 'device'">
          <a @click="failedOpen = false; router.push(deviceListLink(record.instanceId))">{{ store.byId.get(record.instanceId)?.name ?? record.instanceName }}</a>
        </template>
        <template v-else-if="column.key === 'type'">{{ taskText(record.type) }}</template>
        <template v-else-if="column.key === 'error'">
          <a-typography-text type="danger" :ellipsis="{ tooltip: record.error }" :content="record.error ?? '—'" />
        </template>
      </template>
    </a-table>
  </a-modal>

  <DeviceLogDrawer v-model:open="logOpen" :instance="logInstance" />
  <DeviceAssignModal v-model:open="assignOpen" :mode="assignMode" :instance-ids="assignIds" />
  <SyncFromDeviceModal v-model:open="syncOpen" :instance-id="syncId" @synced="onSynced" />
  <CloudPhoneDrawer v-if="phoneUsed" v-model:open="phoneOpen" :instance-id="phoneId" @menu="onMenu" @log="openLog" />
</template>

<style scoped>
.clickable { cursor: pointer; }
.grow { flex: 1; }
.modal-footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
/* grid view: optional device list on the left, screen cards on the right */
.body { display: flex; gap: var(--cp-gap); align-items: flex-start; }
.side {
  width: 260px; flex: none; border: 1px solid var(--cp-border-secondary); border-radius: var(--cp-radius-lg);
  position: sticky; top: 0; max-height: calc(100vh - 240px); display: flex; flex-direction: column;
}
.side-head { padding: 12px 16px; font-weight: 600; border-bottom: 1px solid var(--cp-border-secondary); }
.side-list { overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
.side-empty { padding: 24px 0; text-align: center; }
.item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid transparent; border-radius: var(--cp-radius); cursor: pointer; }
.item:hover { background: var(--cp-bg-hover); }
.item.active { border-color: var(--cp-primary); background: var(--cp-primary-bg); }
.item-main { flex: 1; min-width: 0; }
.grid { flex: 1; min-width: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: var(--cp-gap); align-items: start; }
.phone { display: flex; flex-direction: column; gap: 8px; padding: 8px; border: 1px solid var(--cp-border-secondary); border-radius: var(--cp-radius-lg); background: var(--cp-bg-container); min-width: 0; }
.phone.selected { border-color: var(--cp-primary); }
.phone.focus { border-color: var(--cp-primary); box-shadow: 0 0 0 2px var(--cp-primary-bg); }
.phone-owners { display: flex; align-items: center; min-width: 0; margin-top: -4px; }
:deep(.row-focus > td) { background: var(--cp-primary-bg) !important; }
.phone-head { display: flex; align-items: center; gap: 8px; }
.phone-actions { display: flex; flex-wrap: wrap; justify-content: center; }
.phone-name { flex: 1; font-weight: 600; }
.phone-screen { position: relative; cursor: pointer; border-radius: var(--cp-radius-lg); outline: none; }
.phone-screen:focus-visible { box-shadow: 0 0 0 2px var(--cp-primary); }
/* Overlays on the screenshot: dark mask in both themes, so the text stays white. */
.badges { position: absolute; top: 6px; left: 6px; right: 6px; display: flex; gap: 4px; flex-wrap: wrap; pointer-events: none; }
.badge { padding: 0 6px; border-radius: 4px; font-size: 11px; line-height: 18px; color: #fff; background: var(--cp-mask); }
.badge.bad { background: var(--cp-error); }
.hover { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; border-radius: var(--cp-radius-lg); background: var(--cp-mask); color: #fff; opacity: 0; transition: opacity 0.15s; }
.phone-screen:hover .hover, .phone-screen:focus-visible .hover { opacity: 1; }
.add { align-self: stretch; align-items: center; justify-content: center; gap: 12px; min-height: 320px; border-style: dashed; border-color: var(--cp-border); background: var(--cp-fill-alter); color: var(--cp-text-secondary); cursor: pointer; font: inherit; }
.add:hover { border-color: var(--cp-primary); color: var(--cp-primary); }
.add-icon { width: 36px; height: 36px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--cp-primary-bg); color: var(--cp-primary); font-size: 16px; }
.empty { grid-column: 1 / -1; padding: 40px 0; }
@media (max-width: 768px) {
  .side { display: none; }
  .grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
}
</style>
