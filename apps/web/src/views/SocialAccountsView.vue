<script setup lang="ts">
import { countryName } from '../api/lang'
import { dateLocale } from '../i18n'
import { ExclamationCircleOutlined, PlusOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Rule } from 'ant-design-vue/es/form'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { queryParam } from '../api/query'
import { api, errorText } from '../api/client'
import {
  SOCIAL_ACCOUNT_STATUSES, SOCIAL_LOGIN_STATUSES,
  type ManagedUser, type Persona, type SocialAccount, type SocialAccountLog, type SocialAccountStatus, type SocialGroup, type SocialLoginStatus, type SocialPlatform,
} from '../api/types'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import StatusTag from '../components/common/StatusTag.vue'
import { actionColumn, confirmAction, confirmDanger, DRAWER_WIDTH, MODAL_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'
import ConnectionCell from '../components/social/ConnectionCell.vue'
import { usePlatformConnections } from '../components/social/connections'
import PlatformTag from '../components/social/PlatformTag.vue'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

const { t } = useI18n()
const auth = useAuthStore()
const store = useInstancesStore()
const route = useRoute()
const router = useRouter()
const conns = usePlatformConnections()

const platforms = ref<SocialPlatform[]>([])
const groups = ref<SocialGroup[]>([])
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
  groupId: undefined as string | undefined,
  personaId: undefined as string | undefined,
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
    const [p, g, tg, pub, own] = await Promise.all([
      api<{ platforms: SocialPlatform[] }>('GET', '/api/social/platforms'),
      api<{ groups: SocialGroup[] }>('GET', '/api/social/groups'),
      api<{ tags: string[] }>('GET', '/api/social/tags'),
      api<{ personas: Persona[] }>('GET', '/api/personas?scope=public'),
      api<{ personas: Persona[] }>('GET', `/api/personas?scope=${auth.isAdmin ? 'all-users' : 'mine'}`),
    ])
    platforms.value = p.platforms
    groups.value = g.groups
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
    for (const k of ['platform', 'groupId', 'personaId', 'loginStatus', 'accountStatus', 'ownerId', 'instanceId'] as const) if (filters[k]) p.set(k, filters[k]!)
    if (filters.exception) p.set('exception', 'true')
    if (filters.tags.length) p.set('tags', filters.tags.join(','))
    const r = await api<{ items: SocialAccount[]; total: number }>('GET', `/api/social/accounts?${p}`)
    items.value = r.items
    total.value = r.total
    void conns.load(r.items.map((x) => x.id))
    const ids = new Set(r.items.map((x) => x.id))
    selectedKeys.value = selectedKeys.value.filter((k) => ids.has(k))
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
function search() { page.current = 1; void load() }
function reset() {
  Object.assign(filters, { q: '', platform: undefined, groupId: undefined, personaId: undefined, loginStatus: undefined, accountStatus: undefined, exception: false, tags: [], ownerId: undefined, instanceId: undefined })
  if (route.query.instanceId) void router.replace({ query: {} })
  search()
}
onMounted(() => { void loadMeta(); void load(); void conns.loadPlatforms().then(conns.handleCallback) })
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
  { title: t('social.colGroup'), key: 'group', width: 110 },
  { title: t('social.colPersona'), key: 'persona', width: 120 },
  { title: t('social.colTags'), key: 'tags', width: 160 },
  { title: t('social.colDevice'), key: 'device', width: 140 },
  { title: t('social.colCountry'), key: 'proxy', width: 140 },
  { title: t('social.colLogin'), key: 'login', width: 120 },
  { title: t('social.colAccount'), key: 'account', width: 120 },
  { title: t('social.colChecked'), key: 'checked', width: 160 },
  { title: t('platforms.colConnection'), key: 'connection', width: 190 },
  actionColumn(210),
])

const groupOptions = computed(() => [
  { value: 'none', label: t('social.ungrouped') },
  ...groups.value.map((g) => ({ value: g.id, label: auth.isAdmin ? `${g.name} · ${g.ownerName}` : g.name })),
])
/** Persona label: personal ones are marked (admins also see the owner). */
const personaLabel = (p: Persona) => (p.ownerType === 'public' ? p.name : `${p.name} · ${auth.isAdmin ? p.ownerName ?? t('scripts.personal') : t('scripts.personal')}`)
/** Personas that fit an account of `owner`: public ones and that owner's personal ones. */
const personasFor = (owner: string | null | undefined) => personas.value.filter((p) => p.ownerType === 'public' || (!!owner && p.ownerId === owner))
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
  groupId: undefined as string | undefined, personaId: undefined as string | undefined, tags: [] as string[], instanceId: undefined as string | undefined,
  loginStatus: 'unknown' as SocialLoginStatus, accountStatus: 'active' as SocialAccountStatus, lastError: '', notes: '',
})
const form = reactive(blank())
const HANDLE_RE = /^@?[\p{L}\p{N}._-]{1,100}$/u
const rules = computed<Record<string, Rule[]>>(() => ({
  platform: [{ required: true, message: t('social.required') }],
  handle: [{ required: true, message: t('social.required') }, { pattern: HANDLE_RE, message: t('social.handleInvalid') }],
  profileUrl: [{ pattern: /^(https?:\/\/\S+)?$/i, message: t('social.urlInvalid') }],
}))
/** Groups that may hold the account: those of its owner. */
const formOwner = computed(() => editing.value?.userId ?? form.ownerId ?? auth.user?.id)
const formGroups = computed(() => groups.value.filter((g) => g.userId === formOwner.value))
const formPersonas = computed(() => personasFor(formOwner.value))
const deviceOptions = computed(() => store.list.map((i) => ({ value: i.id, label: i.name })))
const formLimit = computed(() => platforms.value.find((p) => p.id === (editing.value?.platform ?? form.platform))?.limit)

function openAdd() {
  editing.value = null
  Object.assign(form, blank(), { instanceId: filters.instanceId })
  formRef.value?.clearValidate()
  editOpen.value = true
}
function openEdit(a: SocialAccount) {
  editing.value = a
  Object.assign(form, {
    ...blank(), platform: a.platform, handle: a.handle, displayName: a.displayName ?? '', profileUrl: a.profileUrl ?? '', externalId: a.externalId ?? '',
    groupId: a.groupId ?? undefined, personaId: a.personaId ?? undefined, tags: [...a.tags], instanceId: a.instanceId ?? undefined,
    loginStatus: a.loginStatus, accountStatus: a.accountStatus, lastError: a.lastError ?? '', notes: a.notes ?? '',
  })
  formRef.value?.clearValidate()
  editOpen.value = true
}
watch(() => form.ownerId, () => {
  if (editing.value) return
  form.groupId = undefined
  if (!formPersonas.value.some((p) => p.id === form.personaId)) form.personaId = undefined
})

async function save() {
  try { await formRef.value?.validate() } catch { return }
  saving.value = true
  const body: Record<string, unknown> = {
    handle: form.handle.trim(), displayName: form.displayName, profileUrl: form.profileUrl, externalId: form.externalId,
    groupId: form.groupId ?? null, personaId: form.personaId ?? null, tags: form.tags, instanceId: form.instanceId ?? null,
    loginStatus: form.loginStatus, accountStatus: form.accountStatus, lastError: form.lastError, notes: form.notes,
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

// ---------------------------------------------------------------- mark checked
const checkOpen = ref(false)
const checkFor = ref<SocialAccount | null>(null)
const checkForm = reactive({ loginStatus: 'unknown' as SocialLoginStatus, accountStatus: 'active' as SocialAccountStatus, lastError: '', message: '' })
function openCheck(a: SocialAccount) {
  checkFor.value = a
  Object.assign(checkForm, { loginStatus: a.loginStatus, accountStatus: a.accountStatus, lastError: a.lastError ?? '', message: '' })
  checkOpen.value = true
}
async function submitCheck() {
  if (!checkFor.value) return
  saving.value = true
  try {
    await api('POST', `/api/social/accounts/${checkFor.value.id}/checked`, { ...checkForm })
    message.success(t('social.checkedDone'))
    checkOpen.value = false
    void load()
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}

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
  return v
}
const LOG_COLOR: Record<SocialAccountLog['action'], string> = { create: 'green', link: 'blue', unlink: 'gray', status: 'orange', checked: 'green', update: 'blue', connect: 'cyan', disconnect: 'gray' }
const LOG_MSG: Record<string, string> = {
  'device deleted': 'social.msgDeviceDeleted', 'group deleted': 'social.msgGroupDeleted', 'persona deleted': 'social.msgPersonaDeleted', 'persona merged': 'social.msgPersonaMerged',
}
const fieldText = (f: string | null) => (f ? t(`social.field.${f}`) : '')

// ---------------------------------------------------------------- batch
const batchGroup = ref<string | undefined>(undefined)
const batchTags = ref<string[]>([])
const batchPersona = ref<string | undefined>(undefined)
const selectedRows = computed(() => items.value.filter((i) => selectedKeys.value.includes(i.id)))
/** move-group needs every selected account to share one owner (groups are per owner). */
const batchOwner = computed(() => { const o = new Set(selectedRows.value.map((r) => r.userId)); return o.size === 1 ? [...o][0] : null })
const batchGroupOptions = computed(() => [
  { value: 'none', label: t('social.ungrouped') },
  ...groups.value.filter((g) => g.userId === batchOwner.value).map((g) => ({ value: g.id, label: g.name })),
])
/** set-persona: public personas fit every selection; personal ones only accounts of their owner. */
const batchPersonaOptions = computed(() => [
  { value: 'none', label: t('social.noPersona') },
  ...personasFor(batchOwner.value).map((p) => ({ value: p.id, label: personaLabel(p) })),
])
async function batch(action: 'move-group' | 'set-persona' | 'add-tags' | 'remove-tags' | 'unlink' | 'delete') {
  const ids = [...selectedKeys.value]
  if (!ids.length) return
  const run = async () => {
    try {
      const body: Record<string, unknown> = { ids, action }
      if (action === 'move-group') body.groupId = batchGroup.value === 'none' ? null : batchGroup.value
      if (action === 'set-persona') body.personaId = batchPersona.value === 'none' ? null : batchPersona.value
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

// ---------------------------------------------------------------- groups
const groupsOpen = ref(false)
const newGroup = reactive({ name: '', ownerId: undefined as string | undefined })
const renaming = reactive<Record<string, string>>({})
async function addGroup() {
  if (!newGroup.name.trim()) return
  try {
    await api('POST', '/api/social/groups', { name: newGroup.name.trim(), ...(newGroup.ownerId ? { ownerId: newGroup.ownerId } : {}) })
    newGroup.name = ''
    await loadMeta()
  } catch (e) { message.error(errorText(e)) }
}
async function renameGroup(g: SocialGroup) {
  const name = renaming[g.id]?.trim()
  if (!name || name === g.name) { delete renaming[g.id]; return }
  try { await api('PUT', `/api/social/groups/${g.id}`, { name }); delete renaming[g.id]; await loadMeta(); void load() } catch (e) { message.error(errorText(e)) }
}
function deleteGroup(g: SocialGroup) {
  confirmDanger({
    title: t('social.confirmDeleteGroup', { name: g.name, n: g.count }),
    onOk: async () => {
      try { await api('DELETE', `/api/social/groups/${g.id}`); await loadMeta(); void load() } catch (e) { message.error(errorText(e)) }
    },
  })
}
const groupColumns = computed(() => [
  { title: t('common.name'), key: 'name' },
  ...(auth.isAdmin ? [{ title: t('social.colOwner'), dataIndex: 'ownerName', key: 'owner', width: 120 }] : []),
  { title: t('social.groupCount'), dataIndex: 'count', key: 'count', width: 80 },
  { title: '', key: 'ops', width: 140, align: 'right' as const },
])

</script>

<template>
  <PageContainer :title="t('social.title')">
    <template #extra>
      <a-button @click="groupsOpen = true">{{ t('social.groups') }}</a-button>
      <a-button type="primary" @click="openAdd"><template #icon><PlusOutlined /></template>{{ t('social.add') }}</a-button>
    </template>

    <a-alert v-if="filters.instanceId" type="info" show-icon :message="t('social.filteredByDevice', { name: deviceName })">
      <template #action><a-button size="small" type="link" @click="reset">{{ t('common.reset') }}</a-button></template>
    </a-alert>

    <a-card :bordered="false">
      <SearchBar :loading="loading" @reset="reset" @refresh="load">
        <a-input-search v-model:value="filters.q" :placeholder="t('social.searchPlaceholder')" allow-clear style="width: 240px" @search="search" />
        <a-select v-model:value="filters.platform" :placeholder="t('social.colPlatform')" allow-clear style="width: 130px" @change="search">
          <a-select-option v-for="p in platforms" :key="p.id" :value="p.id"><PlatformTag :platform="p.id" :name="p.name" /></a-select-option>
        </a-select>
        <a-select v-model:value="filters.groupId" :placeholder="t('social.colGroup')" allow-clear style="width: 150px" :options="groupOptions" @change="search" />
        <a-select v-model:value="filters.personaId" :placeholder="t('social.colPersona')" allow-clear show-search option-filter-prop="label" style="width: 150px"
          :options="personaFilterOptions" @change="search" />
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
      </SearchBar>

      <a-space v-if="selectedKeys.length" wrap class="batch-bar">
        <span>{{ t('social.selected', { n: selectedKeys.length }) }}</span>
        <a-tooltip :title="batchOwner ? undefined : t('social.batchGroupOneOwner')">
          <a-select v-model:value="batchGroup" :disabled="!batchOwner" :placeholder="t('social.moveTo')" size="small" style="width: 140px" :options="batchGroupOptions" />
        </a-tooltip>
        <a-button size="small" :disabled="!batchGroup" @click="batch('move-group')">{{ t('social.moveGroup') }}</a-button>
        <a-tooltip :title="batchOwner ? undefined : t('social.batchPersonaPublicOnly')">
          <a-select v-model:value="batchPersona" :placeholder="t('social.colPersona')" size="small" show-search option-filter-prop="label" style="width: 140px" :options="batchPersonaOptions" />
        </a-tooltip>
        <a-button size="small" :disabled="!batchPersona" @click="batch('set-persona')">{{ t('social.setPersona') }}</a-button>
        <a-select
          v-model:value="batchTags" mode="tags" size="small" :placeholder="t('social.colTags')" style="min-width: 160px"
          :options="allTags.map((x) => ({ value: x, label: x }))"
        />
        <a-button size="small" :disabled="!batchTags.length" @click="batch('add-tags')">{{ t('social.addTags') }}</a-button>
        <a-button size="small" :disabled="!batchTags.length" @click="batch('remove-tags')">{{ t('social.removeTags') }}</a-button>
        <a-button size="small" @click="batch('unlink')">{{ t('social.unlink') }}</a-button>
        <a-button size="small" danger @click="batch('delete')">{{ t('common.delete') }}</a-button>
      </a-space>

      <a-table
        :data-source="items" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :scroll="{ x: 1910 }"
        :pagination="pagination({ current: page.current, pageSize: page.pageSize, total, totalText: (n) => t('social.total', { n }) })"
        :row-selection="{ selectedRowKeys: selectedKeys, onChange: (k: any[]) => (selectedKeys = k as string[]) }"
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
          <template v-else-if="column.key === 'group'">{{ record.groupName ?? '—' }}</template>
          <template v-else-if="column.key === 'persona'"><span v-if="record.personaName">{{ record.personaName }}</span><span v-else class="muted">—</span></template>
          <template v-else-if="column.key === 'tags'">
            <a-tag v-for="tg in record.tags" :key="tg" style="margin-bottom: 2px">{{ tg }}</a-tag>
            <span v-if="!record.tags.length" class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'device'">
            <template v-if="record.instance">
              <router-link v-if="record.instance.accessible" :to="`/instances/${record.instance.id}`">{{ record.instance.name }}</router-link>
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
          <template v-else-if="column.key === 'checked'">{{ fmt(record.lastCheckedAt) }}</template>
          <template v-else-if="column.key === 'connection'">
            <ConnectionCell
              :account-id="record.id" :label="`${platformName(record.platform)} @${record.handle}`" :platform="conns.platforms.value.find((p) => p.id === record.platform)"
              :connection="conns.byAccount.value.get(record.id)" @changed="load"
            />
          </template>
          <template v-else-if="column.key === 'ops'">
            <a-space :size="0">
              <a-tooltip :title="record.instance?.accessible ? t('social.openDeviceHint') : t('social.openDeviceNone')">
                <a-button type="link" size="small" :disabled="!record.instance?.accessible" @click="router.push(`/instances/${record.instance.id}`)">{{ t('social.openDevice') }}</a-button>
              </a-tooltip>
              <a-button type="link" size="small" @click="openCheck(record as SocialAccount)">{{ t('social.check') }}</a-button>
              <a-dropdown>
                <a-button type="link" size="small">{{ t('social.more') }}</a-button>
                <template #overlay>
                  <a-menu>
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
    </a-card>
  </PageContainer>

  <!-- create / edit -->
  <a-drawer v-model:open="editOpen" :title="editing ? t('social.edit') : t('social.add')" :width="DRAWER_WIDTH.md" destroy-on-close>
    <a-form ref="formRef" :model="form" :rules="rules" layout="vertical">
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
      <a-row :gutter="12">
        <a-col :span="12">
          <a-form-item :label="t('social.colGroup')" name="groupId">
            <a-select v-model:value="form.groupId" allow-clear :options="formGroups.map((g) => ({ value: g.id, label: g.name }))" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item :label="t('social.colPersona')" name="personaId">
            <a-select v-model:value="form.personaId" allow-clear show-search option-filter-prop="label" :placeholder="t('social.noPersona')"
              :options="formPersonas.map((p) => ({ value: p.id, label: personaLabel(p) }))" />
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item :label="t('social.colTags')" name="tags">
        <a-select v-model:value="form.tags" mode="tags" :options="allTags.map((x) => ({ value: x, label: x }))" />
      </a-form-item>
      <a-form-item :label="t('social.colDevice')" name="instanceId" :extra="formLimit ? t('social.deviceHint', { n: formLimit }) : undefined">
        <a-select v-model:value="form.instanceId" allow-clear show-search option-filter-prop="label" :options="deviceOptions" :placeholder="t('social.notLinked')" />
      </a-form-item>
      <a-row :gutter="12">
        <a-col :span="12">
          <a-form-item :label="t('social.colLogin')" name="loginStatus">
            <a-select v-model:value="form.loginStatus" :options="SOCIAL_LOGIN_STATUSES.map((s) => ({ value: s, label: loginText(s) }))" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item :label="t('social.colAccount')" name="accountStatus">
            <a-select v-model:value="form.accountStatus" :options="SOCIAL_ACCOUNT_STATUSES.map((s) => ({ value: s, label: accountText(s) }))" />
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item :label="t('social.lastError')" name="lastError"><a-input v-model:value="form.lastError" allow-clear :maxlength="500" /></a-form-item>
      <a-form-item :label="t('social.notes')" name="notes"><a-textarea v-model:value="form.notes" :rows="3" :maxlength="2000" /></a-form-item>
      <div class="muted small">{{ t('social.noPasswords') }}</div>
    </a-form>
    <template #footer>
      <a-button @click="editOpen = false">{{ t('common.cancel') }}</a-button>
      <a-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</a-button>
    </template>
  </a-drawer>

  <!-- mark checked -->
  <a-modal v-model:open="checkOpen" :title="t('social.checkTitle', { name: checkFor ? `@${checkFor.handle}` : '' })" :confirm-loading="saving" :ok-text="t('social.check')" :cancel-text="t('common.cancel')" @ok="submitCheck">
    <p class="muted">{{ t('social.checkHint') }}</p>
    <a-form layout="vertical">
      <a-row :gutter="12">
        <a-col :span="12">
          <a-form-item :label="t('social.colLogin')">
            <a-select v-model:value="checkForm.loginStatus" :options="SOCIAL_LOGIN_STATUSES.map((s) => ({ value: s, label: loginText(s) }))" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item :label="t('social.colAccount')">
            <a-select v-model:value="checkForm.accountStatus" :options="SOCIAL_ACCOUNT_STATUSES.map((s) => ({ value: s, label: accountText(s) }))" />
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item :label="t('social.lastError')"><a-input v-model:value="checkForm.lastError" allow-clear :maxlength="500" /></a-form-item>
      <a-form-item :label="t('social.checkMessage')"><a-input v-model:value="checkForm.message" :maxlength="300" /></a-form-item>
    </a-form>
  </a-modal>

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
          <div v-if="l.message" class="muted">{{ LOG_MSG[l.message] ? t(LOG_MSG[l.message]!) : l.message }}</div>
          <div class="muted small">{{ fmt(l.at) }} · {{ l.actorName ?? t('common.system') }}</div>
        </a-timeline-item>
      </a-timeline>
    </a-spin>
  </a-drawer>

  <!-- groups -->
  <a-modal v-model:open="groupsOpen" :title="t('social.groups')" :footer="null" :width="MODAL_WIDTH.md">
    <a-space wrap style="margin-bottom: 12px">
      <a-input v-model:value="newGroup.name" :placeholder="t('social.groupName')" :maxlength="50" style="width: 200px" @press-enter="addGroup" />
      <a-select
        v-if="auth.isAdmin" v-model:value="newGroup.ownerId" allow-clear show-search option-filter-prop="label" :placeholder="auth.user?.username" style="width: 140px"
        :options="users.map((u) => ({ value: u.id, label: u.username }))"
      />
      <a-button type="primary" :disabled="!newGroup.name.trim()" @click="addGroup">{{ t('common.create') }}</a-button>
    </a-space>
    <a-table :data-source="groups" :columns="groupColumns" row-key="id" size="small" :pagination="pagination({ defaultPageSize: 10, hideOnSinglePage: true, size: 'small' })">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <a-input v-if="renaming[record.id] !== undefined" v-model:value="renaming[record.id]" size="small" :maxlength="50" @press-enter="renameGroup(record as SocialGroup)" />
          <span v-else>{{ record.name }}</span>
        </template>
        <template v-else-if="column.key === 'ops'">
          <a-space :size="0">
            <a-button v-if="renaming[record.id] !== undefined" type="link" size="small" @click="renameGroup(record as SocialGroup)">{{ t('common.save') }}</a-button>
            <a-button v-else type="link" size="small" @click="renaming[record.id] = record.name">{{ t('social.rename') }}</a-button>
            <a-button type="link" size="small" danger @click="deleteGroup(record as SocialGroup)">{{ t('common.delete') }}</a-button>
          </a-space>
        </template>
      </template>
    </a-table>
  </a-modal>

</template>

<style scoped>
.batch-bar { margin-bottom: var(--cp-gap); padding: 8px 12px; background: var(--cp-fill-alter); border-radius: 6px; }
.err-icon { color: var(--cp-error); margin-left: 4px; }
</style>
