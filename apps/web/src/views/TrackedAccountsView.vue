<script setup lang="ts">
import { message, Modal } from 'ant-design-vue'
import { StarFilled, StarOutlined } from '@ant-design/icons-vue'
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { queryParam } from '../api/query'
import { api, codeText, errorText } from '../api/client'
import {
  compactNumber, TRACKED_STATUS_COLOR, trackedHandle,
  type ManagedUser, type TrackedAccount, type TrackedPlatform, type TrackedStatus,
} from '../api/types'
import { useAuthStore } from '../stores/auth'
import TrackedAccountDrawer from '../components/tracked/TrackedAccountDrawer.vue'

/** 追踪账号: external public accounts the user observes (official API or manual data only). */
const { t } = useI18n()
const URL_HINT = 'https://'
const ADD_HINT = 'https://www.youtube.com/@handle'
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const platforms = ref<TrackedPlatform[]>([])
const facets = ref<{ categories: string[]; tags: string[] }>({ categories: [], tags: [] })
const users = ref<ManagedUser[]>([])
const items = ref<TrackedAccount[]>([])
const total = ref(0)
const page = ref(1)
const PAGE_SIZE = 50
const loading = ref(false)
const selectedKeys = ref<string[]>([])

const filters = reactive({
  q: '', platform: undefined as string | undefined, category: undefined as string | undefined, tag: undefined as string | undefined,
  favorite: false, status: queryParam<TrackedStatus>(route.query, 'status', ['active', 'paused', 'error']), ownerId: undefined as string | undefined,
})
if (queryParam(route.query, 'platform')) filters.platform = queryParam(route.query, 'platform')
const platformLabel = (id: string) => platforms.value.find((p) => p.id === id)?.label ?? id

function query(): string {
  const p = new URLSearchParams({ page: String(page.value), pageSize: String(PAGE_SIZE) })
  if (filters.q.trim()) p.set('q', filters.q.trim())
  for (const k of ['platform', 'category', 'tag', 'status', 'ownerId'] as const) if (filters[k]) p.set(k, filters[k]!)
  if (filters.favorite) p.set('favorite', 'true')
  return p.toString()
}
async function load(quiet = false) {
  if (!quiet) loading.value = true
  try {
    const r = await api<{ items: TrackedAccount[]; total: number }>('GET', `/api/tracked-accounts?${query()}`)
    items.value = r.items
    total.value = r.total
    const ids = new Set(r.items.map((x) => x.id))
    selectedKeys.value = selectedKeys.value.filter((k) => ids.has(k))
    if (detail.value) detail.value = r.items.find((x) => x.id === detail.value!.id) ?? detail.value
    schedulePoll()
  } catch (e) { if (!quiet) message.error(errorText(e)) }
  finally { loading.value = false }
}
async function loadFacets() {
  try {
    facets.value = await api('GET', `/api/tracked-accounts/facets${filters.ownerId ? `?ownerId=${filters.ownerId}` : ''}`)
  } catch { /* suggestions only */ }
}
async function loadPlatforms() {
  try { platforms.value = (await api<{ platforms: TrackedPlatform[] }>('GET', '/api/tracked-accounts/platforms')).platforms } catch (e) { message.error(errorText(e)) }
}
function search() { page.value = 1; void load() }
function reset() {
  Object.assign(filters, { q: '', platform: undefined, category: undefined, tag: undefined, favorite: false, status: undefined, ownerId: undefined })
  search(); void loadFacets()
}
onMounted(async () => {
  await loadPlatforms()
  void load(); void loadFacets()
  if (auth.isAdmin) { try { users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users } catch { /* filter only */ } }
})

// Poll while refresh tasks are queued/running.
let pollTimer: ReturnType<typeof setTimeout> | null = null
const busy = (a: TrackedAccount) => ['pending', 'scheduled', 'running'].includes(a.lastRefresh?.status ?? '')
function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = items.value.some(busy) ? setTimeout(() => void load(true), 2000) : null
}
onBeforeUnmount(() => { if (pollTimer) clearTimeout(pollTimer) })

const columns = computed(() => [
  { title: '', key: 'favorite', width: 44 },
  { title: t('tracked.colAccount'), key: 'account', width: 250 },
  { title: t('tracked.colPlatform'), key: 'platform', width: 110 },
  { title: t('tracked.colCategory'), key: 'category', width: 180 },
  { title: t('tracked.metrics.followers'), key: 'followers', width: 130, align: 'right' as const },
  { title: t('tracked.lastChecked'), key: 'checked', width: 170 },
  { title: t('common.status'), key: 'status', width: 150 },
  ...(auth.isAdmin ? [{ title: t('tracked.owner'), key: 'owner', width: 110 }] : []),
  { title: '', key: 'ops', width: 200, align: 'right' as const },
])
const replace = (a: TrackedAccount) => {
  items.value = items.value.map((x) => (x.id === a.id ? a : x))
  if (detail.value?.id === a.id) detail.value = a
  schedulePoll()
}

async function toggleFavorite(a: TrackedAccount) {
  try { replace((await api<{ account: TrackedAccount }>('PATCH', `/api/tracked-accounts/${a.id}`, { favorite: !a.favorite })).account) } catch (e) { message.error(errorText(e)) }
}
async function refreshOne(a: TrackedAccount) {
  try {
    const r = await api<{ taskId: string; manualOnly: boolean }>('POST', `/api/tracked-accounts/${a.id}/refresh`)
    message.info(r.manualOnly ? t('tracked.refreshManualOnly') : t('tracked.refreshQueued'))
    await load(true)
  } catch (e) { message.error(errorText(e)) }
}
async function refreshBatch() {
  const ids = selectedKeys.value.length ? [...selectedKeys.value] : items.value.map((a) => a.id)
  if (!ids.length) return
  try {
    const r = await api<{ queued: { id: string }[]; skipped: { id: string; code: string }[] }>('POST', '/api/tracked-accounts/refresh', { ids })
    const reasons = [...new Set(r.skipped.map((s) => codeText(s.code, undefined, s.code)))].join(t('common.reasonSep'))
    message.info(t('tracked.batchQueued', { queued: r.queued.length }) + (r.skipped.length ? ` ${t('common.skipped', { n: r.skipped.length, reasons })}` : ''))
    await load(true)
  } catch (e) { message.error(errorText(e)) }
}
function remove(a: TrackedAccount) {
  Modal.confirm({
    title: t('tracked.confirmDelete', { name: a.displayName || trackedHandle(a) }), content: t('tracked.confirmDeleteHint'),
    okType: 'danger', okText: t('common.delete'), cancelText: t('common.cancel'),
    onOk: async () => {
      try {
        await api('DELETE', `/api/tracked-accounts/${a.id}`)
        message.success(t('common.deleted'))
        if (detail.value?.id === a.id) detailOpen.value = false
        void load(); void loadFacets()
      } catch (e) { message.error(errorText(e)) }
    },
  })
}

// ---- add
const addOpen = ref(false)
const adding = ref(false)
const addForm = reactive({ platform: undefined as string | undefined, input: '', displayName: '', category: '', tags: [] as string[], favorite: false, notes: '' })
const preview = ref<{ platform: string; handle: string; profileUrl: string } | null>(null)
const previewError = ref('')
function openAdd() {
  Object.assign(addForm, { platform: undefined, input: '', displayName: '', category: '', tags: [], favorite: false, notes: '' })
  preview.value = null; previewError.value = ''
  addOpen.value = true
}
async function parseInput() {
  preview.value = null; previewError.value = ''
  if (!addForm.input.trim()) return
  try {
    preview.value = (await api<{ profile: { platform: string; handle: string; profileUrl: string } }>('POST', '/api/tracked-accounts/parse', { input: addForm.input, platform: addForm.platform })).profile
  } catch (e) { previewError.value = errorText(e) }
}
async function saveAdd() {
  if (!addForm.input.trim()) { previewError.value = t('errors.tracked.input_required'); return }
  adding.value = true
  try {
    await api('POST', '/api/tracked-accounts', {
      input: addForm.input, platform: addForm.platform, displayName: addForm.displayName || undefined, category: addForm.category || undefined,
      tags: addForm.tags, favorite: addForm.favorite, notes: addForm.notes || undefined,
    })
    message.success(t('common.created'))
    addOpen.value = false
    void load(); void loadFacets()
  } catch (e) { message.error(errorText(e)) }
  finally { adding.value = false }
}

// ---- edit
const editOpen = ref(false)
const editSaving = ref(false)
const editing = ref<TrackedAccount | null>(null)
const editForm = reactive({ displayName: '', avatarUrl: '', bio: '', category: '', tags: [] as string[], status: 'active' as 'active' | 'paused', notes: '' })
function openEdit(a: TrackedAccount) {
  editing.value = a
  Object.assign(editForm, {
    displayName: a.displayName ?? '', avatarUrl: a.avatarUrl ?? '', bio: a.bio ?? '', category: a.category ?? '', tags: [...a.tags],
    status: a.status === 'paused' ? 'paused' : 'active', notes: a.notes ?? '',
  })
  editOpen.value = true
}
async function saveEdit() {
  if (!editing.value) return
  editSaving.value = true
  try {
    const r = await api<{ account: TrackedAccount }>('PATCH', `/api/tracked-accounts/${editing.value.id}`, {
      displayName: editForm.displayName, avatarUrl: editForm.avatarUrl.trim() || null, bio: editForm.bio, category: editForm.category,
      tags: editForm.tags, notes: editForm.notes,
      ...(editing.value.status === 'error' || editing.value.status !== editForm.status ? { status: editForm.status } : {}),
    })
    replace(r.account)
    message.success(t('common.saved'))
    editOpen.value = false
    void loadFacets()
  } catch (e) { message.error(errorText(e)) }
  finally { editSaving.value = false }
}

// ---- detail
const detailOpen = ref(false)
const detail = ref<TrackedAccount | null>(null)
function openDetail(a: TrackedAccount) { detail.value = a; detailOpen.value = true }

const tagOptions = computed(() => facets.value.tags.map((v) => ({ value: v })))
const categoryOptions = computed(() => facets.value.categories.map((v) => ({ value: v })))
</script>

<template>
  <a-card :title="t('tracked.title')" size="small">
    <template #extra>
      <a-space wrap>
        <a-button v-if="auth.isAdmin" @click="router.push({ path: '/settings', query: { tab: 'tracked' } })">{{ t('tracked.youtubeKey') }}</a-button>
        <a-button :disabled="!items.length" @click="refreshBatch">
          {{ t('tracked.refreshBatch') }}{{ selectedKeys.length ? ` (${selectedKeys.length})` : '' }}
        </a-button>
        <a-button type="primary" @click="openAdd">{{ t('tracked.add') }}</a-button>
      </a-space>
    </template>

    <a-space wrap style="margin-bottom: 12px">
      <a-input-search v-model:value="filters.q" :placeholder="t('tracked.searchPlaceholder')" allow-clear style="width: 220px" @search="search" />
      <a-select v-model:value="filters.platform" :placeholder="t('tracked.colPlatform')" allow-clear style="width: 130px" @change="search">
        <a-select-option v-for="p in platforms" :key="p.id" :value="p.id">{{ p.label }}</a-select-option>
      </a-select>
      <a-select v-model:value="filters.category" :placeholder="t('tracked.colCategory')" allow-clear show-search style="width: 150px" @change="search">
        <a-select-option value="none">{{ t('tracked.uncategorized') }}</a-select-option>
        <a-select-option v-for="c in facets.categories" :key="c" :value="c">{{ c }}</a-select-option>
      </a-select>
      <a-select v-model:value="filters.tag" :placeholder="t('tracked.tag')" allow-clear show-search style="width: 130px" @change="search">
        <a-select-option v-for="tg in facets.tags" :key="tg" :value="tg">{{ tg }}</a-select-option>
      </a-select>
      <a-select v-model:value="filters.status" :placeholder="t('common.status')" allow-clear style="width: 120px" @change="search">
        <a-select-option v-for="s in (['active', 'paused', 'error'] as const)" :key="s" :value="s">{{ t(`tracked.status.${s}`) }}</a-select-option>
      </a-select>
      <a-select v-if="auth.isAdmin" v-model:value="filters.ownerId" :placeholder="t('tracked.owner')" allow-clear show-search option-filter-prop="label" style="width: 140px"
        :options="users.map((u) => ({ value: u.id, label: u.username }))" @change="() => { search(); loadFacets() }" />
      <a-checkbox v-model:checked="filters.favorite" @change="search">{{ t('tracked.favoritesOnly') }}</a-checkbox>
      <a-button @click="reset">{{ t('common.reset') }}</a-button>
      <span class="muted">{{ t('tracked.total', { n: total }) }}</span>
    </a-space>

    <a-table
      :data-source="items" :columns="columns" row-key="id" size="middle" :loading="loading" :scroll="{ x: 1300 }"
      :pagination="{ current: page, pageSize: PAGE_SIZE, total, size: 'small', hideOnSinglePage: true, showSizeChanger: false, onChange: (p: number) => { page = p; load() } }"
      :row-selection="{ selectedRowKeys: selectedKeys, onChange: (k: any[]) => (selectedKeys = k as string[]) }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'favorite'">
          <a-button type="text" size="small" :class="['star', { on: record.favorite }]" :aria-label="t('tracked.favorite')" @click="toggleFavorite(record as TrackedAccount)">
            <StarFilled v-if="record.favorite" /><StarOutlined v-else />
          </a-button>
        </template>
        <template v-else-if="column.key === 'account'">
          <div class="acct">
            <a-avatar v-if="record.avatarUrl" :src="record.avatarUrl" size="small" referrerpolicy="no-referrer" />
            <a-avatar v-else size="small">{{ (record.displayName || record.handle).charAt(0).toUpperCase() }}</a-avatar>
            <div class="acct-text">
              <a class="name" @click="openDetail(record as TrackedAccount)">{{ record.displayName || trackedHandle(record) }}</a>
              <a :href="record.profileUrl" target="_blank" rel="noopener noreferrer" class="muted small">{{ trackedHandle(record) }}</a>
            </div>
          </div>
        </template>
        <template v-else-if="column.key === 'platform'"><a-tag>{{ platformLabel(record.platform) }}</a-tag></template>
        <template v-else-if="column.key === 'category'">
          <div>{{ record.category || '—' }}</div>
          <a-tag v-for="tg in record.tags" :key="tg" class="small-tag">{{ tg }}</a-tag>
        </template>
        <template v-else-if="column.key === 'followers'">
          <a-tooltip :title="record.followers !== null ? record.followers.toLocaleString() : undefined">
            <span class="num">{{ compactNumber(record.followers) }}</span>
          </a-tooltip>
          <div v-if="record.followersDelta !== null" :class="['delta small', record.followersDelta >= 0 ? 'up' : 'down']">
            {{ record.followersDelta >= 0 ? '+' : '' }}{{ compactNumber(record.followersDelta) }}
          </div>
        </template>
        <template v-else-if="column.key === 'checked'">
          <span v-if="record.lastCheckedAt">{{ new Date(record.lastCheckedAt).toLocaleString() }}</span>
          <span v-else class="muted">{{ t('tracked.never') }}</span>
          <div v-if="record.lastSource" class="muted small">{{ t(`tracked.sources.${record.lastSource}`) }}</div>
        </template>
        <template v-else-if="column.key === 'status'">
          <a-tooltip :title="record.status === 'error' ? codeText(record.lastErrorCode, undefined, record.lastError ?? '') : undefined">
            <a-tag :color="TRACKED_STATUS_COLOR[record.status as TrackedStatus]">{{ t(`tracked.status.${record.status}`) }}</a-tag>
          </a-tooltip>
          <a-tag v-if="busy(record as TrackedAccount)" color="processing">{{ t('tracked.refreshing') }}</a-tag>
          <div class="muted small">{{ t(`tracked.dataModes.${record.dataMode}`) }}</div>
        </template>
        <template v-else-if="column.key === 'owner'">{{ record.ownerName ?? '—' }}</template>
        <template v-else-if="column.key === 'ops'">
          <a-space :size="0">
            <a-button size="small" type="link" @click="openDetail(record as TrackedAccount)">{{ t('common.view') }}</a-button>
            <a-tooltip :title="record.dataMode === 'api_unconfigured' ? t('tracked.apiUnconfiguredHint') : record.status === 'paused' ? t('errors.tracked.paused') : undefined">
              <a-button size="small" type="link" :disabled="record.status === 'paused' || record.dataMode === 'api_unconfigured'" :loading="busy(record as TrackedAccount)"
                @click="refreshOne(record as TrackedAccount)">{{ t('common.refresh') }}</a-button>
            </a-tooltip>
            <a-button size="small" type="link" @click="openEdit(record as TrackedAccount)">{{ t('common.edit') }}</a-button>
            <a-button size="small" type="link" danger @click="remove(record as TrackedAccount)">{{ t('common.delete') }}</a-button>
          </a-space>
        </template>
      </template>
    </a-table>
    <div class="faint small" style="margin-top: 8px">{{ t('tracked.complianceHint') }}</div>
  </a-card>

  <TrackedAccountDrawer v-model:open="detailOpen" :account="detail" :platforms="platforms" @changed="replace" @edit="openEdit" @refresh="refreshOne" />

  <a-modal v-model:open="addOpen" :title="t('tracked.add')" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" :confirm-loading="adding" :width="600" @ok="saveAdd">
    <a-form layout="vertical" :model="addForm">
      <a-form-item :label="t('tracked.input')" :extra="t('tracked.inputHint')" :validate-status="previewError ? 'error' : undefined" :help="previewError || undefined">
        <a-input-group compact style="display: flex">
          <a-select v-model:value="addForm.platform" :placeholder="t('tracked.autoPlatform')" allow-clear style="width: 140px" @change="parseInput">
            <a-select-option v-for="p in platforms" :key="p.id" :value="p.id">{{ p.label }}</a-select-option>
          </a-select>
          <a-input v-model:value="addForm.input" :maxlength="500" :placeholder="ADD_HINT" style="flex: 1" @blur="parseInput" @press-enter="parseInput" />
        </a-input-group>
      </a-form-item>
      <div v-if="preview" class="preview small">
        {{ t('tracked.willTrack') }} <a-tag>{{ platformLabel(preview.platform) }}</a-tag>
        <a :href="preview.profileUrl" target="_blank" rel="noopener noreferrer">{{ trackedHandle(preview) }}</a>
      </div>
      <a-form-item :label="t('tracked.displayName')"><a-input v-model:value="addForm.displayName" :maxlength="200" :placeholder="t('common.optional')" /></a-form-item>
      <a-row :gutter="12">
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('tracked.colCategory')"><a-auto-complete v-model:value="addForm.category" :options="categoryOptions" :maxlength="50" /></a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('tracked.tags')"><a-select v-model:value="addForm.tags" mode="tags" :options="tagOptions" :max-tag-count="6" /></a-form-item>
        </a-col>
      </a-row>
      <a-form-item :label="t('tracked.notes')"><a-textarea v-model:value="addForm.notes" :maxlength="1000" :auto-size="{ minRows: 2, maxRows: 4 }" /></a-form-item>
      <a-checkbox v-model:checked="addForm.favorite">{{ t('tracked.favorite') }}</a-checkbox>
    </a-form>
  </a-modal>

  <a-modal v-model:open="editOpen" :title="editing ? `${t('common.edit')} · ${trackedHandle(editing)}` : ''" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" :confirm-loading="editSaving" :width="600" @ok="saveEdit">
    <a-form layout="vertical" :model="editForm">
      <a-form-item :label="t('tracked.displayName')"><a-input v-model:value="editForm.displayName" :maxlength="200" /></a-form-item>
      <a-form-item :label="t('tracked.avatarUrl')"><a-input v-model:value="editForm.avatarUrl" :maxlength="1000" :placeholder="URL_HINT" /></a-form-item>
      <a-form-item :label="t('tracked.bio')"><a-textarea v-model:value="editForm.bio" :maxlength="2000" :auto-size="{ minRows: 2, maxRows: 5 }" /></a-form-item>
      <a-row :gutter="12">
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('tracked.colCategory')"><a-auto-complete v-model:value="editForm.category" :options="categoryOptions" :maxlength="50" /></a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('tracked.tags')"><a-select v-model:value="editForm.tags" mode="tags" :options="tagOptions" /></a-form-item>
        </a-col>
      </a-row>
      <a-form-item :label="t('tracked.trackingStatus')">
        <a-radio-group v-model:value="editForm.status">
          <a-radio-button value="active">{{ t('tracked.status.active') }}</a-radio-button>
          <a-radio-button value="paused">{{ t('tracked.status.paused') }}</a-radio-button>
        </a-radio-group>
      </a-form-item>
      <a-form-item :label="t('tracked.notes')"><a-textarea v-model:value="editForm.notes" :maxlength="1000" :auto-size="{ minRows: 2, maxRows: 4 }" /></a-form-item>
    </a-form>
  </a-modal>

</template>

<style scoped>
.muted { color: var(--cp-text-tertiary); }
.faint { color: var(--cp-text-quaternary); }
.small { font-size: 12px; }
.small-tag { font-size: 11px; margin-top: 2px; }
.acct { display: flex; align-items: center; gap: 8px; min-width: 0; }
.acct-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.acct-text .name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.num { font-variant-numeric: tabular-nums; }
.delta.up { color: var(--cp-primary); }
.delta.down { color: var(--cp-error); }
.star { color: var(--cp-text-quaternary); }
.star.on { color: var(--cp-warning); }
.preview { margin: -8px 0 12px; }
</style>
