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
  type ManagedUser, type Persona, type SocialAccount, type SocialAccountLog, type SocialAccountStatus, type SocialLoginStatus, type SocialPlatform,
} from '../api/types'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import StatusTag from '../components/common/StatusTag.vue'
import { actionColumn, confirmAction, confirmDanger, DRAWER_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'
import PlatformTag from '../components/social/PlatformTag.vue'
import SocialAccountFeedDrawer from '../components/feed/SocialAccountFeedDrawer.vue'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

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
    const [p, tg, pub, own] = await Promise.all([
      api<{ platforms: SocialPlatform[] }>('GET', '/api/social/platforms'),
      api<{ tags: string[] }>('GET', '/api/social/tags'),
      api<{ personas: Persona[] }>('GET', '/api/personas?scope=public'),
      api<{ personas: Persona[] }>('GET', `/api/personas?scope=${auth.isAdmin ? 'all-users' : 'mine'}`),
    ])
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
    for (const k of ['platform', 'personaId', 'loginStatus', 'accountStatus', 'ownerId', 'instanceId'] as const) if (filters[k]) p.set(k, filters[k]!)
    if (filters.exception) p.set('exception', 'true')
    if (filters.tags.length) p.set('tags', filters.tags.join(','))
    const r = await api<{ items: SocialAccount[]; total: number }>('GET', `/api/social/accounts?${p}`)
    items.value = r.items
    total.value = r.total
    const ids = new Set(r.items.map((x) => x.id))
    selectedKeys.value = selectedKeys.value.filter((k) => ids.has(k))
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
function search() { page.current = 1; void load() }
function reset() {
  Object.assign(filters, { q: '', platform: undefined, personaId: undefined, loginStatus: undefined, accountStatus: undefined, exception: false, tags: [], ownerId: undefined, instanceId: undefined })
  if (route.query.instanceId) void router.replace({ query: {} })
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
  personaId: undefined as string | undefined, tags: [] as string[], instanceId: undefined as string | undefined, notes: '',
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
    personaId: a.personaId ?? undefined, tags: [...a.tags], instanceId: a.instanceId ?? undefined, notes: a.notes ?? '',
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
    personaId: form.personaId ?? null, tags: form.tags, instanceId: form.instanceId ?? null, notes: form.notes,
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

// ---------------------------------------------------------------- 自动检测 (system-run; 立即检测 queues one now)
const checking = ref<string | null>(null)
/** Translated result code of the last automatic check. */
const checkText = (code: string | null) => (code ? (te(`social.checkResult.${code}`) ? t(`social.checkResult.${code}`) : code) : '')
const CHECK_COLOR: Record<string, string> = { ok: 'success', logged_out: 'error', wrong_account: 'error', challenge: 'error', offline: 'default', timeout: 'warning', app_missing: 'warning' }
async function checkNow(a: SocialAccount) {
  checking.value = a.id
  try {
    await api('POST', `/api/social/accounts/${a.id}/check`)
    message.success(t('social.checkQueued'))
  } catch (e) { message.error(errorText(e)) }
  finally { checking.value = null }
}

// ---------------------------------------------------------------- detail (动态 / 帖子 / 回复记录), opened by clicking a row
const feedOpen = ref(false)
const feedFor = ref<SocialAccount | null>(null)
function openFeed(a: SocialAccount) { feedFor.value = a; feedOpen.value = true }
/** A click on the row's own controls (links, buttons, checkbox, dropdown) is not a row click. */
const rowProps = (record: SocialAccount) => ({
  class: 'row-click',
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
}
/** Log message text; `group migrated: <name>` comes from the 分组 → 人设 data migration (older logs may mention groups). */
function logMessage(m: string) {
  if (LOG_MSG[m]) return t(LOG_MSG[m]!)
  if (m === 'automatic check') return t('social.msgAutoCheckShort')
  const c = /^automatic check on (.+?)(?:: (.*))?$/s.exec(m)
  if (c) return c[2] ? t('social.msgAutoCheckDetail', { device: c[1], detail: c[2] }) : t('social.msgAutoCheck', { device: c[1] })
  const g = /^group migrated: (.*)$/s.exec(m)
  return g ? t('social.msgGroupMigrated', { name: g[1] }) : m
}
const fieldText = (f: string | null) => (f ? t(`social.field.${f}`) : '')

// ---------------------------------------------------------------- batch
const batchTags = ref<string[]>([])
const batchPersona = ref<string | undefined>(undefined)
const selectedRows = computed(() => items.value.filter((i) => selectedKeys.value.includes(i.id)))
/** A personal persona fits only when every selected account has its owner. */
const batchOwner = computed(() => { const o = new Set(selectedRows.value.map((r) => r.userId)); return o.size === 1 ? [...o][0] : null })
/** set-persona: public personas fit every selection; personal ones only accounts of their owner. */
const batchPersonaOptions = computed(() => [
  { value: 'none', label: t('social.noPersona') },
  ...personasFor(batchOwner.value).map((p) => ({ value: p.id, label: personaLabel(p) })),
])
async function batch(action: 'set-persona' | 'add-tags' | 'remove-tags' | 'unlink' | 'delete') {
  const ids = [...selectedKeys.value]
  if (!ids.length) return
  const run = async () => {
    try {
      const body: Record<string, unknown> = { ids, action }
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
</script>

<template>
  <PageContainer :title="t('social.title')">
    <template #extra>
      <router-link v-slot="{ href, navigate }" to="/personas" custom><a-button :href="href" @click="navigate">{{ t('scripts.personas.manage') }}</a-button></router-link>
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
          <template v-else-if="column.key === 'checked'">
            <template v-if="record.lastCheckCode">
              <a-tooltip :title="record.lastCheckDetail ?? undefined"><a-tag :color="CHECK_COLOR[record.lastCheckCode]">{{ checkText(record.lastCheckCode) }}</a-tag></a-tooltip>
              <div class="muted small">{{ fmt(record.lastCheckedAt) }}</div>
            </template>
            <span v-else-if="record.autoCheckUnsupported" class="muted small">{{ t(`social.autoCheckUnsupported.${record.autoCheckUnsupported.replace('account_check.', '')}`) }}</span>
            <span v-else class="muted small">{{ record.lastCheckedAt ? fmt(record.lastCheckedAt) : t('social.notChecked') }}</span>
          </template>
          <template v-else-if="column.key === 'ops'">
            <a-space :size="0">
              <a-tooltip :title="record.instance?.accessible ? t('social.openDeviceHint') : t('social.openDeviceNone')">
                <a-button type="link" size="small" :disabled="!record.instance?.accessible" @click="router.push(`/instances/${record.instance.id}`)">{{ t('social.openDevice') }}</a-button>
              </a-tooltip>
              <a-tooltip :title="record.autoCheckUnsupported ? t(`social.autoCheckUnsupported.${record.autoCheckUnsupported.replace('account_check.', '')}`) : t('social.checkNowHint')">
                <a-button type="link" size="small" :disabled="!!record.autoCheckUnsupported" :loading="checking === record.id" @click="checkNow(record as SocialAccount)">{{ t('social.checkNow') }}</a-button>
              </a-tooltip>
              <a-dropdown>
                <a-button type="link" size="small">{{ t('social.more') }}</a-button>
                <template #overlay>
                  <a-menu>
                    <a-menu-item key="feed" @click="openFeed(record as SocialAccount)">{{ t('feed.tabs.posts') }}</a-menu-item>
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

  <SocialAccountFeedDrawer v-model:open="feedOpen" :account="feedFor" />

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
      <a-form-item :label="t('social.colPersona')" name="personaId">
        <a-select v-model:value="form.personaId" allow-clear show-search option-filter-prop="label" :placeholder="t('social.noPersona')"
          :options="formPersonas.map((p) => ({ value: p.id, label: personaLabel(p) }))" />
      </a-form-item>
      <a-form-item :label="t('social.colTags')" name="tags">
        <a-select v-model:value="form.tags" mode="tags" :options="allTags.map((x) => ({ value: x, label: x }))" />
      </a-form-item>
      <a-form-item :label="t('social.colDevice')" name="instanceId" :extra="formLimit ? t('social.deviceHint', { n: formLimit }) : undefined">
        <a-select v-model:value="form.instanceId" allow-clear show-search option-filter-prop="label" :options="deviceOptions" :placeholder="t('social.notLinked')" />
      </a-form-item>
      <a-form-item v-if="editing" :label="t('social.lastCheck')">
        <a-space wrap>
          <StatusTag kind="socialLogin" :status="editing.loginStatus" />
          <a-tag v-if="editing.lastCheckCode" :color="CHECK_COLOR[editing.lastCheckCode]">{{ checkText(editing.lastCheckCode) }}</a-tag>
          <span class="muted small">{{ editing.lastCheckedAt ? fmt(editing.lastCheckedAt) : t('social.notChecked') }}</span>
          <span v-if="editing.lastCheckDetail" class="muted small">{{ editing.lastCheckDetail }}</span>
          <a-button size="small" :disabled="!!editing.autoCheckUnsupported" :loading="checking === editing.id" @click="checkNow(editing)">{{ t('social.checkNow') }}</a-button>
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
.batch-bar { margin-bottom: var(--cp-gap); padding: 8px 12px; background: var(--cp-fill-alter); border-radius: 6px; }
.err-icon { color: var(--cp-error); margin-left: 4px; }
</style>
