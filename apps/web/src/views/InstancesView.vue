<script setup lang="ts">
import { dateLocale } from '../i18n'
import { CheckCircleFilled, DownOutlined, ExclamationCircleOutlined, FacebookFilled, InboxOutlined, InstagramFilled, MenuFoldOutlined, MenuUnfoldOutlined, MoreOutlined, PlusOutlined, SearchOutlined, YoutubeFilled } from '@ant-design/icons-vue'
import { message, Modal } from 'ant-design-vue'
import { computed, h, onMounted, onUnmounted, reactive, ref, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../api/client'
import { useRoute, useRouter } from 'vue-router'
import { deviceListLink, queryParam } from '../api/query'
import { BUSY_STATUSES, canPower, egressGeo, profileLabel, proxyLabel, taskText, type DeviceAutomation, type DeviceSource, type Instance, type InstanceOwner, type LibraryApp, type ManagedUser, type PoolProxy, type Profile, type SourcePhone, type Task } from '../api/types'
import CloudPhoneDrawer from '../components/CloudPhoneDrawer.vue'
import DeviceAssignModal from '../components/DeviceAssignModal.vue'
import DeviceLogDrawer from '../components/DeviceLogDrawer.vue'
import DeviceState from '../components/DeviceState.vue'
import DeviceThumb from '../components/DeviceThumb.vue'
import BatchActions, { type BatchItem } from '../components/common/BatchActions.vue'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import SyncFromDeviceModal from '../components/social/SyncFromDeviceModal.vue'
import { actionColumn, confirmDanger, MODAL_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'
import { usePlatformsStore } from '../stores/platforms'

const store = useInstancesStore()
const auth = useAuthStore()
const platforms = usePlatformsStore()
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
  { title: t('devices.colImage'), key: 'profile', width: 190 },
  { title: t('common.status'), key: 'status', width: 170 },
  ...(auth.isAdmin ? [{ title: t('devices.colOwners'), key: 'owners', width: 200 }] : []),
  { title: t('devices.colNet'), key: 'net', width: 170 },
  { title: t('devices.colEgress'), key: 'egress', width: 170 },
  { title: t('devices.colAdbPort'), dataIndex: 'adbPort', key: 'adbPort', width: 100 },
  { title: t('devices.colResolution'), key: 'spec', width: 140 },
  actionColumn(190),
])

// ---- status group filter (?status= from dashboard links) and owner filter (admin only)
type StatusGroup = 'running' | 'stopped' | 'busy' | 'error'
const statusFilter = ref<StatusGroup | undefined>(queryParam<StatusGroup>(useRoute().query, 'status', ['running', 'stopped', 'busy', 'error']))
const inGroup = (i: Instance, g: StatusGroup) => (g === 'busy' ? BUSY_STATUSES.includes(i.status) : i.status === g)
const ownerFilter = ref<InstanceOwner | null>(null)
// ?id= from device-name links on other pages (deviceListLink): only that device, highlighted; never opens remote control.
const route = useRoute()
const focusId = ref<string | undefined>(queryParam(route.query, 'id'))
watch(() => route.query.id, () => { focusId.value = queryParam(route.query, 'id') })
function clearFocus() {
  focusId.value = undefined
  if (route.query.id) void router.replace({ query: { ...route.query, id: undefined } })
}
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
  const id = focusId.value
  return store.list.filter((i) => (!id || i.id === id) && (!f || i.owners?.some((o) => o.id === f.id)) && (!s || inGroup(i, s)) && matches(i))
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
/**
 * 我的云机 (every role; owner's menu list 2026-11-18). Non-admins: grid only, no side list, no selection / batch menu /
 * status filter, the name search only with more than 6 devices; per card only 远控, the status, 日志, 同步媒体号 and
 * 重启 / 启动 (local phones: 启动 while stopped, 重启 while running; external phones: none, admins power them).
 * Admins additionally create devices, bind proxies, assign users and have the full menu. The API's RBAC is unchanged.
 */
const view = computed(() => (auth.isAdmin ? pref.view : 'grid'))
const showSearch = computed(() => auth.isAdmin || store.list.length > 6)

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
/** Card line (admin): first two granted users, then "+N". */
const ownersShort = (list: InstanceOwner[]) =>
  list.slice(0, 2).map((o) => o.username).join(t('common.listSep')) + (list.length > 2 ? ` +${list.length - 2}` : '')

// ---- actions menu (row and batch)
type MenuKey = Action | 'install' | 'uninstall' | 'sync' | 'assign' | 'assign-add' | 'assign-remove'
const isBusy = (i: Instance) => BUSY_STATUSES.includes(i.status)
/** Whether an action makes sense for this device's current status. */
function canDo(key: MenuKey, i: Instance) {
  if (isBusy(i)) return false
  if ((key === 'start' || key === 'stop' || key === 'restart') && !canPower(i, auth.isAdmin)) return false
  if (key === 'start') return i.status !== 'running'
  if (key === 'stop' || key === 'restart') return i.status !== 'stopped'
  if (key === 'install' || key === 'uninstall' || key === 'sync') return i.status === 'running'
  return true
}
/** 批量操作 menu; confirmations (delete/stop/restart, billed power-on) stay in run(). */
const batchItems = computed<BatchItem[]>(() => [
  { key: 'start', label: t('devices.start') },
  { key: 'stop', label: t('devices.stop') },
  { key: 'restart', label: t('devices.restart') },
  { key: 'install', label: t('devices.installApp') },
  { key: 'uninstall', label: t('devices.uninstallApp') },
  ...(auth.isAdmin ? [
    { key: 'assign-add', label: t('permissions.addToSelected') },
    { key: 'assign-remove', label: t('permissions.removeFromSelected') },
    { key: 'delete', label: t('devices.delete'), danger: true },
  ] : []),
])
function onMenu(key: MenuKey, ids: string[]) {
  if (key === 'assign' || key === 'assign-add' || key === 'assign-remove') openAssign(key === 'assign' ? 'set' : key === 'assign-add' ? 'add' : 'remove', ids)
  else if (key === 'sync') void openSync(ids[0]!)
  else if (key === 'install' || key === 'uninstall') openApp(key, ids)
  else void run(key, ids)
}

// ---- 分配 (admin; moved from the former 权限管理 page): one device's users, or add / remove users on the selection.
const assignOpen = ref(false)
const assignMode = ref<'set' | 'add' | 'remove'>('set')
const assignIds = ref<string[]>([])
function openAssign(mode: 'set' | 'add' | 'remove', ids: string[]) {
  if (!ids.length) return
  assignMode.value = mode; assignIds.value = [...ids]; assignOpen.value = true
}

// ---- 同步媒体号: the shared 从云手机同步 dialog (POST /api/social/sync-from-device) with this device preselected;
// admins also pick the account's owner there.
const syncOpen = ref(false)
const syncId = ref<string | undefined>()
const syncUsers = ref<ManagedUser[]>([])
async function openSync(id: string) {
  syncId.value = id
  syncOpen.value = true
  if (auth.isAdmin && !syncUsers.value.length) {
    try { syncUsers.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users } catch { /* owner = the admin */ }
  }
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
/** Version chip text; the image (GMS or not) is in the chip's tag and tooltip. */
const androidLabel = (p: Profile) => p.android ? `Android ${p.android}` : t('devices.form.emulator')

/*
 * Apps to install on the new devices, from the app library (official APKs imported from a device).
 * Only these platforms are offered (when enabled); each is greyed out until the library holds its package.
 * Initially picked: the ones flagged for preinstall in the library.
 */
const RECOMMENDED: { key: string; name: string; pkgs: string[]; icon: Component }[] = [
  { key: 'instagram', name: 'Instagram', pkgs: ['com.instagram.android'], icon: InstagramFilled },
  { key: 'youtube', name: 'YouTube', pkgs: ['com.google.android.youtube'], icon: YoutubeFilled },
  { key: 'facebook', name: 'Facebook', pkgs: ['com.facebook.katana', 'com.facebook.lite'], icon: FacebookFilled },
]
const libApps = ref<LibraryApp[]>([])
const pickedApps = ref<string[]>([])
const appTiles = computed(() => {
  const latest = new Map<string, LibraryApp>() // the API lists newest first per package
  for (const a of libApps.value) if (!latest.has(a.package)) latest.set(a.package, a)
  return RECOMMENDED.filter((r) => platforms.isEnabled(r.key)).map((r) => {
    const pkg = r.pkgs.find((p) => latest.has(p))
    return { key: r.key, name: r.name, icon: r.icon, app: pkg ? latest.get(pkg)! : null }
  })
})
function toggleApp(a: LibraryApp | null) {
  if (!a) return
  pickedApps.value = pickedApps.value.includes(a.id) ? pickedApps.value.filter((x) => x !== a.id) : [...pickedApps.value, a.id]
}
async function loadLibrary() {
  try {
    libApps.value = (await api<{ apps: LibraryApp[] }>('GET', '/api/library')).apps
    pickedApps.value = appTiles.value.flatMap((x) => (x.app?.preinstall ? [x.app.id] : []))
  } catch (e) { libApps.value = []; pickedApps.value = []; message.error(errorText(e)) }
}

async function openCreate() {
  createOpen.value = true
  form.proxyIds = []
  if (!profiles.value.find((p) => p.id === form.profile)?.available) form.profile = profiles.value.find((p) => p.available)?.id ?? form.profile
  void loadLibrary()
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
      profile: form.profile, count: form.count, namePrefix: form.namePrefix, width, height, dpi, ...(form.memoryMb ? { memoryMb: form.memoryMb } : {}),
      appIds: pickedApps.value })
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
  const s = i.proxyStatus
  const egress = s?.egressIp ? t('devices.egress', { ip: s.egressIp }) + (egressGeo(s) ? ` (${egressGeo(s)})` : '') : ''
  if (!i.proxy) return i.sourceId ? `${t('devices.ext.proxyShort')}${egress}` : ''
  const where = [i.proxy.country, i.proxy.city].filter(Boolean).join(' ')
  return `${i.proxy.type}://${i.proxy.host}:${i.proxy.port}${where ? ` · ${where}` : ''}${egress}`
}
/** Country for the compact badges: measured egress first, else the one configured on the pool proxy. */
const countryOf = (i: Instance) => i.proxyStatus?.country ?? i.proxy?.country ?? null

// ---- automation state (风控暂停 / busy) of the visible devices, for the one status per device (DeviceState)
const automation = ref<Record<string, DeviceAutomation>>({})
async function loadAutomation() {
  try { automation.value = (await api<{ devices: Record<string, DeviceAutomation> }>('GET', '/api/instances/automation')).devices } catch { /* status without it */ }
}
void loadAutomation()
const automationTimer = setInterval(() => { if (!document.hidden) void loadAutomation() }, 10_000)
onUnmounted(() => clearInterval(automationTimer))

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
        :scroll="{ x: auth.isAdmin ? 1500 : 1300 }"
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
          <template v-else-if="column.key === 'profile'">
            <a-space :size="4">
              <span>{{ profileName(record.profile) }}</span>
              <a-tag v-if="record.google" :color="record.google.gms.running ? 'green' : 'orange'">GMS</a-tag>
            </a-space>
          </template>
          <template v-else-if="column.key === 'status'">
            <DeviceState :instance="record as Instance" :automation="automation[record.id]" :resumable="auth.isAdmin" :admin="auth.isAdmin" @resumed="loadAutomation" />
          </template>
          <template v-else-if="column.key === 'owners'">
            <span v-if="!record.owners?.length" class="faint">{{ t('devices.unassigned') }}</span>
            <a-tooltip v-else :title="record.owners.length > 3 ? record.owners.map(ownerName).join(t('common.listSep')) : undefined">
              <span>
                <a-tag v-for="o in record.owners.slice(0, 3)" :key="o.id" class="clickable" @click="filterByOwner(o)">{{ o.username }}</a-tag>
                <a-tag v-if="record.owners.length > 3">+{{ record.owners.length - 3 }}</a-tag>
              </span>
            </a-tooltip>
          </template>
          <template v-else-if="column.key === 'net'">
            <a-tooltip v-if="record.proxy" :title="netTitle(record)">
              <a-tag :color="record.proxyStatus ? (record.proxyStatus.ok ? 'green' : 'red') : 'default'">{{ record.proxy.type.toUpperCase() }} {{ proxyLabel(record.proxy) }}</a-tag>
            </a-tooltip>
            <span v-else-if="record.sourceId" class="muted">{{ t('devices.ext.proxyShort') }}</span>
            <span v-else class="muted">{{ t('devices.direct') }}</span>
          </template>
          <template v-else-if="column.key === 'egress'">
            <a-tooltip v-if="record.proxyStatus" :title="[egressGeo(record.proxyStatus), record.proxyStatus.error, new Date(record.proxyStatus.checkedAt).toLocaleString(dateLocale())].filter(Boolean).join(' · ')">
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
                    <a-menu-item key="install" :disabled="!canDo('install', record as Instance)">{{ t('devices.installApp') }}</a-menu-item>
                    <a-menu-item key="uninstall" :disabled="!canDo('uninstall', record as Instance)">{{ t('devices.uninstallApp') }}</a-menu-item>
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
                <div class="ellipsis muted small">{{ i.sourceId ? t(`devices.ext.kinds.${i.engine}`) : profileName(i.profile) }}<template v-if="countryOf(i) || i.proxy"> · {{ countryOf(i) ?? proxyLabel(i.proxy!) }}</template></div>
              </div>
              <DeviceState :instance="i" :automation="automation[i.id]" />
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
                    <a-menu-item key="install" :disabled="!canDo('install', i)">{{ t('devices.installApp') }}</a-menu-item>
                    <a-menu-item key="uninstall" :disabled="!canDo('uninstall', i)">{{ t('devices.uninstallApp') }}</a-menu-item>
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
            <div v-if="auth.isAdmin && i.owners" class="phone-owners small">
              <span v-if="!i.owners.length" class="faint">{{ t('devices.unassigned') }}</span>
              <a-popover v-else :trigger="['hover', 'click']" :title="t('devices.colOwners')">
                <template #content>
                  <div v-for="o in i.owners" :key="o.id"><a @click="filterByOwner(o)">{{ ownerName(o) }}</a></div>
                </template>
                <span class="ellipsis muted clickable">{{ ownersShort(i.owners) }}</span>
              </a-popover>
              <a class="assign-link" @click="openAssign('set', [i.id])">{{ t('permissions.assign') }}</a>
            </div>
            <div class="phone-screen" role="button" tabindex="0" @click="openPhone(i.id)" @keydown.enter="openPhone(i.id)">
              <DeviceThumb :instance-id="i.id" :running="i.status === 'running'" :paused="phoneOpen" :slow="!!i.sourceId" :width="i.spec.width" :height="i.spec.height">
                <DeviceState :instance="i" :automation="automation[i.id]" :resumable="auth.isAdmin" :admin="auth.isAdmin" @resumed="loadAutomation" />
              </DeviceThumb>
              <div class="badges">
                <span class="badge">{{ i.sourceId ? t(`devices.ext.kinds.${i.engine}`) : profileName(i.profile) }}</span>
                <span v-if="i.proxy || countryOf(i)" class="badge" :class="{ bad: i.proxyStatus && !i.proxyStatus.ok }" :title="netTitle(i)">{{ countryOf(i) ?? i.proxy!.type.toUpperCase() }}</span>
              </div>
              <div v-if="i.status === 'running'" class="hover"><span>{{ t('cloud.clickToControl') }}</span></div>
            </div>
            <div v-if="!auth.isAdmin" class="phone-actions">
              <a-button size="small" type="link" :disabled="i.status !== 'running'" @click="openPhone(i.id)">{{ t('devices.control') }}</a-button>
              <a-button size="small" type="link" @click="openLog(i.id)">{{ t('devices.log') }}</a-button>
              <a-tooltip :title="t('devices.syncAccountsHint')">
                <a-button size="small" type="link" :disabled="!canDo('sync', i)" @click="openSync(i.id)">{{ t('devices.syncAccounts') }}</a-button>
              </a-tooltip>
              <template v-if="canPower(i, false) && !isBusy(i)">
                <a-button v-if="i.status === 'running'" size="small" type="link" @click="run('restart', [i.id])">{{ t('devices.restart') }}</a-button>
                <a-button v-else-if="i.status === 'stopped' || i.status === 'error'" size="small" type="link" @click="run('start', [i.id])">{{ t('devices.start') }}</a-button>
              </template>
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
      <a-form-item :label="t('devices.ext.kind')">
        <a-radio-group v-model:value="kind" button-style="solid">
          <a-radio-button value="local">{{ t('devices.ext.kinds.local') }}</a-radio-button>
          <a-radio-button value="bitbrowser">{{ t('devices.ext.kinds.bitbrowser') }}</a-radio-button>
        </a-radio-group>
      </a-form-item>
      <template v-if="kind !== 'local'">
        <a-form-item :label="t('devices.ext.source')">
          <a-space wrap style="width: 100%">
            <a-select v-model:value="sourceId" :options="kindSources.map((s) => ({ value: s.id, label: `${s.name} · ${s.config.apiUrl ?? ''}` }))" :placeholder="t('devices.ext.noSource')" style="width: 360px; max-width: 100%" />
            <a-button v-if="sourceId" @click="editSource(kindSources.find((s) => s.id === sourceId))">{{ t('common.edit') }}</a-button>
            <a-button type="dashed" @click="editSource()"><template #icon><PlusOutlined /></template>{{ t('devices.ext.newSource') }}</a-button>
            <a-tooltip v-if="selectedSource?.health && selectedSource.health.ok !== null"
              :title="selectedSource.health.ok ? t('devices.ext.healthOkTip', { at: selectedSource.health.lastOkAt ? new Date(selectedSource.health.lastOkAt).toLocaleString(dateLocale()) : '—' }) : t('devices.ext.healthDownTip', { since: selectedSource.health.failingSince ? new Date(selectedSource.health.failingSince).toLocaleString(dateLocale()) : '—', error: selectedSource.health.lastError ?? '' })">
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
      </template>
      <template v-else>
        <a-form-item :label="t('devices.form.android')">
          <div class="chips">
            <a-tooltip v-for="p in profiles" :key="p.id" :title="p.available ? profileLabel(p.id, p.label) : t('devices.form.unavailable', { reason: p.reason ?? '' })">
              <button type="button" class="chip" :class="{ active: form.profile === p.id }" :disabled="!p.available" @click="form.profile = p.id">
                {{ androidLabel(p) }}<span v-if="p.gapps" class="chip-tag">GMS</span>
              </button>
            </a-tooltip>
          </div>
        </a-form-item>
        <a-form-item :label="t('devices.form.apps')">
          <div class="chips">
            <a-tooltip v-for="a in appTiles" :key="a.key" :title="a.app ? `${a.app.package} ${a.app.versionName ?? a.app.versionCode}` : t('devices.form.appMissing', { name: a.name })">
              <button type="button" class="app-tile" :class="{ active: a.app && pickedApps.includes(a.app.id) }" :disabled="!a.app" @click="toggleApp(a.app)">
                <span class="app-icon"><component :is="a.icon" /></span>
                <span class="app-name ellipsis">{{ a.name }}</span>
                <CheckCircleFilled v-if="a.app && pickedApps.includes(a.app.id)" class="app-tick" />
              </button>
            </a-tooltip>
          </div>
        </a-form-item>
        <a-form-item :label="t('devices.form.proxyIp')" :extra="form.proxyMode === 'pick' ? t('devices.form.proxyPickHint', { count: form.count }) : undefined">
          <a-select v-model:value="form.proxyMode" style="width: 260px; max-width: 100%" :options="[
            { value: 'none', label: t('devices.form.proxyNoneOpt') },
            { value: 'auto', label: t('devices.form.proxyAutoOpt', { n: freeUsable }), disabled: !freeUsable },
            { value: 'pick', label: t('devices.form.proxyPickOpt'), disabled: !freeProxies.length },
          ]" />
          <a-select
            v-if="form.proxyMode === 'pick'" v-model:value="form.proxyIds" mode="multiple" show-search option-filter-prop="label"
            :options="freeProxies.map(proxyOption)" :placeholder="t('devices.form.proxyPickPlaceholder')" style="margin-top: 8px; width: 100%"
            :status="form.proxyIds.length && form.proxyIds.length !== form.count ? 'warning' : undefined"
          />
        </a-form-item>
        <a-collapse ghost class="more">
          <a-collapse-panel key="more" :header="t('devices.form.more')">
            <a-row :gutter="12">
              <a-col :xs="24" :sm="12"><a-form-item :label="t('devices.form.prefix')" :extra="t('devices.form.prefixHint')"><a-input v-model:value="form.namePrefix" /></a-form-item></a-col>
              <a-col :xs="24" :sm="12">
                <a-form-item :label="t('devices.colResolution')">
                  <a-select v-model:value="form.preset">
                    <a-select-option v-for="(_, k) in PRESETS" :key="k" :value="k">{{ k }}</a-select-option>
                  </a-select>
                </a-form-item>
              </a-col>
            </a-row>
            <a-row :gutter="12">
              <a-col :xs="24" :sm="8"><a-form-item :label="t('devices.form.locale')"><a-select v-model:value="form.locale" allow-clear show-search :placeholder="t('common.default')" :options="LOCALES.map((l) => ({ value: l, label: l }))" /></a-form-item></a-col>
              <a-col :xs="24" :sm="8"><a-form-item :label="t('devices.form.timezone')"><a-select v-model:value="form.timezone" allow-clear show-search :placeholder="t('common.default')" :options="TIMEZONES.map((z) => ({ value: z, label: z }))" /></a-form-item></a-col>
              <a-col :xs="24" :sm="8"><a-form-item :label="t('devices.form.deviceName')"><a-input v-model:value="form.deviceName" :placeholder="t('common.optional')" :maxlength="40" /></a-form-item></a-col>
            </a-row>
            <a-form-item :label="t('devices.form.memory')" style="margin-bottom: 0">
              <a-input-number v-model:value="form.memoryMb" :min="1024" :max="16384" :step="512" :placeholder="t('devices.form.unlimited')" style="width: 220px; max-width: 100%" />
            </a-form-item>
          </a-collapse-panel>
        </a-collapse>
      </template>
    </a-form>
    <template #footer>
      <div class="modal-footer">
        <a-space v-if="kind === 'local'" :size="8">
          <span>{{ t('devices.form.count') }}</span>
          <a-tooltip :title="t('devices.form.countHint')"><a-input-number v-model:value="form.count" :min="1" :max="20" style="width: 100px" /></a-tooltip>
        </a-space>
        <span class="grow" />
        <a-button @click="createOpen = false">{{ t('common.cancel') }}</a-button>
        <a-button type="primary" :loading="creating" :disabled="kind !== 'local' && !pickedPhones.length" @click="submitCreate">
          {{ kind === 'local' ? t('devices.form.confirmCreate') : t('devices.ext.addN', { n: pickedPhones.length }) }}
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

  <a-modal v-model:open="appOpen" :width="MODAL_WIDTH.sm" :title="t('devices.appTitle', { mode: appMode === 'install' ? t('devices.installUpdate') : t('devices.uninstallApp'), target: appIds.length === 1 ? store.byId.get(appIds[0]!)?.name ?? '' : t('devices.nDevices', { n: appIds.length }) })" :confirm-loading="appBusy" :ok-text="appMode === 'install' ? t('common.install') : t('common.uninstall')" :cancel-text="t('common.cancel')" :ok-button-props="{ danger: appMode === 'uninstall' }" @ok="submitApp">
    <template v-if="appMode === 'install'">
      <a-upload-dragger accept=".apk,.apks,.xapk,.apkm,.zip" :multiple="false" :show-upload-list="false" :before-upload="pickFile as any">
        <p class="ant-upload-drag-icon"><InboxOutlined /></p>
        <p class="ant-upload-text">{{ appFile ? t('devices.fileInfo', { name: appFile.name, size: (appFile.size / 1048576).toFixed(1) }) : t('devices.pickApk') }}</p>
        <p class="ant-upload-hint">{{ t('devices.installHint') }}</p>
      </a-upload-dragger>
    </template>
    <a-input v-else v-model:value="appPkg" :placeholder="t('devices.packagePlaceholder')" />
  </a-modal>

  <a-modal v-model:open="failedOpen" :title="t('devices.failedTitle')" :footer="null" :width="MODAL_WIDTH.lg">
    <a-table :data-source="failedTasks" :columns="failedColumns" row-key="id" size="small" :scroll="{ x: 640 }" :pagination="pagination({ defaultPageSize: 10, hideOnSinglePage: true })">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'time'">{{ new Date(record.createdAt).toLocaleString(dateLocale()) }}</template>
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
  <SyncFromDeviceModal v-model:open="syncOpen" :users="syncUsers" :instance-id="syncId" @synced="onSynced" />
  <CloudPhoneDrawer v-model:open="phoneOpen" :instance-id="phoneId" :profile-name="profileName" @menu="onMenu" @log="openLog" />
</template>

<style scoped>
.clickable { cursor: pointer; }
.grow { flex: 1; }
.modal-footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
/* create dialog: Android version chips and preinstall app tiles */
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip, .app-tile {
  border: 1px solid var(--cp-border); border-radius: var(--cp-radius-lg); background: var(--cp-bg-container); color: var(--cp-text);
  cursor: pointer; font: inherit;
}
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 16px; }
.chip:hover:not(:disabled), .app-tile:hover:not(:disabled) { border-color: var(--cp-primary); }
.chip.active, .app-tile.active { border-color: var(--cp-primary); color: var(--cp-primary); background: var(--cp-primary-bg); }
.chip:disabled, .app-tile:disabled { cursor: not-allowed; color: var(--cp-text-quaternary); background: var(--cp-fill-alter); }
.chip-tag { font-size: 11px; padding: 0 4px; border-radius: 4px; border: 1px solid currentColor; opacity: 0.8; }
.app-tile { position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; width: 76px; padding: 8px 4px 6px; }
.app-icon { width: 32px; height: 32px; border-radius: var(--cp-radius-lg); display: flex; align-items: center; justify-content: center; font-size: 20px; background: var(--cp-fill-alter); }
.app-name { font-size: 12px; max-width: 100%; }
.app-tick { position: absolute; top: 4px; right: 4px; font-size: 12px; }
.app-tile:disabled .app-icon { opacity: 0.5; }
.more { margin: 0 -16px; }
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
.phone-owners { display: flex; align-items: center; gap: 6px; min-width: 0; margin-top: -4px; }
.assign-link { flex: none; margin-inline-start: auto; }
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
