<script setup lang="ts">
import { dateLocale } from '../i18n'
import { DownOutlined, ExclamationCircleOutlined, MenuFoldOutlined, MenuUnfoldOutlined, MoreOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons-vue'
import { message, Modal } from 'ant-design-vue'
import { computed, h, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import { useRoute, useRouter } from 'vue-router'
import { queryParam } from '../api/query'
import { BUSY_STATUSES, profileLabel, proxyLabel, taskText, type DeviceSource, type Instance, type InstanceOwner, type PoolProxy, type Profile, type SourcePhone, type Task } from '../api/types'
import CloudPhoneDrawer from '../components/CloudPhoneDrawer.vue'
import DeviceLogDrawer from '../components/DeviceLogDrawer.vue'
import DeviceThumb from '../components/DeviceThumb.vue'
import StatusTag from '../components/StatusTag.vue'
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
  { title: t('common.name'), dataIndex: 'name', key: 'name' },
  { title: t('devices.colImage'), key: 'profile', width: 190 },
  { title: t('common.status'), key: 'status', width: 110 },
  ...(auth.isAdmin ? [{ title: t('devices.colOwners'), key: 'owners', width: 200 }] : []),
  { title: t('common.device'), key: 'device', width: 220 },
  { title: t('devices.colNet'), key: 'net', width: 170 },
  { title: t('devices.colAdbPort'), dataIndex: 'adbPort', key: 'adbPort', width: 100 },
  { title: t('devices.colResolution'), key: 'spec', width: 140 },
  { title: '', key: 'ops', width: 170, align: 'right' as const },
])

// ---- status group filter (?status= from dashboard links) and owner filter (admin only)
type StatusGroup = 'running' | 'stopped' | 'busy' | 'error'
const statusFilter = ref<StatusGroup | undefined>(queryParam<StatusGroup>(useRoute().query, 'status', ['running', 'stopped', 'busy', 'error']))
const inGroup = (i: Instance, g: StatusGroup) => (g === 'busy' ? BUSY_STATUSES.includes(i.status) : i.status === g)
const ownerFilter = ref<InstanceOwner | null>(null)
// Search: name / id / phone id / image / proxy / egress IP; several terms separated by comma or space match any.
const search = ref('')
const terms = computed(() => search.value.toLowerCase().split(/[\s,，;；]+/).filter(Boolean))
function matches(i: Instance) {
  if (!terms.value.length) return true
  const hay = [i.name, i.id, i.externalId, profileName(i.profile), i.proxy && proxyLabel(i.proxy), i.proxy?.host, i.proxyStatus?.egressIp]
    .filter(Boolean).join(' ').toLowerCase()
  return terms.value.some((q) => hay.includes(q))
}
const rows = computed(() => {
  const f = ownerFilter.value
  const s = statusFilter.value
  return store.list.filter((i) => (!f || i.owners?.some((o) => o.id === f.id)) && (!s || inGroup(i, s)) && matches(i))
})
const statusOptions = computed(() => [
  { value: '', label: t('cloud.allPhones', { n: counts.value.total }) },
  { value: 'running', label: `${t('devices.running')} (${counts.value.running})` },
  { value: 'stopped', label: `${t('status.stopped')} (${counts.value.stopped})` },
  { value: 'busy', label: `${t('devices.busy')} (${counts.value.busy})` },
  { value: 'error', label: `${t('devices.error')} (${counts.value.error})` },
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
function readPref(): { view: 'grid' | 'table'; panel: boolean } {
  try { const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}'); return { view: p.view === 'table' ? 'table' : 'grid', panel: p.panel !== false } }
  catch { return { view: 'grid', panel: true } }
}
const pref = reactive(readPref())
watch(pref, (p) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)) } catch { /* private mode */ } })

// ---- slide-in remote control
const phoneOpen = ref(false)
const phoneId = ref<string | null>(null)
function openPhone(id: string) { phoneId.value = id; phoneOpen.value = true }
function filterByOwner(o: InstanceOwner) {
  ownerFilter.value = o
  const visible = new Set(rows.value.map((i) => i.id))
  selectedKeys.value = selectedKeys.value.filter((k) => visible.has(k))
}
const ownerName = (o: InstanceOwner) => o.displayName ? t('permissions.userLabel', { display: o.username, username: o.displayName }) : o.username

// ---- actions menu (row and batch)
type MenuKey = Action | 'install' | 'uninstall'
const isBusy = (i: Instance) => BUSY_STATUSES.includes(i.status)
/** Whether an action makes sense for this device's current status. */
function canDo(key: MenuKey, i: Instance) {
  if (isBusy(i)) return false
  if (key === 'start') return i.status !== 'running'
  if (key === 'stop' || key === 'restart') return i.status !== 'stopped'
  if (key === 'install' || key === 'uninstall') return i.status === 'running'
  return true
}
function onMenu(key: MenuKey, ids: string[]) {
  if (key === 'install' || key === 'uninstall') openApp(key, ids)
  else void run(key, ids)
}

async function run(action: Action, ids: string[]) {
  if (!ids.length) return
  const go = async () => {
    try {
      const r = await store.action(action, ids)
      if (r.accepted.length) message.success(t('devices.submitted', { n: r.accepted.length, action: actionText(action) }))
      if (r.skipped.length) message.warning(t('common.skipped', { n: r.skipped.length, reasons: [...new Set(r.skipped.map((s) => s.reason))].join(t('common.reasonSep')) }))
      if (action === 'delete') selectedKeys.value = selectedKeys.value.filter((k) => !ids.includes(k))
    } catch (e) {
      message.error(errorText(e))
    }
  }
  // Cloud phones (BitBrowser) are billed while on; external phones are only removed from the platform on delete.
  const sel = ids.map((id) => store.byId.get(id)).filter((i): i is Instance => !!i)
  const bitNames = sel.filter((i) => i.engine === 'bitbrowser').map((i) => i.name)
  const extCount = sel.filter((i) => i.sourceId).length
  const billed = (action === 'start' || action === 'restart') && bitNames.length > 0
  if (action === 'delete' || action === 'restart' || action === 'stop' || billed) {
    const names = ids.map((id) => store.byId.get(id)?.name).filter(Boolean)
    const notes = [
      billed ? t('devices.ext.billingList', { names: bitNames.join(t('common.listSep')) }) : '',
      action === 'delete' && extCount ? t('devices.ext.deleteNote') : '',
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

// ---- batch app install / uninstall
const appOpen = ref(false)
const appMode = ref<'install' | 'uninstall'>('install')
const appFile = ref<File | null>(null)
const appPkg = ref('')
const appBusy = ref(false)
const appIds = ref<string[]>([])
function openApp(mode: 'install' | 'uninstall', ids: string[]) {
  if (!ids.length) return
  appMode.value = mode; appIds.value = [...ids]; appFile.value = null; appPkg.value = ''; appOpen.value = true
}
function pickFile(f: File) { appFile.value = f; return false }
async function submitApp() {
  appBusy.value = true
  try {
    const r = appMode.value === 'install'
      ? await (appFile.value ? store.installApp(appIds.value, appFile.value) : Promise.reject(new Error(t('devices.chooseApk'))))
      : await (appPkg.value ? store.uninstallApp(appIds.value, appPkg.value.trim()) : Promise.reject(new Error(t('devices.enterPackage'))))
    message.success(t('devices.submittedTasks', { n: r.accepted.length }))
    if (r.skipped.length) message.warning(t('common.skipped', { n: r.skipped.length, reasons: [...new Set(r.skipped.map((x) => x.reason))].join(t('common.reasonSep')) }))
    appOpen.value = false
  } catch (e) { message.error(errorText(e)) }
  finally { appBusy.value = false }
}

// ---- create
const createOpen = ref(false)
const creating = ref(false)
const PRESETS = { '720x1280@320': [720, 1280, 320], '1080x1920@480': [1080, 1920, 480], '540x960@240': [540, 960, 240] } as const
const profiles = ref<Profile[]>([])
const profileName = (id: string) => {
  if (id === 'bitbrowser') return t('devices.ext.kinds.bitbrowser')
  const p = profiles.value.find((x) => x.id === id)
  return p ? profileLabel(p.id, p.label).split(/（| \(/)[0] : id
}
onMounted(async () => {
  try { profiles.value = (await api<{ profiles: Profile[] }>('GET', '/api/profiles')).profiles } catch { /* shown on create */ }
})
const TIMEZONES = Intl.supportedValuesOf('timeZone')
const LOCALES = ['zh-CN', 'zh-TW', 'zh-HK', 'en-US', 'en-GB', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES', 'pt-BR', 'ru-RU', 'ar-SA', 'th-TH', 'vi-VN', 'id-ID']
const form = reactive({ proxyMode: 'auto' as 'auto' | 'none' | 'pick', proxyIds: [] as string[], locale: undefined as string | undefined, timezone: undefined as string | undefined, deviceName: '', profile: 'redroid-13-gapps', count: 1, namePrefix: 'phone', preset: '720x1280@320' as keyof typeof PRESETS, memoryMb: undefined as number | undefined })
// Free pool proxies for the create form (each device gets its own proxy).
const freeProxies = ref<PoolProxy[]>([])
const freeUsable = computed(() => freeProxies.value.filter((p) => p.status !== 'failed').length)
async function openCreate() {
  createOpen.value = true
  form.proxyIds = []
  try {
    freeProxies.value = (await api<{ proxies: PoolProxy[] }>('GET', '/api/proxies?bound=free')).proxies
    if (form.proxyMode === 'auto' && !freeUsable.value) form.proxyMode = 'none'
  } catch (e) { freeProxies.value = []; message.error(errorText(e)) }
}
const proxyOption = (p: PoolProxy) => ({
  value: p.id,
  label: `${proxyLabel(p)} · ${p.type.toUpperCase()} ${p.host}:${p.port}${p.country ? ` · ${p.country}` : ''} · ${t(`proxies.statusText.${p.status}`)}`,
})
async function submitCreate() {
  if (kind.value !== 'local') return submitExternal()
  if (form.proxyMode === 'pick' && form.proxyIds.length !== form.count) { message.error(t('devices.form.proxyPickCount', { count: form.count })); return }
  if (form.proxyMode === 'auto' && freeUsable.value < form.count) { message.error(t('devices.form.proxyNotEnough', { need: form.count, free: freeUsable.value })); return }
  creating.value = true
  try {
    const [width, height, dpi] = PRESETS[form.preset]
    const r = await store.create({
      proxyMode: form.proxyMode, ...(form.proxyMode === 'pick' ? { proxyIds: form.proxyIds } : {}),
      ...(form.locale ? { locale: form.locale } : {}), ...(form.timezone ? { timezone: form.timezone } : {}), ...(form.deviceName ? { deviceName: form.deviceName } : {}),
      profile: form.profile, count: form.count, namePrefix: form.namePrefix, width, height, dpi, ...(form.memoryMb ? { memoryMb: form.memoryMb } : {}) })
    message.success(t('devices.submittedCreate', { names: r.instances.map((i) => i.name).join(t('common.listSep')) }))
    createOpen.value = false
  } catch (e) {
    message.error(errorText(e))
  } finally {
    creating.value = false
  }
}

// ---- external phones (device sources) in the same create dialog: nothing is powered on here
type DeviceKind = 'local' | DeviceSource['type']
const kind = ref<DeviceKind>('local')
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
watch(kind, (k) => { if (k !== 'local') void loadSources() })
watch(sourceId, () => void loadPhones())

// source editor: BitBrowser = the client's local API address (host + port)
const srcEdit = reactive({ open: false, id: null as string | null, name: '', host: '127.0.0.1', port: 54345, saving: false })
function editSource(s?: DeviceSource) {
  let host = '127.0.0.1'; let port = 54345
  if (s && typeof s.config.apiUrl === 'string') {
    try { const u = new URL(s.config.apiUrl); host = u.hostname; port = Number(u.port) || 80 } catch { /* keep defaults */ }
  }
  Object.assign(srcEdit, { open: true, id: s?.id ?? null, name: s?.name ?? t('devices.ext.defaultName'), host, port })
}
async function saveSource() {
  srcEdit.saving = true
  try {
    const body = { name: srcEdit.name.trim(), config: { apiUrl: `http://${srcEdit.host.trim()}:${srcEdit.port}` } }
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
  Modal.confirm({
    title: t('devices.ext.deleteSource'), okType: 'danger', okText: t('common.delete'), cancelText: t('common.cancel'),
    onOk: async () => {
      try { await api('DELETE', `/api/device-sources/${id}`); srcEdit.open = false; await loadSources() }
      catch (e) { message.error(errorText(e)) }
    },
  })
}
async function submitExternal() {
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
  if (!i.proxy) return ''
  const egress = i.proxyStatus?.egressIp ? t('devices.egress', { ip: i.proxyStatus.egressIp }) : ''
  const where = [i.proxy.country, i.proxy.city].filter(Boolean).join(' ')
  return `${i.proxy.type}://${i.proxy.host}:${i.proxy.port}${where ? ` · ${where}` : ''}${egress}`
}

function deviceText(i: Instance) {
  if (i.status !== 'running') return null
  return [
    { ok: i.bootCompleted, text: t('devices.sys') },
    { ok: i.adbState === 'device', text: 'ADB' },
    { ok: i.stfReady, text: 'STF' },
  ]
}

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
  <div class="cloud">
    <div class="toolbar">
      <a-tooltip :title="t('cloud.togglePanel')">
        <a-button type="text" :disabled="pref.view !== 'grid'" @click="pref.panel = !pref.panel"><MenuFoldOutlined v-if="pref.panel" /><MenuUnfoldOutlined v-else /></a-button>
      </a-tooltip>
      <a-tooltip :title="t('cloud.selectAll')">
        <a-checkbox :checked="allSelected" :indeterminate="someSelected" :disabled="!rows.length" @change="(e: any) => toggleAll(e.target.checked)" />
      </a-tooltip>
      <a-input v-model:value="search" allow-clear :placeholder="t('cloud.search')" class="search">
        <template #prefix><SearchOutlined class="muted" /></template>
      </a-input>
      <a-select :value="statusFilter ?? ''" :options="statusOptions" class="status" @change="(v: any) => (statusFilter = v || undefined)" />
      <a-dropdown :disabled="!selectedKeys.length" :trigger="['click']">
        <a-button :disabled="!selectedKeys.length">{{ selectedKeys.length ? t('devices.batchCount', { n: selectedKeys.length }) : t('devices.batch') }} <DownOutlined /></a-button>
        <template #overlay>
          <a-menu @click="({ key }: any) => onMenu(key as MenuKey, selectedKeys)">
            <a-menu-item key="start">{{ t('devices.start') }}</a-menu-item>
            <a-menu-item key="stop">{{ t('devices.stop') }}</a-menu-item>
            <a-menu-item key="restart">{{ t('devices.restart') }}</a-menu-item>
            <a-menu-item key="install">{{ t('devices.installApp') }}</a-menu-item>
            <a-menu-item key="uninstall">{{ t('devices.uninstallApp') }}</a-menu-item>
            <template v-if="auth.isAdmin">
              <a-menu-divider />
              <a-menu-item key="delete" danger>{{ t('devices.delete') }}</a-menu-item>
            </template>
          </a-menu>
        </template>
      </a-dropdown>
      <div class="grow" />
      <a-segmented v-model:value="pref.view" :options="[{ value: 'grid', label: t('cloud.viewGrid') }, { value: 'table', label: t('cloud.viewTable') }]" />
      <a-tooltip :title="t('common.refresh')"><a-button :loading="store.loading" @click="store.refresh()"><template #icon><ReloadOutlined /></template></a-button></a-tooltip>
      <a-button v-if="auth.isAdmin" type="primary" @click="openCreate"><template #icon><PlusOutlined /></template>{{ t('devices.createDevice') }}</a-button>
    </div>

    <a-alert v-if="showFailed" type="error" show-icon>
      <template #icon><ExclamationCircleOutlined /></template>
      <template #message>{{ t('devices.failedRecent', { n: failedTasks.length }) }}</template>
      <template #action>
        <a-space>
          <a-button size="small" type="link" @click="failedOpen = true">{{ t('common.view') }}</a-button>
          <a-button size="small" type="text" @click="dismissFailed">{{ t('common.ignore') }}</a-button>
        </a-space>
      </template>
    </a-alert>
    <div v-if="ownerFilter">
      <span class="muted" style="margin-right: 8px">{{ t('devices.filter') }}</span>
      <a-tag closable color="blue" @close="ownerFilter = null">{{ t('devices.ownerTag', { name: ownerFilter.username }) }}</a-tag>
    </div>

    <a-card v-if="pref.view === 'table'" size="small">
      <a-table
        :data-source="rows"
        :columns="columns"
        row-key="id"
        size="middle"
        :pagination="false"
        :scroll="{ x: auth.isAdmin ? 1200 : 1000 }"
        :row-selection="{ selectedRowKeys: selectedKeys, onChange: (k: any[]) => (selectedKeys = k as string[]) }"
        :locale="{ emptyText: auth.isAdmin ? t('devices.emptyAdmin') : t('devices.emptyUser') }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <a @click="openPhone(record.id)">{{ record.name }}</a>
          </template>
          <template v-else-if="column.key === 'profile'">
            <a-space :size="4">
              <span>{{ profileName(record.profile) }}</span>
              <a-tag v-if="record.google" :color="record.google.gms.running ? 'green' : 'orange'">GMS</a-tag>
            </a-space>
          </template>
          <template v-else-if="column.key === 'status'">
            <StatusTag :status="record.status" />
          </template>
          <template v-else-if="column.key === 'owners'">
            <span v-if="!record.owners?.length" class="faint">—</span>
            <a-tooltip v-else :title="record.owners.length > 3 ? record.owners.map(ownerName).join(t('common.listSep')) : undefined">
              <span>
                <a-tag v-for="o in record.owners.slice(0, 3)" :key="o.id" style="cursor: pointer" @click="filterByOwner(o)">{{ o.username }}</a-tag>
                <a-tag v-if="record.owners.length > 3">+{{ record.owners.length - 3 }}</a-tag>
              </span>
            </a-tooltip>
          </template>
          <template v-else-if="column.key === 'device'">
            <a-tooltip v-if="record.lastError" :title="record.lastError">
              <a-typography-text type="danger" :ellipsis="true" style="max-width: 200px">{{ record.lastError }}</a-typography-text>
            </a-tooltip>
            <a-space v-else-if="deviceText(record)" :size="4">
              <a-tag v-for="d in deviceText(record)" :key="d.text" :color="d.ok ? 'green' : 'orange'">{{ d.text }}</a-tag>
            </a-space>
            <span v-else class="faint">—</span>
          </template>
          <template v-else-if="column.key === 'net'">
            <a-tooltip v-if="record.proxy" :title="netTitle(record)">
              <a-tag :color="record.proxyStatus ? (record.proxyStatus.ok ? 'green' : 'red') : 'default'">{{ record.proxy.type.toUpperCase() }} {{ proxyLabel(record.proxy) }}</a-tag>
            </a-tooltip>
            <span v-else-if="record.sourceId" class="muted">{{ t('devices.ext.proxyShort') }}</span>
            <span v-else class="muted">{{ t('devices.direct') }}</span>
          </template>
          <template v-else-if="column.key === 'spec'">
            {{ record.spec.width }}×{{ record.spec.height }}
          </template>
          <template v-else-if="column.key === 'ops'">
            <a-space :size="0">
              <a-button size="small" type="link" :disabled="record.status !== 'running'" @click="openPhone(record.id)">{{ t('devices.control') }}</a-button>
              <a-button size="small" type="link" @click="openLog(record.id)">{{ t('devices.log') }}</a-button>
              <a-dropdown :trigger="['click']" placement="bottomRight">
                <a-button size="small" type="text"><MoreOutlined /></a-button>
                <template #overlay>
                  <a-menu @click="({ key }: any) => onMenu(key as MenuKey, [record.id])">
                    <a-menu-item key="start" :disabled="!canDo('start', record as Instance)">{{ t('devices.start') }}</a-menu-item>
                    <a-menu-item key="stop" :disabled="!canDo('stop', record as Instance)">{{ t('devices.stop') }}</a-menu-item>
                    <a-menu-item key="restart" :disabled="!canDo('restart', record as Instance)">{{ t('devices.restart') }}</a-menu-item>
                    <a-menu-item key="install" :disabled="!canDo('install', record as Instance)">{{ t('devices.installApp') }}</a-menu-item>
                    <a-menu-item key="uninstall" :disabled="!canDo('uninstall', record as Instance)">{{ t('devices.uninstallApp') }}</a-menu-item>
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
    </a-card>

    <div v-else class="body">
      <aside v-if="pref.panel" class="side">
        <div class="side-head">{{ statusOptions.find((o) => o.value === (statusFilter ?? ''))?.label }}</div>
        <div class="side-list">
          <div v-for="i in rows" :key="i.id" class="item" :class="{ active: phoneOpen && phoneId === i.id }" @click="openPhone(i.id)">
            <a-checkbox :checked="selectedKeys.includes(i.id)" @click.stop @change="(e: any) => toggleOne(i.id, e.target.checked)" />
            <div class="item-main">
              <div class="item-name">{{ i.name }}</div>
              <div class="item-sub">{{ i.sourceId ? t(`devices.ext.kinds.${i.engine}`) : profileName(i.profile) }}<template v-if="i.proxy"> · {{ i.proxy.country ?? proxyLabel(i.proxy) }}</template></div>
            </div>
            <StatusTag :status="i.status" />
          </div>
          <div v-if="!rows.length" class="side-empty muted">{{ store.list.length ? t('cloud.noMatch') : '—' }}</div>
        </div>
      </aside>

      <section class="grid">
        <div v-for="i in rows" :key="i.id" class="card" :class="{ selected: selectedKeys.includes(i.id) }">
          <div class="card-head">
            <a-checkbox :checked="selectedKeys.includes(i.id)" @change="(e: any) => toggleOne(i.id, e.target.checked)" />
            <span class="card-name" :title="i.name">{{ i.name }}</span>
            <a-dropdown :trigger="['click']" placement="bottomRight">
              <a-button size="small" type="text"><MoreOutlined /></a-button>
              <template #overlay>
                <a-menu @click="({ key }: any) => (key === 'log' ? openLog(i.id) : onMenu(key as MenuKey, [i.id]))">
                  <a-menu-item key="start" :disabled="!canDo('start', i)">{{ t('devices.start') }}</a-menu-item>
                  <a-menu-item key="stop" :disabled="!canDo('stop', i)">{{ t('devices.stop') }}</a-menu-item>
                  <a-menu-item key="restart" :disabled="!canDo('restart', i)">{{ t('devices.restart') }}</a-menu-item>
                  <a-menu-item key="install" :disabled="!canDo('install', i)">{{ t('devices.installApp') }}</a-menu-item>
                  <a-menu-item key="uninstall" :disabled="!canDo('uninstall', i)">{{ t('devices.uninstallApp') }}</a-menu-item>
                  <a-menu-item key="log">{{ t('devices.log') }}</a-menu-item>
                  <template v-if="auth.isAdmin">
                    <a-menu-divider />
                    <a-menu-item key="delete" danger :disabled="!canDo('delete', i)">{{ t('devices.delete') }}</a-menu-item>
                  </template>
                </a-menu>
              </template>
            </a-dropdown>
          </div>
          <div class="card-screen" role="button" tabindex="0" @click="openPhone(i.id)" @keydown.enter="openPhone(i.id)">
            <DeviceThumb :instance-id="i.id" :running="i.status === 'running'" :paused="phoneOpen" :slow="!!i.sourceId" :width="i.spec.width" :height="i.spec.height">
              <StatusTag :status="i.status" />
              <span v-if="i.lastError" class="err" :title="i.lastError">{{ i.lastError }}</span>
            </DeviceThumb>
            <div class="badges">
              <span class="badge">{{ i.sourceId ? t(`devices.ext.kinds.${i.engine}`) : profileName(i.profile) }}</span>
              <span v-if="i.proxy" class="badge" :class="{ bad: i.proxyStatus && !i.proxyStatus.ok }" :title="netTitle(i)">{{ i.proxy.country ?? i.proxy.type.toUpperCase() }}</span>
            </div>
            <div v-if="i.status === 'running'" class="hover"><span>{{ t('cloud.clickToControl') }}</span></div>
          </div>
        </div>

        <button v-if="auth.isAdmin" type="button" class="card add" @click="openCreate">
          <span class="add-icon"><PlusOutlined /></span>
          <span>{{ t('devices.createDevice') }}</span>
        </button>
        <div v-if="!rows.length && !auth.isAdmin" class="empty"><a-empty :description="store.list.length ? t('cloud.noMatch') : t('devices.emptyUser')" /></div>
      </section>
    </div>
  </div>

  <a-modal v-model:open="createOpen" :title="t('devices.createDevice')" :confirm-loading="creating" :ok-text="kind === 'local' ? t('common.create') : t('devices.ext.addN', { n: pickedPhones.length })" :cancel-text="t('common.cancel')" :width="kind === 'local' ? 520 : 760" @ok="submitCreate">
    <a-form-item :label="t('devices.ext.kind')" style="margin-bottom: 16px">
      <a-radio-group v-model:value="kind">
        <a-radio-button value="local">{{ t('devices.ext.kinds.local') }}</a-radio-button>
        <a-radio-button value="bitbrowser">{{ t('devices.ext.kinds.bitbrowser') }}</a-radio-button>
      </a-radio-group>
    </a-form-item>
    <template v-if="kind !== 'local'">
      <a-form layout="vertical">
        <a-form-item :label="t('devices.ext.source')" :extra="t('devices.ext.sourceHint')">
          <a-space wrap style="width: 100%">
            <a-select v-model:value="sourceId" :options="kindSources.map((s) => ({ value: s.id, label: `${s.name} · ${s.config.apiUrl ?? ''}` }))" :placeholder="t('devices.ext.noSource')" style="min-width: min(360px, 70vw)" />
            <a-button v-if="sourceId" size="small" @click="editSource(kindSources.find((s) => s.id === sourceId))">{{ t('common.edit') }}</a-button>
            <a-button size="small" type="dashed" @click="editSource()">{{ t('devices.ext.newSource') }}</a-button>
          </a-space>
        </a-form-item>
      </a-form>
      <div class="muted" style="margin-bottom: 8px">{{ t('devices.ext.addHint') }}</div>
      <a-table
        v-if="sourceId" :data-source="phones" :columns="phoneColumns" row-key="id" size="small" :loading="phonesLoading" :pagination="false" :scroll="{ x: 560, y: 320 }"
        :row-selection="{ selectedRowKeys: pickedPhones, onChange: (k: any[]) => (pickedPhones = k as string[]), getCheckboxProps: (r: SourcePhone) => ({ disabled: !!r.instance }) }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <div>{{ record.name }} <a-tag v-if="record.instance" color="blue">{{ t('devices.ext.alreadyAdded', { name: record.instance.name }) }}</a-tag></div>
            <div v-if="record.detail" class="muted" style="font-size: 12px">{{ record.detail }}</div>
          </template>
          <template v-else-if="column.key === 'model'">{{ record.model ?? '—' }}</template>
          <template v-else-if="column.key === 'region'">{{ record.region ?? '—' }}</template>
          <template v-else-if="column.key === 'power'">
            <a-tag v-if="record.on !== null" :color="record.on ? 'green' : 'default'">{{ record.on ? t('devices.ext.on') : t('devices.ext.off') }}</a-tag>
            <span v-else class="faint">—</span>
          </template>
        </template>
      </a-table>
    </template>
    <a-form v-else layout="vertical">
      <a-form-item :label="t('devices.colImage')">
        <a-select v-model:value="form.profile">
          <a-select-option v-for="p in profiles" :key="p.id" :value="p.id" :disabled="!p.available">
            {{ profileLabel(p.id, p.label) }}<span v-if="!p.available" class="muted">{{ t('devices.form.unavailable', { reason: p.reason ?? '' }) }}</span>
          </a-select-option>
        </a-select>
      </a-form-item>
      <a-form-item :label="t('devices.form.count')" :extra="t('devices.form.countHint')">
        <a-input-number v-model:value="form.count" :min="1" :max="20" style="width: 100%" />
      </a-form-item>
      <a-form-item :label="t('devices.form.proxy')"
        :extra="form.proxyMode === 'auto' ? t('devices.form.proxyAutoHint', { n: freeUsable }) : form.proxyMode === 'pick' ? t('devices.form.proxyPickHint', { count: form.count }) : t('devices.form.proxyNoneHint')">
        <a-radio-group v-model:value="form.proxyMode">
          <a-radio-button value="auto">{{ t('devices.form.proxyAuto') }}</a-radio-button>
          <a-radio-button value="pick">{{ t('devices.form.proxyPick') }}</a-radio-button>
          <a-radio-button value="none">{{ t('devices.form.proxyNone') }}</a-radio-button>
        </a-radio-group>
        <a-select
          v-if="form.proxyMode === 'pick'" v-model:value="form.proxyIds" mode="multiple" show-search option-filter-prop="label"
          :options="freeProxies.map(proxyOption)" :placeholder="t('devices.form.proxyPickPlaceholder')" style="margin-top: 8px; width: 100%"
          :status="form.proxyIds.length && form.proxyIds.length !== form.count ? 'warning' : undefined"
        />
      </a-form-item>
      <a-form-item :label="t('devices.form.prefix')" :extra="t('devices.form.prefixHint')">
        <a-input v-model:value="form.namePrefix" />
      </a-form-item>
      <a-form-item :label="t('devices.colResolution')">
        <a-select v-model:value="form.preset">
          <a-select-option v-for="(_, k) in PRESETS" :key="k" :value="k">{{ k }}</a-select-option>
        </a-select>
      </a-form-item>
      <a-row :gutter="12">
        <a-col :span="8"><a-form-item :label="t('devices.form.locale')"><a-select v-model:value="form.locale" allow-clear show-search :placeholder="t('common.default')" :options="LOCALES.map((l) => ({ value: l, label: l }))" /></a-form-item></a-col>
        <a-col :span="8"><a-form-item :label="t('devices.form.timezone')"><a-select v-model:value="form.timezone" allow-clear show-search :placeholder="t('common.default')" :options="TIMEZONES.map((z) => ({ value: z, label: z }))" /></a-form-item></a-col>
        <a-col :span="8"><a-form-item :label="t('devices.form.deviceName')"><a-input v-model:value="form.deviceName" :placeholder="t('common.optional')" :maxlength="40" /></a-form-item></a-col>
      </a-row>
      <a-form-item :label="t('devices.form.memory')">
        <a-input-number v-model:value="form.memoryMb" :min="1024" :max="16384" :step="512" :placeholder="t('devices.form.unlimited')" style="width: 100%" />
      </a-form-item>
    </a-form>
  </a-modal>

  <a-modal v-model:open="srcEdit.open" :title="srcEdit.id ? t('devices.ext.editSource') : t('devices.ext.newSource')" :confirm-loading="srcEdit.saving" :ok-text="t('devices.ext.saveTest')" :cancel-text="t('common.cancel')" @ok="saveSource">
    <a-form layout="vertical">
      <a-form-item :label="t('common.name')"><a-input v-model:value="srcEdit.name" :maxlength="60" /></a-form-item>
      <a-row :gutter="12">
        <a-col :span="16"><a-form-item :label="t('devices.ext.host')" :extra="t('devices.ext.hostHint')"><a-input v-model:value="srcEdit.host" placeholder="127.0.0.1" /></a-form-item></a-col>
        <a-col :span="8"><a-form-item :label="t('devices.ext.port')"><a-input-number v-model:value="srcEdit.port" :min="1" :max="65535" style="width: 100%" /></a-form-item></a-col>
      </a-row>
    </a-form>
    <a-button v-if="srcEdit.id" danger size="small" @click="deleteSource">{{ t('devices.ext.deleteSource') }}</a-button>
  </a-modal>

  <a-modal v-model:open="appOpen" :title="t('devices.appTitle', { mode: appMode === 'install' ? t('devices.installUpdate') : t('devices.uninstallApp'), target: appIds.length === 1 ? store.byId.get(appIds[0]!)?.name ?? '' : t('devices.nDevices', { n: appIds.length }) })" :confirm-loading="appBusy" :ok-text="appMode === 'install' ? t('common.install') : t('common.uninstall')" :cancel-text="t('common.cancel')" :ok-button-props="{ danger: appMode === 'uninstall' }" @ok="submitApp">
    <template v-if="appMode === 'install'">
      <a-upload-dragger accept=".apk,.apks,.xapk,.apkm,.zip" :multiple="false" :show-upload-list="false" :before-upload="pickFile as any">
        <p style="margin: 12px 0">{{ appFile ? t('devices.fileInfo', { name: appFile.name, size: (appFile.size / 1048576).toFixed(1) }) : t('devices.pickApk') }}</p>
      </a-upload-dragger>
      <div class="muted" style="font-size: 12px; margin-top: 8px">{{ t('devices.installHint') }}</div>
    </template>
    <a-input v-else v-model:value="appPkg" :placeholder="t('devices.packagePlaceholder')" />
  </a-modal>

  <a-modal v-model:open="failedOpen" :title="t('devices.failedTitle')" :footer="null" :width="760">
    <a-table :data-source="failedTasks" :columns="failedColumns" row-key="id" size="small" :pagination="{ pageSize: 10, size: 'small', hideOnSinglePage: true }">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'time'">{{ new Date(record.createdAt).toLocaleString(dateLocale()) }}</template>
        <template v-else-if="column.key === 'device'">
          <a @click="failedOpen = false; router.push(`/instances/${record.instanceId}`)">{{ store.byId.get(record.instanceId)?.name ?? record.instanceName }}</a>
        </template>
        <template v-else-if="column.key === 'type'">{{ taskText(record.type) }}</template>
        <template v-else-if="column.key === 'error'">
          <a-typography-text type="danger" :ellipsis="{ tooltip: record.error }" :content="record.error ?? '—'" />
        </template>
      </template>
    </a-table>
  </a-modal>

  <DeviceLogDrawer v-model:open="logOpen" :instance="logInstance" />
  <CloudPhoneDrawer v-model:open="phoneOpen" :instance-id="phoneId" :profile-name="profileName" @menu="onMenu" @log="openLog" />
</template>

<style scoped>
.cloud { display: flex; flex-direction: column; gap: 12px; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; background: var(--cp-bg-container); border-radius: 8px; }
.search { width: min(340px, 100%); }
.status { width: 150px; }
.grow { flex: 1; }
.body { display: flex; gap: 12px; align-items: flex-start; }
.side { width: 260px; flex: none; background: var(--cp-bg-container); border-radius: 8px; position: sticky; top: 12px; max-height: calc(100vh - 160px); display: flex; flex-direction: column; }
.side-head { padding: 12px 14px; font-weight: 600; border-bottom: 1px solid var(--cp-border-secondary); }
.side-list { overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.side-empty { padding: 24px 0; text-align: center; }
.item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--cp-border-secondary); border-radius: 8px; cursor: pointer; }
.item:hover { background: var(--cp-bg-hover); }
.item.active { border-color: var(--cp-primary); background: var(--cp-primary-bg); }
.item-main { flex: 1; min-width: 0; }
.item-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-sub { font-size: 12px; color: var(--cp-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grid { flex: 1; min-width: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; padding: 12px; background: var(--cp-bg-container); border-radius: 8px; align-items: start; }
.card { display: flex; flex-direction: column; gap: 8px; padding: 8px; border: 1px solid var(--cp-border-secondary); border-radius: 10px; background: var(--cp-bg-container); min-width: 0; }
.card.selected { border-color: var(--cp-primary); }
.card-head { display: flex; align-items: center; gap: 8px; }
.card-name { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-screen { position: relative; cursor: pointer; border-radius: 10px; outline: none; }
.card-screen:focus-visible { box-shadow: 0 0 0 2px var(--cp-primary); }
.badges { position: absolute; top: 6px; left: 6px; right: 6px; display: flex; gap: 4px; flex-wrap: wrap; pointer-events: none; }
.badge { padding: 0 6px; border-radius: 4px; font-size: 11px; line-height: 18px; color: #fff; background: rgba(0, 0, 0, 0.55); }
.badge.bad { background: var(--cp-error); }
.hover { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; border-radius: 10px; background: rgba(0, 0, 0, 0.35); color: #fff; opacity: 0; transition: opacity 0.15s; }
.card-screen:hover .hover, .card-screen:focus-visible .hover { opacity: 1; }
.err { color: var(--cp-error); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.add { align-self: stretch; align-items: center; justify-content: center; gap: 10px; min-height: 320px; border-style: dashed; background: var(--cp-fill-alter); color: var(--cp-text-secondary); cursor: pointer; font: inherit; }
.add:hover { border-color: var(--cp-primary); color: var(--cp-primary); }
.add-icon { width: 36px; height: 36px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--cp-primary-bg); color: var(--cp-primary); font-size: 16px; }
.empty { grid-column: 1 / -1; padding: 40px 0; }
@media (max-width: 768px) {
  .side { display: none; }
  .grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); padding: 8px; gap: 8px; }
  .status { width: 130px; }
}
.muted { color: var(--cp-text-tertiary); }
.faint { color: var(--cp-text-quaternary); }
</style>
