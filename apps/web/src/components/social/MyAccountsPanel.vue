<script setup lang="ts">
import { countryName } from '../../api/lang'
import { fmtDateTime } from '../../i18n'
import { DeleteOutlined, EditOutlined, ExclamationCircleOutlined, HistoryOutlined, PictureOutlined, PlusOutlined, RobotOutlined, SyncOutlined, TeamOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Rule } from 'ant-design-vue/es/form'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { deviceListLink, queryParam } from '../../api/query'
import { api, errorText } from '../../api/client'
import {
  compactNumber, SOCIAL_ACCOUNT_STATUSES, SOCIAL_LOGIN_STATUSES,
  type ManagedUser, type Persona, type SocialAccount, type SocialAccountLog, type SocialAccountStatus, type SocialLoginStatus, type SocialPlatform,
} from '../../api/types'
import BatchActions, { type BatchItem } from '../common/BatchActions.vue'
import BatchFormModal from '../common/BatchFormModal.vue'
import SearchBar from '../common/SearchBar.vue'
import StatusTag from '../common/StatusTag.vue'
import { actionColumn, confirmAction, confirmDanger, DRAWER_WIDTH, pagination, TABLE_SIZE } from '../common/ui'
import LangSelect from '../common/LangSelect.vue'
import { langName } from '../../api/lang'
import PlatformTag from './PlatformTag.vue'
import AccountAiGenerateModal from './AccountAiGenerateModal.vue'
import SocialAccountFeedDrawer from '../feed/SocialAccountFeedDrawer.vue'
import SyncFromDeviceModal from './SyncFromDeviceModal.vue'
import InitialAvatar from './InitialAvatar.vue'
import { useAccountSync } from './useAccountSync'
import { useAuthStore } from '../../stores/auth'
import { useInstancesStore } from '../../stores/instances'

/**
 * 我的媒体 → 我的媒体号: the operator's own accounts (人设, status, 配置语系, 从云手机同步, detail drawer). The row actions are
 * icon buttons (owner 2026-11-19 「这些可以展开吗」); 关注 / 粉丝 open the account's own page /social/accounts/:id
 * (SocialAccountView.vue; formerly a row expansion). The page's header
 * actions are teleported into `extraTo` (the page header of SocialAccountsView) while this tab is shown.
 */
defineProps<{ extraTo?: string }>()
const { t, te } = useI18n()
const auth = useAuthStore()
const store = useInstancesStore()
const route = useRoute()
const router = useRouter()

const platforms = ref<SocialPlatform[]>([])
/** 账号人设 options: public personas + personal ones (own; admins: every user's). */
const personas = ref<Persona[]>([])
const users = ref<ManagedUser[]>([])
const items = ref<SocialAccount[]>([])
/** 「AI生成草稿」 row action (AccountAiGenerateModal). */
const aiGenFor = ref<SocialAccount | null>(null)
const aiGenOpen = ref(false)
function openAiGenerate(a: SocialAccount) { aiGenFor.value = a; aiGenOpen.value = true }
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
  ownerId: undefined as string | undefined,
  instanceId: (typeof route.query.instanceId === 'string' ? route.query.instanceId : undefined) as string | undefined,
})

const platformName = (id: string) => platforms.value.find((p) => p.id === id)?.name ?? id
const loginText = (s: SocialLoginStatus) => t(`social.login.${s}`)
const accountText = (s: SocialAccountStatus) => t(`social.account.${s}`)

async function loadMeta() {
  try {
    const [p, pub, own, langs] = await Promise.all([
      api<{ platforms: SocialPlatform[] }>('GET', '/api/social/platforms'),
      api<{ personas: Persona[] }>('GET', '/api/personas?scope=public'),
      api<{ personas: Persona[] }>('GET', `/api/personas?scope=${auth.isAdmin ? 'all-users' : 'mine'}`),
      api<{ configured: string[] }>('GET', '/api/contents/languages'),
    ])
    accountLangs.value = langs.configured
    platforms.value = p.platforms
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
  Object.assign(filters, { q: '', platform: undefined, personaId: undefined, lang: undefined, loginStatus: undefined, accountStatus: undefined, exception: false, ownerId: undefined, instanceId: undefined })
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
  { title: t('social.colHandle'), key: 'handle', width: 240, ellipsis: true },
  ...(auth.isAdmin ? [{ title: t('social.colOwner'), key: 'owner', width: 100, ellipsis: true }] : []),
  { title: t('social.colFollowers'), key: 'followers', width: 70, align: 'center' as const },
  { title: t('social.colFollowing'), key: 'following', width: 70, align: 'center' as const },
  { title: t('social.colPersona'), key: 'persona', width: 110, ellipsis: true },
  { title: t('social.colLang'), key: 'lang', width: 90 },
  { title: t('social.colDevice'), key: 'device', width: 150, ellipsis: true },
  { title: t('social.colStatus'), key: 'status', width: 200 },
  actionColumn(206),
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
/**
 * 人设 / 仅异常 have no control in the toolbar any more (owner 2026-11-19 「红框移除」); links from elsewhere
 * (/social?personaId= from the 人设 page, ?exception=1 from the dashboard) still filter and show a closable tag.
 */
const personaFilterName = computed(() => {
  if (!filters.personaId) return ''
  if (filters.personaId === 'none') return t('social.noPersona')
  const p = personas.value.find((x) => x.id === filters.personaId)
  return p ? personaLabel(p) : filters.personaId.slice(0, 8)
})
function clearQueryFilter(key: 'personaId' | 'exception') {
  if (key === 'personaId') filters.personaId = undefined
  else filters.exception = false
  if (route.query[key] !== undefined) { const { [key]: _drop, ...rest } = route.query; void router.replace({ query: rest }) }
  search()
}
const deviceName = computed(() => (filters.instanceId ? store.byId.get(filters.instanceId)?.name ?? filters.instanceId.slice(0, 8) : ''))

// ---------------------------------------------------------------- create / edit
const editOpen = ref(false)
const saving = ref(false)
const editing = ref<SocialAccount | null>(null)
const formRef = ref<FormInstance>()
const blank = () => ({
  platform: undefined as string | undefined, ownerId: undefined as string | undefined, handle: '', displayName: '', profileUrl: '', externalId: '',
  personaId: undefined as string | undefined, lang: null as string | null, notes: '',
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
    personaId: a.personaId ?? undefined, lang: a.lang, notes: a.notes ?? '',
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
    personaId: form.personaId ?? null, lang: form.lang, notes: form.notes,
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
/** Translated result code of the last automatic check. */
const checkText = (code: string | null) => (code ? (te(`social.checkResult.${code}`) ? t(`social.checkResult.${code}`) : code) : '')
const CHECK_COLOR: Record<string, string> = { ok: 'success', logged_out: 'error', wrong_account: 'error', challenge: 'error', offline: 'default', timeout: 'warning', app_missing: 'warning' }
/** The one 同步 button (shared with the account page): step 1 reloads the list as soon as it ends. */
const { syncing, syncLabel, syncDisabled, syncNow } = useAccountSync(() => { void load() })

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
  || filters.exception || filters.ownerId || filters.instanceId))
/** Three-step guide while the viewer has no account at all (not just none matching a filter). */
const showGuide = computed(() => loaded.value && !loading.value && total.value === 0 && !filtersActive.value)

// ---------------------------------------------------------------- detail (动态 / 帖子 / 回复记录), opened by clicking a row
const feedOpen = ref(false)
const feedFor = ref<SocialAccount | null>(null)
function openFeed(a: SocialAccount) { feedFor.value = a; feedOpen.value = true }
/** A click on the row's own controls (links, buttons, checkbox, dropdown) is not a row click. */
const rowProps = (record: SocialAccount) => ({
  class: record.id === highlightId.value ? 'row-click row-synced' : 'row-click',
  onClick: (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('a, button, input, label, .ant-dropdown, .ant-checkbox-wrapper, .ant-typography')) openFeed(record) },
})

/** 关注 / 粉丝 page of an account (formerly the row expansion). */
const audienceLink = (a: SocialAccount) => ({ path: `/social/accounts/${a.id}` })

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
  'phone unassigned': 'social.msgPhoneUnassigned', 'owner disabled': 'social.msgOwnerDisabled', 'owner deleted': 'social.msgOwnerDeleted',
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
async function batch(action: 'set-persona' | 'set-lang' | 'unlink' | 'delete') {
  const ids = [...selectedKeys.value]
  if (!ids.length) return
  const run = async () => {
    try {
      const body: Record<string, unknown> = { ids, action }
      if (action === 'set-persona') body.personaId = batchPersona.value === 'none' ? null : batchPersona.value
      if (action === 'set-lang') body.lang = batchLangNone.value ? null : batchLang.value
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
/** 批量操作 menu; persona and language actions first ask for the value in a small dialog. */
type BatchFormAction = 'set-persona' | 'set-lang'
const BATCH_FORM_LABEL: Record<BatchFormAction, string> = { 'set-persona': 'setPersona', 'set-lang': 'setLang' }
const batchForm = ref<BatchFormAction | null>(null)
const batchFormOpen = computed({ get: () => !!batchForm.value, set: (v: boolean) => { if (!v) batchForm.value = null } })
const batchFormBusy = ref(false)
const batchFormLabel = (a: BatchFormAction) => t(`social.${BATCH_FORM_LABEL[a]}`)
const batchFormReady = computed(() => {
  if (batchForm.value === 'set-persona') return !!batchPersona.value
  return !!batchLang.value || batchLangNone.value
})
const batchItems = computed<BatchItem[]>(() => [
  { key: 'set-persona', label: t('social.setPersona') },
  { key: 'set-lang', label: t('social.setLang') },
  { key: 'unlink', label: t('social.unlink') },
  { key: 'delete', label: t('common.delete'), danger: true },
])
function onBatch(key: string) {
  if (key in BATCH_FORM_LABEL) {
    batchPersona.value = undefined; batchLang.value = null; batchLangNone.value = false
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
      <SearchBar :loading="loading" @reset="reset">
        <a-input-search v-model:value="filters.q" :placeholder="t('social.searchPlaceholder')" allow-clear style="width: 240px" @search="search" />
        <a-select v-model:value="filters.platform" :placeholder="t('social.colPlatform')" allow-clear style="width: 130px" @change="search">
          <a-select-option v-for="p in platforms" :key="p.id" :value="p.id"><PlatformTag :platform="p.id" :name="p.name" /></a-select-option>
        </a-select>
        <a-select v-model:value="filters.lang" :placeholder="t('social.colLang')" allow-clear show-search option-filter-prop="label" style="width: 130px"
          :options="langFilterOptions" @change="search" />
        <a-select v-model:value="filters.loginStatus" :placeholder="t('social.colLogin')" allow-clear style="width: 130px" @change="search">
          <a-select-option v-for="s in SOCIAL_LOGIN_STATUSES" :key="s" :value="s">{{ loginText(s) }}</a-select-option>
        </a-select>
        <a-select v-model:value="filters.accountStatus" :placeholder="t('social.colAccount')" allow-clear style="width: 130px" @change="search">
          <a-select-option v-for="s in SOCIAL_ACCOUNT_STATUSES" :key="s" :value="s">{{ accountText(s) }}</a-select-option>
        </a-select>
        <a-select
          v-if="auth.isAdmin" v-model:value="filters.ownerId" :placeholder="t('social.colOwner')" allow-clear show-search option-filter-prop="label" style="width: 140px"
          :options="users.map((u) => ({ value: u.id, label: u.username }))" @change="search"
        />
        <a-tag v-if="filters.personaId" closable color="processing" @close.prevent="clearQueryFilter('personaId')">{{ t('social.onlyPersona', { name: personaFilterName }) }}</a-tag>
        <a-tooltip v-if="filters.exception" :title="t('social.exceptionHint')">
          <a-tag closable color="processing" @close.prevent="clearQueryFilter('exception')">{{ t('social.onlyException') }}</a-tag>
        </a-tooltip>
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
        <a-space v-else wrap>
          <LangSelect v-model="batchLang" :extra="accountLangs" :placeholder="t('social.colLang')" style="width: 220px" :disabled="batchLangNone" />
          <a-checkbox v-model:checked="batchLangNone">{{ t('social.noLang') }}</a-checkbox>
        </a-space>
      </BatchFormModal>

      <a-table
        :data-source="items" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :scroll="{ x: auth.isAdmin ? 1060 : 960 }"
        :pagination="pagination({ current: page.current, pageSize: page.pageSize, total, totalText: (n) => t('social.total', { n }) })"
        :row-selection="{ selectedRowKeys: selectedKeys, onChange: (k: any[]) => (selectedKeys = k as string[]) }"
        :custom-row="(r: any) => rowProps(r as SocialAccount)"
        @change="onTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'handle'">
            <div class="acct">
              <InitialAvatar :name="record.displayName" :handle="record.handle" :size="32" />
              <div class="acct-text">
                <div class="acct-line">
                  <PlatformTag :platform="record.platform" :name="platformName(record.platform)" icon-only :size="16" />
                  <a v-if="record.profileUrl" :href="record.profileUrl" target="_blank" rel="noopener noreferrer" class="ellipsis">@{{ record.handle }}</a>
                  <span v-else class="ellipsis">@{{ record.handle }}</span>
                </div>
                <div v-if="record.displayName || record.notes" class="muted small ellipsis" :title="record.notes ?? undefined">{{ record.displayName || record.notes }}</div>
              </div>
            </div>
          </template>
          <template v-else-if="column.key === 'owner'">{{ record.ownerName ?? '—' }}</template>
          <template v-else-if="column.key === 'followers' || column.key === 'following'">
            <a-tooltip v-if="record.stats?.[column.key] != null" :title="t('social.countsAt', { time: fmtDateTime(record.stats.at) })">
              <router-link :to="{ ...audienceLink(record as SocialAccount), query: { tab: column.key } }" class="count">
                {{ (record.stats.approx.includes(column.key) ? '≈ ' : '') + compactNumber(record.stats[column.key]) }}
              </router-link>
            </a-tooltip>
            <span v-else class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'persona'"><span v-if="record.personaName">{{ record.personaName }}</span><span v-else class="muted">—</span></template>
          <template v-else-if="column.key === 'lang'">
            <a-tooltip v-if="record.lang" :title="record.lang"><a-tag>{{ langName(record.lang) }}</a-tag></a-tooltip>
            <span v-else class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'device'">
            <div class="ellipsis">
              <template v-if="record.instance">
                <router-link v-if="record.instance.accessible" :to="deviceListLink(record.instance.id)">{{ record.instance.name }}</router-link>
                <a-tooltip v-else :title="t('social.noDeviceAccess')"><span class="muted">{{ record.instance.name }}</span></a-tooltip>
              </template>
              <span v-else class="muted">{{ t('social.notLinked') }}</span>
            </div>
            <!-- Country of the linked device's measured egress; before a measurement, the proxy's configured country (marked). -->
            <div class="muted small ellipsis">
              <a-tooltip v-if="record.egress?.country"
                :title="[[record.egress.region, record.egress.city].filter(Boolean).join(' · '), record.egress.ip].filter(Boolean).join(' · ')">
                <span>{{ countryName(record.egress.country) }} ({{ record.egress.country }})</span>
              </a-tooltip>
              <span v-else-if="record.proxy?.country">{{ countryName(record.proxy.country) }} {{ t('social.countryConfigured') }}</span>
            </div>
          </template>
          <template v-else-if="column.key === 'status'">
            <div class="status-tags">
              <StatusTag kind="socialLogin" :status="record.loginStatus" />
              <StatusTag kind="socialAccount" :status="record.accountStatus" />
              <a-tooltip v-if="record.lastError" :title="record.lastError"><ExclamationCircleOutlined class="err-icon" /></a-tooltip>
            </div>
            <!-- last automatic check / sync: time; the result (正常 / 已退出登录 …) is in the tooltip and in the drawer -->
            <div class="muted small">
              <a-tooltip v-if="record.lastCheckCode" :title="[checkText(record.lastCheckCode), record.lastCheckDetail].filter(Boolean).join(' · ')">
                <span class="nowrap">{{ t('social.colChecked') }} {{ fmtDateTime(record.lastCheckedAt) }}</span>
              </a-tooltip>
              <span v-else-if="record.autoCheckUnsupported">{{ t(`social.autoCheckUnsupported.${record.autoCheckUnsupported.replace('account_check.', '')}`) }}</span>
              <span v-else>{{ record.lastCheckedAt ? `${t('social.colChecked')} ${fmtDateTime(record.lastCheckedAt)}` : t('social.notChecked') }}</span>
            </div>
          </template>
          <template v-else-if="column.key === 'ops'">
            <div class="ops">
              <a-tooltip :title="syncDisabled(record as SocialAccount) ? t('social.syncNoDevice') : syncing[record.id] ? syncLabel(record.id) : `${t('social.syncNow')} · ${t('social.syncNowHint')}`">
                <a-button type="text" size="small" :aria-label="t('social.syncNow')" :disabled="syncDisabled(record as SocialAccount)" :loading="!!syncing[record.id]" @click="syncNow(record as SocialAccount)">
                  <template #icon><SyncOutlined /></template>
                </a-button>
              </a-tooltip>
              <a-tooltip :title="t('social.audience.page.openHint')">
                <router-link :to="audienceLink(record as SocialAccount)" class="ops-link" :aria-label="t('social.audience.page.open')"><TeamOutlined /></router-link>
              </a-tooltip>
              <a-tooltip :title="t('feed.tabs.posts')">
                <a-button type="text" size="small" :aria-label="t('feed.tabs.posts')" @click="openFeed(record as SocialAccount)"><template #icon><PictureOutlined /></template></a-button>
              </a-tooltip>
              <a-tooltip :title="record.personaId ? t('social.aiDrafts.generateNow') : t('social.aiDrafts.noPersonaGenerate')">
                <a-button type="text" size="small" :aria-label="t('social.aiDrafts.generateNow')" :disabled="!record.personaId" @click="openAiGenerate(record as SocialAccount)"><template #icon><RobotOutlined /></template></a-button>
              </a-tooltip>
              <a-tooltip :title="t('common.edit')">
                <a-button type="text" size="small" :aria-label="t('common.edit')" @click="openEdit(record as SocialAccount)"><template #icon><EditOutlined /></template></a-button>
              </a-tooltip>
              <a-tooltip :title="t('social.logs')">
                <a-button type="text" size="small" :aria-label="t('social.logs')" @click="openLogs(record as SocialAccount)"><template #icon><HistoryOutlined /></template></a-button>
              </a-tooltip>
              <a-tooltip :title="t('common.delete')">
                <a-button type="text" size="small" danger :aria-label="t('common.delete')" @click="remove(record as SocialAccount)"><template #icon><DeleteOutlined /></template></a-button>
              </a-tooltip>
            </div>
          </template>
        </template>
      </a-table>
    </div>
  </div>

  <SocialAccountFeedDrawer v-model:open="feedOpen" :account="feedFor" />
  <AccountAiGenerateModal v-model:open="aiGenOpen" :account="aiGenFor" />
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
      <a-form-item :label="t('social.colLang')" name="lang" :extra="t('social.langHint')">
        <LangSelect v-model="form.lang" :extra="accountLangs" :placeholder="t('social.noLang')" />
      </a-form-item>
      <!-- read only: the link is made by 从云手机同步 and removed by the batch 解除设备关联 -->
      <a-form-item :label="t('social.colDevice')">
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
        </a-space>
      </a-form-item>
      <a-form-item :label="t('social.notes')" name="notes"><a-textarea v-model:value="form.notes" :rows="3" :maxlength="2000" /></a-form-item>
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
          <div class="muted small">{{ fmtDateTime(l.at) }} · {{ l.actorName ?? t('common.system') }}</div>
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
.acct { display: flex; align-items: center; gap: 10px; min-width: 0; }
.acct-text { min-width: 0; flex: 1; }
.acct-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.status-tags { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.status-tags :deep(.ant-tag) { margin-inline-end: 0; }
.ops { display: flex; align-items: center; gap: 2px; flex-wrap: nowrap; }
.count { font-variant-numeric: tabular-nums; }
.ops-link { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 4px; color: var(--cp-text); }
.ops-link:hover { background: var(--cp-fill-alter); color: var(--cp-primary); }
:deep(.row-synced) > td { background: var(--cp-primary-bg) !important; transition: background 0.6s; }
</style>
