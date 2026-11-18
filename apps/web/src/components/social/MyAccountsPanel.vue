<script setup lang="ts">
import { countryName } from '../../api/lang'
import { dateLocale } from '../../i18n'
import { ExclamationCircleOutlined, PlusOutlined, SyncOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Rule } from 'ant-design-vue/es/form'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { deviceListLink, queryParam } from '../../api/query'
import { api, codeText, errorText } from '../../api/client'
import {
  SOCIAL_ACCOUNT_STATUSES, SOCIAL_LOGIN_STATUSES,
  type ManagedUser, type Persona, type SocialAccount, type Task, type SocialAccountLog, type SocialAccountStatus, type SocialLoginStatus, type SocialPlatform,
} from '../../api/types'
import BatchActions, { type BatchItem } from '../common/BatchActions.vue'
import BatchFormModal from '../common/BatchFormModal.vue'
import SearchBar from '../common/SearchBar.vue'
import StatusTag from '../common/StatusTag.vue'
import { actionColumn, confirmAction, confirmDanger, DRAWER_WIDTH, pagination, TABLE_SIZE } from '../common/ui'
import LangSelect from '../common/LangSelect.vue'
import { langName } from '../../api/lang'
import PlatformTag from './PlatformTag.vue'
import AccountAiDrafts from './AccountAiDrafts.vue'
import SocialAccountFeedDrawer from '../feed/SocialAccountFeedDrawer.vue'
import SyncFromDeviceModal from './SyncFromDeviceModal.vue'
import { useAuthStore } from '../../stores/auth'
import { useInstancesStore } from '../../stores/instances'

/**
 * 媒体管理 → 我的媒体号: the operator's own accounts (人设, status, 配置语系, 从云手机同步, detail drawer). The page's header
 * actions are teleported into `extraTo` (the page header of SocialAccountsView) while this tab is shown.
 */
defineProps<{ extraTo?: string }>()
const { t, te } = useI18n()
const auth = useAuthStore()
const store = useInstancesStore()
const route = useRoute()
const router = useRouter()

const platforms = ref<SocialPlatform[]>([])
const allTags = ref<string[]>([])
/** 账号人设 options: public personas + personal ones (own; admins: every user's). */
const personas = ref<Persona[]>([])
const users = ref<ManagedUser[]>([])
const items = ref<SocialAccount[]>([])
const total = ref(0)
const loading = ref(false)
const selectedKeys = ref<string[]>([])
const page = reactive({ current: 1, pageSize: 20 })

const filters = reactive({
  q: queryParam(route.query, 'q') ?? '',
  platform: queryParam(route.query, 'platform'),
  personaId: queryParam(route.query, 'personaId'),
  lang: queryParam(route.query, 'lang'),
  loginStatus: queryParam<SocialLoginStatus>(route.query, 'loginStatus', ['unknown', 'logged_in', 'logged_out', 'needs_verification']),
  accountStatus: queryParam<SocialAccountStatus>(route.query, 'accountStatus', ['active', 'limited', 'suspended', 'disabled']),
  exception: queryParam(route.query, 'exception') === '1',
  tags: [] as string[],
  ownerId: undefined as string | undefined,
  instanceId: (typeof route.query.instanceId === 'string' ? route.query.instanceId : undefined) as string | undefined,
})

const platformName = (id: string) => platforms.value.find((p) => p.id === id)?.name ?? id
const loginText = (s: SocialLoginStatus) => t(`social.login.${s}`)
const accountText = (s: SocialAccountStatus) => t(`social.account.${s}`)
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')

async function loadMeta() {
  try {
    const [p, tg, pub, own, langs] = await Promise.all([
      api<{ platforms: SocialPlatform[] }>('GET', '/api/social/platforms'),
      api<{ tags: string[] }>('GET', '/api/social/tags'),
      api<{ personas: Persona[] }>('GET', '/api/personas?scope=public'),
      api<{ personas: Persona[] }>('GET', `/api/personas?scope=${auth.isAdmin ? 'all-users' : 'mine'}`),
      api<{ configured: string[] }>('GET', '/api/contents/languages'),
    ])
    accountLangs.value = langs.configured
    platforms.value = p.platforms
    allTags.value = tg.tags
    personas.value = [...pub.personas, ...own.personas]
    if (auth.isAdmin && !users.value.length) users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users
  } catch (e) { message.error(errorText(e)) }
}

async function load() {
  loading.value = true
  try {
    const p = new URLSearchParams({ page: String(page.current), pageSize: String(page.pageSize) })
    if (filters.q.trim()) p.set('q', filters.q.trim())
    for (const k of ['platform', 'personaId', 'lang', 'loginStatus', 'accountStatus', 'ownerId', 'instanceId'] as const) if (filters[k]) p.set(k, filters[k]!)
    if (filters.exception) p.set('exception', 'true')
    if (filters.tags.length) p.set('tags', filters.tags.join(','))
    const r = await api<{ items: SocialAccount[]; total: number }>('GET', `/api/social/accounts?${p}`)
    items.value = r.items
    total.value = r.total
    loaded.value = true
    const ids = new Set(r.items.map((x) => x.id))
    selectedKeys.value = selectedKeys.value.filter((k) => ids.has(k))
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
function search() { page.current = 1; void load() }
function reset() {
  Object.assign(filters, { q: '', platform: undefined, personaId: undefined, lang: undefined, loginStatus: undefined, accountStatus: undefined, exception: false, tags: [], ownerId: undefined, instanceId: undefined })
  if (route.query.instanceId) void router.replace({ query: { tab: route.query.tab } })
  search()
}
onMounted(() => { void loadMeta(); void load() })
watch(() => route.query.instanceId, (v) => { filters.instanceId = typeof v === 'string' ? v : undefined; search() })
watch(() => route.query.q, (v) => { if (typeof v === 'string') { filters.q = v; search() } }) // alert links (/social?q=handle)

function onTableChange(p: { current?: number; pageSize?: number }) {
  page.current = p.current ?? 1
  page.pageSize = p.pageSize ?? page.pageSize
  void load()
}

const columns = computed(() => [
  { title: t('social.colPlatform'), key: 'platform', width: 130 },
  { title: t('social.colHandle'), key: 'handle', width: 200 },
  ...(auth.isAdmin ? [{ title: t('social.colOwner'), key: 'owner', width: 110 }] : []),
  { title: t('social.colPersona'), key: 'persona', width: 120 },
  { title: t('social.colLang'), key: 'lang', width: 110 },
  { title: t('social.colTags'), key: 'tags', width: 160 },
  { title: t('social.colDevice'), key: 'device', width: 140 },
  { title: t('social.colCountry'), key: 'proxy', width: 140 },
  { title: t('social.colLogin'), key: 'login', width: 120 },
  { title: t('social.colAccount'), key: 'account', width: 120 },
  { title: t('social.colChecked'), key: 'checked', width: 160 },
  actionColumn(210),
])

/** Persona label: personal ones are marked (admins also see the owner). */
const personaLabel = (p: Persona) => (p.ownerType === 'public' ? p.name : `${p.name} · ${auth.isAdmin ? p.ownerName ?? t('scripts.personal') : t('scripts.personal')}`)
/** Personas that fit an account of `owner`: public ones and that owner's personal ones. */
const personasFor = (owner: string | null | undefined) => personas.value.filter((p) => p.ownerType === 'public' || (!!owner && p.ownerId === owner))
/** 配置语系: languages already bound to the visible accounts (offered first in the pickers). */
const accountLangs = ref<string[]>([])
const langFilterOptions = computed(() => [
  { value: 'none', label: t('social.noLang') },
  ...[...new Set(['zh-CN', ...accountLangs.value])].map((l) => ({ value: l, label: `${langName(l)} (${l})` })),
])
const personaFilterOptions = computed(() => [
  { value: 'none', label: t('social.noPersona') },
  ...personas.value.map((p) => ({ value: p.id, label: personaLabel(p) })),
])
const deviceName = computed(() => (filters.instanceId ? store.byId.get(filters.instanceId)?.name ?? filters.instanceId.slice(0, 8) : ''))

// ---------------------------------------------------------------- create / edit
const editOpen = ref(false)
const saving = ref(false)
const editing = ref<SocialAccount | null>(null)
const formRef = ref<FormInstance>()
const blank = () => ({
  platform: undefined as string | undefined, ownerId: undefined as string | undefined, handle: '', displayName: '', profileUrl: '', externalId: '',
  personaId: undefined as string | undefined, lang: null as string | null, tags: [] as string[], notes: '',
})
const form = reactive(blank())
const HANDLE_RE = /^@?[\p{L}\p{N}._-]{1,100}$/u
const rules = computed<Record<string, Rule[]>>(() => ({
  platform: [{ required: true, message: t('social.required') }],
  handle: [{ required: true, message: t('social.required') }, { pattern: HANDLE_RE, message: t('social.handleInvalid') }],
  profileUrl: [{ pattern: /^(https?:\/\/\S+)?$/i, message: t('social.urlInvalid') }],
}))
/** Personas that may be set on the account: public ones and its owner's. */
const formOwner = computed(() => editing.value?.userId ?? form.ownerId ?? auth.user?.id)
const formPersonas = computed(() => personasFor(formOwner.value))
const formLimit = computed(() => platforms.value.find((p) => p.id === (editing.value?.platform ?? form.platform))?.limit)

function openAdd() {
  editing.value = null
  Object.assign(form, blank())
  formRef.value?.clearValidate()
  editOpen.value = true
}
function openEdit(a: SocialAccount) {
  editing.value = a
  Object.assign(form, {
    ...blank(), platform: a.platform, handle: a.handle, displayName: a.displayName ?? '', profileUrl: a.profileUrl ?? '', externalId: a.externalId ?? '',
    personaId: a.personaId ?? undefined, lang: a.lang, tags: [...a.tags], notes: a.notes ?? '',
  })
  formRef.value?.clearValidate()
  editOpen.value = true
}
watch(() => form.ownerId, () => {
  if (editing.value) return
  if (!formPersonas.value.some((p) => p.id === form.personaId)) form.personaId = undefined
})

async function save() {
  try { await formRef.value?.validate() } catch { return }
  saving.value = true
  const body: Record<string, unknown> = {
    handle: form.handle.trim(), displayName: form.displayName, profileUrl: form.profileUrl, externalId: form.externalId,
    personaId: form.personaId ?? null, lang: form.lang, tags: form.tags, notes: form.notes,
  }
  try {
    if (editing.value) {
      await api('PUT', `/api/social/accounts/${editing.value.id}`, body)
      message.success(t('common.saved'))
    } else {
      await api('POST', '/api/social/accounts', { ...body, platform: form.platform, ...(form.ownerId ? { ownerId: form.ownerId } : {}) })
      message.success(t('common.created'))
    }
    editOpen.value = false
    void load()
    void loadMeta()
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}

function remove(a: SocialAccount) {
  confirmDanger({
    title: t('social.confirmDelete', { name: `${platformName(a.platform)} @${a.handle}` }),
    onOk: async () => {
      try { await api('DELETE', `/api/social/accounts/${a.id}`); message.success(t('common.deleted')); void load() } catch (e) { message.error(errorText(e)) }
    },
  })
}

// ---------------------------------------------------------------- 自动检测 (system-run) + 同步 (row action, replaces 立即检测)
/** Account id → sync task being followed (POST /api/social/sync-from-device on its linked phone). */
const syncing = ref<Record<string, string>>({})
/** Translated result code of the last automatic check. */
const checkText = (code: string | null) => (code ? (te(`social.checkResult.${code}`) ? t(`social.checkResult.${code}`) : code) : '')
const CHECK_COLOR: Record<string, string> = { ok: 'success', logged_out: 'error', wrong_account: 'error', challenge: 'error', offline: 'default', timeout: 'warning', app_missing: 'warning' }
/**
 * 同步 (owner 2026-11-18: replaces 立即检测): 从云手机同步 on the account's linked phone (the owner follows the phone's
 * assignment, derived by the API), followed through the task events (pace deferrals continue as a new task); the sync
 * also writes the check result on the account, so the row is reloaded when it ends.
 */
const syncDisabled = (a: SocialAccount) => !a.instanceId || a.platform !== 'instagram'
async function syncNow(a: SocialAccount) {
  if (syncDisabled(a) || syncing.value[a.id]) return
  try {
    const r = await api<{ task: { id: string } }>('POST', '/api/social/sync-from-device', { instanceId: a.instanceId })
    syncing.value = { ...syncing.value, [a.id]: r.task.id }
    message.info(t('social.syncQueued'))
  } catch (e) { message.error(errorText(e)) }
}
async function syncFinished(accountId: string, taskId: string) {
  try {
    const { task } = await api<{ task: Task & { result: { outcome?: string; result?: string; code?: string; taskId?: string; handle?: string } | null } }>('GET', `/api/tasks/${taskId}`)
    const res = task.result ?? {}
    if (task.status === 'success' && res.outcome === 'deferred' && res.taskId) { syncing.value = { ...syncing.value, [accountId]: res.taskId }; return }
    const { [accountId]: _done, ...rest } = syncing.value
    syncing.value = rest
    if (task.status !== 'success') message.error(t('social.sync.failed', { msg: codeText(task.errorCode ?? undefined, {}, task.error ?? task.status) }))
    else if (res.outcome === 'skipped') message.info(t('social.sync.skipped', { msg: codeText(res.code, {}, res.code ?? '') }))
    else {
      const text = res.result && te(`social.sync.result.${res.result}`) ? t(`social.sync.result.${res.result}`) : res.result ?? ''
      if (res.result === 'created' || res.result === 'updated') message.success(text)
      else message.warning(text)
    }
  } catch (e) { message.error(errorText(e)) }
  void load()
}
const offSync = store.onTaskEvent((ev) => {
  if (ev.type !== 'task.updated' || !['success', 'failed', 'cancelled'].includes(ev.task.status)) return
  const hit = Object.entries(syncing.value).find(([, id]) => id === ev.task.id)
  if (hit) void syncFinished(hit[0], hit[1])
})
onBeforeUnmount(offSync)

// ---------------------------------------------------------------- 从云手机同步 + empty-state guide
const syncOpen = ref(false)
const loaded = ref(false)
/** The account the last sync created / updated: highlighted in the list for a while. */
const highlightId = ref<string | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | undefined
function onSynced(accountId: string) {
  highlightId.value = accountId
  clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => { highlightId.value = null }, 15_000)
  page.current = 1
  void load()
  void loadMeta()
}
const filtersActive = computed(() => !!(filters.q.trim() || filters.platform || filters.personaId || filters.lang || filters.loginStatus || filters.accountStatus
  || filters.exception || filters.tags.length || filters.ownerId || filters.instanceId))
/** Three-step guide while the viewer has no account at all (not just none matching a filter). */
const showGuide = computed(() => loaded.value && !loading.value && total.value === 0 && !filtersActive.value)

// ---------------------------------------------------------------- detail (动态 / 帖子 / 回复记录), opened by clicking a row
const feedOpen = ref(false)
const feedFor = ref<SocialAccount | null>(null)
function openFeed(a: SocialAccount) { feedFor.value = a; feedOpen.value = true }
/** 立即采集 (帖子与评论) of one account, from the row's 更多 menu (owner 2026-11-18: not in the feed drawer). */
async function collectNow(a: SocialAccount) {
  try { await api('POST', `/api/social/accounts/${a.id}/collect`); message.success(t('feed.collectQueued')) } catch (e) { message.error(errorText(e)) }
}
/** A click on the row's own controls (links, buttons, checkbox, dropdown) is not a row click. */
const rowProps = (record: SocialAccount) => ({
  class: record.id === highlightId.value ? 'row-click row-synced' : 'row-click',
  onClick: (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('a, button, input, label, .ant-dropdown, .ant-checkbox-wrapper, .ant-typography')) openFeed(record) },
})

// ---------------------------------------------------------------- logs
const logOpen = ref(false)
const logFor = ref<SocialAccount | null>(null)
const logs = ref<SocialAccountLog[]>([])
const logLoading = ref(false)
async function openLogs(a: SocialAccount) {
  logFor.value = a; logs.value = []; logOpen.value = true; logLoading.value = true
  try { logs.value = (await api<{ logs: SocialAccountLog[] }>('GET', `/api/social/accounts/${a.id}/logs`)).logs } catch (e) { message.error(errorText(e)) }
  finally { logLoading.value = false }
}
function logValue(l: SocialAccountLog, v: string | null) {
  if (v === null || v === '') return t('common.none')
  if (l.field === 'loginStatus') return loginText(v as SocialLoginStatus)
  if (l.field === 'accountStatus') return accountText(v as SocialAccountStatus)
  if (l.action === 'checked') return checkText(v)
  return v
}
const LOG_COLOR: Record<SocialAccountLog['action'], string> = { create: 'green', link: 'blue', unlink: 'gray', status: 'orange', checked: 'green', update: 'blue', connect: 'cyan', disconnect: 'gray' }
const LOG_MSG: Record<string, string> = {
  'device deleted': 'social.msgDeviceDeleted', 'group deleted': 'social.msgGroupDeleted', 'persona deleted': 'social.msgPersonaDeleted', 'persona merged': 'social.msgPersonaMerged',
  'synced from device': 'social.msgSynced', 'phone assigned': 'social.msgPhoneAssigned',
}
/** Log message text; `group migrated: <name>` comes from the 分组 → 人设 data migration (older logs may mention groups). */
function logMessage(m: string) {
  if (LOG_MSG[m]) return t(LOG_MSG[m]!)
  if (m === 'automatic check') return t('social.msgAutoCheckShort')
  const c = /^automatic check on (.+?)(?:: (.*))?$/s.exec(m)
  if (c) return c[2] ? t('social.msgAutoCheckDetail', { device: c[1], detail: c[2] }) : t('social.msgAutoCheck', { device: c[1] })
  const sc = /^sync on (.+?)(?:: (.*))?$/s.exec(m)
  if (sc) return sc[2] ? t('social.msgSyncCheckDetail', { device: sc[1], detail: sc[2] }) : t('social.msgSyncCheck', { device: sc[1] })
  const g = /^group migrated: (.*)$/s.exec(m)
  return g ? t('social.msgGroupMigrated', { name: g[1] }) : m
}
const fieldText = (f: string | null) => (f ? t(`social.field.${f}`) : '')

// ---------------------------------------------------------------- batch
const batchTags = ref<string[]>([])
const batchPersona = ref<string | undefined>(undefined)
/** set-lang: a language, or 'none' (clears). */
const batchLang = ref<string | null>(null)
const batchLangNone = ref(false)
const selectedRows = computed(() => items.value.filter((i) => selectedKeys.value.includes(i.id)))
/** A personal persona fits only when every selected account has its owner. */
const batchOwner = computed(() => { const o = new Set(selectedRows.value.map((r) => r.userId)); return o.size === 1 ? [...o][0] : null })
/** set-persona: public personas fit every selection; personal ones only accounts of their owner. */
const batchPersonaOptions = computed(() => [
  { value: 'none', label: t('social.noPersona') },
  ...personasFor(batchOwner.value).map((p) => ({ value: p.id, label: personaLabel(p) })),
])
async function batch(action: 'set-persona' | 'set-lang' | 'add-tags' | 'remove-tags' | 'unlink' | 'delete') {
  const ids = [...selectedKeys.value]
  if (!ids.length) return
  const run = async () => {
    try {
      const body: Record<string, unknown> = { ids, action }
      if (action === 'set-persona') body.personaId = batchPersona.value === 'none' ? null : batchPersona.value
      if (action === 'set-lang') body.lang = batchLangNone.value ? null : batchLang.value
      if (action === 'add-tags' || action === 'remove-tags') body.tags = batchTags.value
      const r = await api<{ changed: number; count: number }>('POST', '/api/social/accounts/batch', body)
      message.success(t('social.batchDone', { n: action === 'delete' ? r.count : r.changed }))
      if (action === 'delete') selectedKeys.value = []
      void load()
      void loadMeta()
    } catch (e) { message.error(errorText(e)) }
  }
  if (action === 'delete') confirmDanger({ title: t('social.confirmBatchDelete', { n: ids.length }), onOk: run })
  else if (action === 'unlink') confirmAction({ title: t('social.confirmBatchUnlink', { n: ids.length }), onOk: run })
  else await run()
}
/** 批量操作 menu; persona, language and tag actions first ask for the value in a small dialog. */
type BatchFormAction = 'set-persona' | 'set-lang' | 'add-tags' | 'remove-tags'
const BATCH_FORM_LABEL: Record<BatchFormAction, string> = { 'set-persona': 'setPersona', 'set-lang': 'setLang', 'add-tags': 'addTags', 'remove-tags': 'removeTags' }
const batchForm = ref<BatchFormAction | null>(null)
const batchFormOpen = computed({ get: () => !!batchForm.value, set: (v: boolean) => { if (!v) batchForm.value = null } })
const batchFormBusy = ref(false)
const batchFormLabel = (a: BatchFormAction) => t(`social.${BATCH_FORM_LABEL[a]}`)
const batchFormReady = computed(() => {
  if (batchForm.value === 'set-persona') return !!batchPersona.value
  if (batchForm.value === 'set-lang') return !!batchLang.value || batchLangNone.value
  return batchTags.value.length > 0
})
const batchItems = computed<BatchItem[]>(() => [
  { key: 'set-persona', label: t('social.setPersona') },
  { key: 'set-lang', label: t('social.setLang') },
  { key: 'add-tags', label: t('social.addTags') },
  { key: 'remove-tags', label: t('social.removeTags') },
  { key: 'unlink', label: t('social.unlink') },
  { key: 'delete', label: t('common.delete'), danger: true },
])
function onBatch(key: string) {
  if (key in BATCH_FORM_LABEL) {
    batchPersona.value = undefined; batchLang.value = null; batchLangNone.value = false; batchTags.value = []
    batchForm.value = key as BatchFormAction
  } else void batch(key as 'unlink' | 'delete')
}
async function submitBatchForm() {
  if (!batchForm.value || !batchFormReady.value) return
  batchFormBusy.value = true
  try { await batch(batchForm.value); batchForm.value = null }
  finally { batchFormBusy.value = false }
}
</script>

<template>
  <div class="cp-panel">
    <Teleport defer :to="extraTo || 'body'" :disabled="!extraTo">
      <a-button @click="syncOpen = true"><template #icon><SyncOutlined /></template>{{ t('social.sync.button') }}</a-button>
      <a-button type="primary" @click="openAdd"><template #icon><PlusOutlined /></template>{{ t('social.add') }}</a-button>
    </Teleport>

    <a-alert v-if="filters.instanceId" type="info" show-icon :message="t('social.filteredByDevice', { name: deviceName })">
      <template #action><a-button size="small" type="link" @click="reset">{{ t('common.reset') }}</a-button></template>
    </a-alert>

    <a-card v-if="showGuide" size="small" class="sync-guide">
      <div class="guide-title">{{ t('social.sync.guideTitle') }}</div>
      <a-steps direction="vertical" size="small" :current="-1">
        <a-step :title="t('social.sync.step1')">
          <template #description>
            <a-space v-if="store.list.length" wrap>
              <router-link v-for="d in store.list" :key="d.id" :to="`/instances/${d.id}`">{{ d.name }}</router-link>
            </a-space>
            <span v-else class="muted">{{ t('social.sync.step1None') }}</span>
          </template>
        </a-step>
        <a-step :title="t('social.sync.step2')" />
        <a-step :title="t('social.sync.step3')">
          <template #description>
            <a-button type="primary" size="small" @click="syncOpen = true"><template #icon><SyncOutlined /></template>{{ t('social.sync.button') }}</a-button>
          </template>
        </a-step>
      </a-steps>
    </a-card>

    <div>
      <SearchBar :loading="loading" @reset="reset" @refresh="load">
        <a-input-search v-model:value="filters.q" :placeholder="t('social.searchPlaceholder')" allow-clear style="width: 240px" @search="search" />
        <a-select v-model:value="filters.platform" :placeholder="t('social.colPlatform')" allow-clear style="width: 130px" @change="search">
          <a-select-option v-for="p in platforms" :key="p.id" :value="p.id"><PlatformTag :platform="p.id" :name="p.name" /></a-select-option>
        </a-select>
        <a-select v-model:value="filters.personaId" :placeholder="t('social.colPersona')" allow-clear show-search option-filter-prop="label" style="width: 150px"
          :options="personaFilterOptions" @change="search" />
        <a-select v-model:value="filters.lang" :placeholder="t('social.colLang')" allow-clear show-search option-filter-prop="label" style="width: 130px"
          :options="langFilterOptions" @change="search" />
        <a-select v-model:value="filters.loginStatus" :placeholder="t('social.colLogin')" allow-clear style="width: 130px" @change="search">
          <a-select-option v-for="s in SOCIAL_LOGIN_STATUSES" :key="s" :value="s">{{ loginText(s) }}</a-select-option>
        </a-select>
        <a-select v-model:value="filters.accountStatus" :placeholder="t('social.colAccount')" allow-clear style="width: 130px" @change="search">
          <a-select-option v-for="s in SOCIAL_ACCOUNT_STATUSES" :key="s" :value="s">{{ accountText(s) }}</a-select-option>
        </a-select>
        <a-select
          v-model:value="filters.tags" mode="multiple" :placeholder="t('social.colTags')" allow-clear style="min-width: 150px; max-width: 280px"
          :options="allTags.map((x) => ({ value: x, label: x }))" @change="search"
        />
        <a-select
          v-if="auth.isAdmin" v-model:value="filters.ownerId" :placeholder="t('social.colOwner')" allow-clear show-search option-filter-prop="label" style="width: 140px"
          :options="users.map((u) => ({ value: u.id, label: u.username }))" @change="search"
        />
        <a-checkbox v-model:checked="filters.exception" @change="search">
          <a-tooltip :title="t('social.exceptionHint')">{{ t('social.exceptionOnly') }}</a-tooltip>
        </a-checkbox>
        <template #actions>
          <BatchActions :count="selectedKeys.length" :items="batchItems" @select="onBatch" @clear="selectedKeys = []" />
        </template>
      </SearchBar>

      <BatchFormModal v-model:open="batchFormOpen" :title="batchForm ? batchFormLabel(batchForm) : ''" :note="t('social.selected', { n: selectedKeys.length })"
        :ready="batchFormReady" :busy="batchFormBusy" @ok="submitBatchForm">
        <template v-if="batchForm === 'set-persona'">
          <a-select v-model:value="batchPersona" :placeholder="t('social.colPersona')" show-search option-filter-prop="label" style="width: 100%" :options="batchPersonaOptions" />
          <div v-if="!batchOwner" class="muted small batch-hint">{{ t('social.batchPersonaPublicOnly') }}</div>
        </template>
        <a-space v-else-if="batchForm === 'set-lang'" wrap>
          <LangSelect v-model="batchLang" :extra="accountLangs" :placeholder="t('social.colLang')" style="width: 220px" :disabled="batchLangNone" />
          <a-checkbox v-model:checked="batchLangNone">{{ t('social.noLang') }}</a-checkbox>
        </a-space>
        <a-select
          v-else v-model:value="batchTags" mode="tags" :placeholder="t('social.colTags')" style="width: 100%"
          :options="allTags.map((x) => ({ value: x, label: x }))" :token-separators="[',']"
        />
      </BatchFormModal>

      <a-table
        :data-source="items" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :scroll="{ x: 1910 }"
        :pagination="pagination({ current: page.current, pageSize: page.pageSize, total, totalText: (n) => t('social.total', { n }) })"
        :row-selection="{ selectedRowKeys: selectedKeys, onChange: (k: any[]) => (selectedKeys = k as string[]) }"
        :custom-row="(r: any) => rowProps(r as SocialAccount)"
        @change="onTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'platform'"><PlatformTag :platform="record.platform" :name="platformName(record.platform)" /></template>
          <template v-else-if="column.key === 'handle'">
            <a v-if="record.profileUrl" :href="record.profileUrl" target="_blank" rel="noopener noreferrer">@{{ record.handle }}</a>
            <span v-else>@{{ record.handle }}</span>
            <div v-if="record.displayName" class="muted small">{{ record.displayName }}</div>
            <div v-if="record.notes" class="muted small"><a-typography-text :ellipsis="{ tooltip: record.notes }" :content="record.notes" style="max-width: 180px" class="muted" /></div>
          </template>
          <template v-else-if="column.key === 'owner'">{{ record.ownerName ?? '—' }}</template>
          <template v-else-if="column.key === 'persona'"><span v-if="record.personaName">{{ record.personaName }}</span><span v-else class="muted">—</span></template>
          <template v-else-if="column.key === 'lang'">
            <a-tooltip v-if="record.lang" :title="record.lang"><a-tag>{{ langName(record.lang) }}</a-tag></a-tooltip>
            <span v-else class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'tags'">
            <a-tag v-for="tg in record.tags" :key="tg" style="margin-bottom: 2px">{{ tg }}</a-tag>
            <span v-if="!record.tags.length" class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'device'">
            <template v-if="record.instance">
              <router-link v-if="record.instance.accessible" :to="deviceListLink(record.instance.id)">{{ record.instance.name }}</router-link>
              <a-tooltip v-else :title="t('social.noDeviceAccess')"><span class="muted">{{ record.instance.name }}</span></a-tooltip>
            </template>
            <span v-else class="muted">{{ t('social.notLinked') }}</span>
          </template>
          <template v-else-if="column.key === 'proxy'">
            <!-- Country of the linked device's measured egress; before a measurement, the proxy's configured country (marked). -->
            <a-tooltip v-if="record.egress?.country"
              :title="[[record.egress.region, record.egress.city].filter(Boolean).join(' · '), record.egress.ip].filter(Boolean).join(' · ')">
              <span>{{ countryName(record.egress.country) }} <span class="muted">({{ record.egress.country }})</span></span>
            </a-tooltip>
            <span v-else-if="record.proxy?.country">{{ countryName(record.proxy.country) }} <span class="muted small">{{ t('social.countryConfigured') }}</span></span>
            <span v-else class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'login'">
            <StatusTag kind="socialLogin" :status="record.loginStatus" />
          </template>
          <template v-else-if="column.key === 'account'">
            <StatusTag kind="socialAccount" :status="record.accountStatus" />
            <a-tooltip v-if="record.lastError" :title="record.lastError"><ExclamationCircleOutlined class="err-icon" /></a-tooltip>
          </template>
          <template v-else-if="column.key === 'checked'">
            <!-- time only; the result (正常 / 已退出登录 …) is in the tooltip and in the status column / drawer -->
            <a-tooltip v-if="record.lastCheckCode" :title="[checkText(record.lastCheckCode), record.lastCheckDetail].filter(Boolean).join(' · ')">
              <span class="nowrap">{{ fmt(record.lastCheckedAt) }}</span>
            </a-tooltip>
            <span v-else-if="record.autoCheckUnsupported" class="muted small">{{ t(`social.autoCheckUnsupported.${record.autoCheckUnsupported.replace('account_check.', '')}`) }}</span>
            <span v-else class="muted small">{{ record.lastCheckedAt ? fmt(record.lastCheckedAt) : t('social.notChecked') }}</span>
          </template>
          <template v-else-if="column.key === 'ops'">
            <a-space :size="0">
              <a-tooltip :title="syncDisabled(record as SocialAccount) ? t('social.syncNoDevice') : t('social.syncNowHint')">
                <a-button type="link" size="small" :disabled="syncDisabled(record as SocialAccount)" :loading="!!syncing[record.id]" @click="syncNow(record as SocialAccount)">{{ t('social.syncNow') }}</a-button>
              </a-tooltip>
              <a-dropdown>
                <a-button type="link" size="small">{{ t('social.more') }}</a-button>
                <template #overlay>
                  <a-menu>
                    <a-menu-item key="feed" @click="openFeed(record as SocialAccount)">{{ t('feed.tabs.posts') }}</a-menu-item>
                    <a-menu-item key="collect" :disabled="!record.instance" @click="collectNow(record as SocialAccount)">{{ t('feed.collectNow') }}</a-menu-item>
                    <a-menu-item key="edit" @click="openEdit(record as SocialAccount)">{{ t('common.edit') }}</a-menu-item>
                    <a-menu-item key="logs" @click="openLogs(record as SocialAccount)">{{ t('social.logs') }}</a-menu-item>
                    <a-menu-item key="delete" danger @click="remove(record as SocialAccount)">{{ t('common.delete') }}</a-menu-item>
                  </a-menu>
                </template>
              </a-dropdown>
            </a-space>
          </template>
        </template>
      </a-table>
    </div>
  </div>

  <SocialAccountFeedDrawer v-model:open="feedOpen" :account="feedFor" />
  <SyncFromDeviceModal v-model:open="syncOpen" :instance-id="filters.instanceId" @synced="onSynced" />

  <!-- create / edit -->
  <a-drawer v-model:open="editOpen" :title="editing ? t('social.edit') : t('social.add')" :width="DRAWER_WIDTH.md" destroy-on-close>
    <a-form ref="formRef" :model="form" :rules="rules" layout="vertical">
      <a-alert v-if="!editing" type="info" show-icon :message="t('social.manualAddHint')" style="margin-bottom: 12px">
        <template #action><a-button size="small" type="link" @click="editOpen = false; syncOpen = true">{{ t('social.sync.button') }}</a-button></template>
      </a-alert>
      <a-row :gutter="12">
        <a-col :span="12">
          <a-form-item :label="t('social.colPlatform')" name="platform">
            <a-select v-model:value="form.platform" :disabled="!!editing">
              <a-select-option v-for="p in platforms" :key="p.id" :value="p.id"><PlatformTag :platform="p.id" :name="p.name" /></a-select-option>
            </a-select>
          </a-form-item>
        </a-col>
        <a-col v-if="auth.isAdmin && !editing" :span="12">
          <a-form-item :label="t('social.colOwner')" name="ownerId" :extra="t('social.ownerHint')">
            <a-select v-model:value="form.ownerId" allow-clear show-search option-filter-prop="label" :placeholder="auth.user?.username" :options="users.map((u) => ({ value: u.id, label: u.username }))" />
          </a-form-item>
        </a-col>
      </a-row>
      <a-row :gutter="12">
        <a-col :span="12">
          <a-form-item :label="t('social.colHandle')" name="handle"><a-input v-model:value="form.handle" placeholder="handle" /></a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item :label="t('social.displayName')" name="displayName"><a-input v-model:value="form.displayName" :maxlength="100" /></a-form-item>
        </a-col>
      </a-row>
      <a-form-item :label="t('social.profileUrl')" name="profileUrl" :extra="t('social.profileUrlHint')"><a-input v-model:value="form.profileUrl" /></a-form-item>
      <a-form-item :label="t('social.externalId')" name="externalId"><a-input v-model:value="form.externalId" :maxlength="100" /></a-form-item>
      <a-form-item :label="t('social.colPersona')" name="personaId">
        <a-select v-model:value="form.personaId" allow-clear show-search option-filter-prop="label" :placeholder="t('social.noPersona')"
          :options="formPersonas.map((p) => ({ value: p.id, label: personaLabel(p) }))" />
      </a-form-item>
      <a-form-item v-if="editing" :label="t('social.aiDrafts.title')"><AccountAiDrafts :account-id="editing.id" @changed="load" /></a-form-item>
      <a-form-item :label="t('social.colLang')" name="lang" :extra="t('social.langHint')">
        <LangSelect v-model="form.lang" :extra="accountLangs" :placeholder="t('social.noLang')" />
      </a-form-item>
      <a-form-item :label="t('social.colTags')" name="tags">
        <a-select v-model:value="form.tags" mode="tags" :options="allTags.map((x) => ({ value: x, label: x }))" />
      </a-form-item>
      <!-- read only: the link is made by 从云手机同步 and removed by the batch 解除设备关联 -->
      <a-form-item :label="t('social.colDevice')" :extra="formLimit ? t('social.deviceHint', { n: formLimit }) : undefined">
        <template v-if="editing?.instance">
          <router-link v-if="editing.instance.accessible" :to="deviceListLink(editing.instance.id)">{{ editing.instance.name }}</router-link>
          <span v-else class="muted">{{ editing.instance.name }}</span>
        </template>
        <span v-else class="muted">{{ t('social.deviceReadonlyNone') }}</span>
      </a-form-item>
      <a-form-item v-if="editing" :label="t('social.lastCheck')">
        <a-space wrap>
          <StatusTag kind="socialLogin" :status="editing.loginStatus" />
          <a-tag v-if="editing.lastCheckCode" :color="CHECK_COLOR[editing.lastCheckCode]">{{ checkText(editing.lastCheckCode) }}</a-tag>
          <span class="muted small">{{ editing.lastCheckedAt ? fmt(editing.lastCheckedAt) : t('social.notChecked') }}</span>
          <span v-if="editing.lastCheckDetail" class="muted small">{{ editing.lastCheckDetail }}</span>
          <a-tooltip :title="syncDisabled(editing) ? t('social.syncNoDevice') : t('social.syncNowHint')">
            <a-button size="small" :disabled="syncDisabled(editing)" :loading="!!syncing[editing.id]" @click="syncNow(editing!)">{{ t('social.syncNow') }}</a-button>
          </a-tooltip>
        </a-space>
        <div class="muted small">{{ editing.autoCheckUnsupported ? t(`social.autoCheckUnsupported.${editing.autoCheckUnsupported.replace('account_check.', '')}`) : t('social.autoCheckHint') }}</div>
      </a-form-item>
      <a-form-item :label="t('social.notes')" name="notes"><a-textarea v-model:value="form.notes" :rows="3" :maxlength="2000" /></a-form-item>
      <div class="muted small">{{ t('social.noPasswords') }}</div>
    </a-form>
    <template #footer>
      <a-button @click="editOpen = false">{{ t('common.cancel') }}</a-button>
      <a-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</a-button>
    </template>
  </a-drawer>

  <!-- logs -->
  <a-drawer v-model:open="logOpen" :title="t('social.logsTitle', { name: logFor ? `${platformName(logFor.platform)} @${logFor.handle}` : '' })" :width="DRAWER_WIDTH.md">
    <a-spin :spinning="logLoading">
      <a-empty v-if="!logLoading && !logs.length" />
      <a-timeline>
        <a-timeline-item v-for="l in logs" :key="l.id" :color="LOG_COLOR[l.action]">
          <div>
            <strong>{{ t(`social.logAction.${l.action}`) }}</strong>
            <span v-if="l.field && l.action !== 'link' && l.action !== 'unlink'"> · {{ fieldText(l.field) }}</span>
          </div>
          <div v-if="l.action === 'update' || l.action === 'status'">{{ logValue(l, l.fromValue) }} → {{ logValue(l, l.toValue) }}</div>
          <div v-else-if="l.action === 'link'">{{ l.toValue }}</div>
          <div v-else-if="l.action === 'unlink'">{{ l.fromValue }}</div>
          <div v-else-if="l.action === 'create' && l.toValue">{{ l.toValue }}</div>
          <div v-if="l.message" class="muted">{{ logMessage(l.message) }}</div>
          <div class="muted small">{{ fmt(l.at) }} · {{ l.actorName ?? t('common.system') }}</div>
        </a-timeline-item>
      </a-timeline>
    </a-spin>
  </a-drawer>
</template>

<style scoped>
.cp-panel { display: flex; flex-direction: column; gap: var(--cp-gap); min-width: 0; }
.batch-hint { margin-top: 6px; }
.err-icon { color: var(--cp-error); margin-left: 4px; }
.guide-title { font-weight: 600; margin-bottom: 12px; }
:deep(.row-synced) > td { background: var(--cp-primary-bg) !important; transition: background 0.6s; }
</style>
