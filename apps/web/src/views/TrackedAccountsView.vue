<script setup lang="ts">
import { dateLocale } from '../i18n'
import { message } from 'ant-design-vue'
import { PlusOutlined, StarFilled, StarOutlined } from '@ant-design/icons-vue'
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { queryParam } from '../api/query'
import { api, codeText, errorText } from '../api/client'
import {
  compactNumber, TRACKED_SCHEDULE_HOURS, trackedHandle,
  type ManagedUser, type TrackedAccount, type TrackedPlatform, type TrackedStatus,
} from '../api/types'
import { useAuthStore } from '../stores/auth'
import { usePlatformsStore } from '../stores/platforms'
import TrackedAccountDrawer from '../components/tracked/TrackedAccountDrawer.vue'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import StatusTag from '../components/common/StatusTag.vue'
import PlatformTag from '../components/social/PlatformTag.vue'
import { actionColumn, confirmDanger, MODAL_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'

/** 追踪账号: external public accounts the user observes (official API or manual data only). */
const { t } = useI18n()
const URL_HINT = 'https://'
const ADD_HINT = 'https://www.instagram.com/handle/'
const auth = useAuthStore()
const platformScope = usePlatformsStore()
const route = useRoute()
const router = useRouter()

const platforms = ref<TrackedPlatform[]>([])
const facets = ref<{ tags: string[] }>({ tags: [] })
const users = ref<ManagedUser[]>([])
const items = ref<TrackedAccount[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(50)
const loading = ref(false)
const selectedKeys = ref<string[]>([])

const filters = reactive({
  q: '', platform: undefined as string | undefined, tag: undefined as string | undefined,
  favorite: false, status: queryParam<TrackedStatus>(route.query, 'status', ['active', 'paused', 'error']), ownerId: undefined as string | undefined,
})
if (queryParam(route.query, 'platform')) filters.platform = queryParam(route.query, 'platform')
const platformLabel = (id: string) => platforms.value.find((p) => p.id === id)?.label ?? id

function query(): string {
  const p = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize.value) })
  if (filters.q.trim()) p.set('q', filters.q.trim())
  for (const k of ['platform', 'tag', 'status', 'ownerId'] as const) if (filters[k]) p.set(k, filters[k]!)
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
  Object.assign(filters, { q: '', platform: undefined, tag: undefined, favorite: false, status: undefined, ownerId: undefined })
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
  { title: t('tracked.tags'), key: 'tags', width: 180 },
  { title: t('tracked.metrics.followers'), key: 'followers', width: 130, align: 'right' as const },
  { title: t('tracked.lastChecked'), key: 'checked', width: 170 },
  ...(collectable.value.length ? [{ title: t('collect.schedule'), key: 'schedule', width: 170 }] : []),
  { title: t('common.status'), key: 'status', width: 150 },
  ...(auth.isAdmin ? [{ title: t('tracked.owner'), key: 'owner', width: 110 }] : []),
  actionColumn(230),
])
function onTableChange(p: { current?: number; pageSize?: number }) {
  if (p.pageSize && p.pageSize !== pageSize.value) { pageSize.value = p.pageSize; page.value = 1 } else page.value = p.current ?? 1
  void load()
}
/** 定时采集 interval label. */
const intervalText = (h: number | null) => (h === null ? t('collect.off') : h < 24 ? t('collect.everyHours', { n: h }) : t('collect.everyDays', { n: h / 24 }))
const scheduleOptions = computed(() => [{ value: 0, label: t('collect.off') }, ...TRACKED_SCHEDULE_HOURS.map((h) => ({ value: h, label: intervalText(h) }))])
async function runScheduler() {
  try { await api('POST', '/api/collection/run'); message.info(t('collect.runQueued')); setTimeout(() => void load(true), 3000) } catch (e) { message.error(errorText(e)) }
}
const replace = (a: TrackedAccount) => {
  items.value = items.value.map((x) => (x.id === a.id ? a : x))
  if (detail.value?.id === a.id) detail.value = a
  schedulePoll()
}

async function toggleFavorite(a: TrackedAccount) {
  try { replace((await api<{ account: TrackedAccount }>('PATCH', `/api/tracked-accounts/${a.id}`, { favorite: !a.favorite })).account) } catch (e) { message.error(errorText(e)) }
}
/**
 * Refresh / 定时采集 exist only for platforms with an official API source (YouTube). Manual-only platforms
 * (Instagram, TikTok) get no refresh action and no schedule controls: their numbers are entered by hand.
 */
const canCollect = (a: TrackedAccount) => a.dataMode !== 'manual_only'
const collectable = computed(() => items.value.filter(canCollect))
const selectedCollectable = computed(() => collectable.value.filter((a) => selectedKeys.value.includes(a.id)).length)
async function refreshOne(a: TrackedAccount) {
  try {
    await api('POST', `/api/tracked-accounts/${a.id}/refresh`)
    message.info(t('tracked.refreshQueued'))
    await load(true)
  } catch (e) { message.error(errorText(e)) }
}
async function refreshBatch() {
  const ok = new Set(collectable.value.map((a) => a.id))
  const ids = selectedKeys.value.length ? selectedKeys.value.filter((k) => ok.has(k)) : [...ok]
  if (!ids.length) return
  try {
    const r = await api<{ queued: { id: string }[]; skipped: { id: string; code: string }[] }>('POST', '/api/tracked-accounts/refresh', { ids })
    const reasons = [...new Set(r.skipped.map((s) => codeText(s.code, undefined, s.code)))].join(t('common.reasonSep'))
    message.info(t('tracked.batchQueued', { queued: r.queued.length }) + (r.skipped.length ? ` ${t('common.skipped', { n: r.skipped.length, reasons })}` : ''))
    await load(true)
  } catch (e) { message.error(errorText(e)) }
}
function remove(a: TrackedAccount) {
  confirmDanger({
    title: t('tracked.confirmDelete', { name: a.displayName || trackedHandle(a) }), content: t('tracked.confirmDeleteHint'),
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
const addForm = reactive({ platform: undefined as string | undefined, input: '', displayName: '', tags: [] as string[], favorite: false, notes: '' })
const preview = ref<{ platform: string; handle: string; profileUrl: string } | null>(null)
const previewError = ref('')
function openAdd() {
  Object.assign(addForm, { platform: undefined, input: '', displayName: '', tags: [], favorite: false, notes: '' })
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
      input: addForm.input, platform: addForm.platform, displayName: addForm.displayName || undefined,
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
const editForm = reactive({ displayName: '', avatarUrl: '', bio: '', tags: [] as string[], status: 'active' as 'active' | 'paused', notes: '', interval: 0 })
function openEdit(a: TrackedAccount) {
  editing.value = a
  Object.assign(editForm, {
    displayName: a.displayName ?? '', avatarUrl: a.avatarUrl ?? '', bio: a.bio ?? '', tags: [...a.tags],
    status: a.status === 'paused' ? 'paused' : 'active', notes: a.notes ?? '', interval: a.refreshIntervalHours ?? 0,
  })
  editOpen.value = true
}
async function saveEdit() {
  if (!editing.value) return
  editSaving.value = true
  try {
    const r = await api<{ account: TrackedAccount }>('PATCH', `/api/tracked-accounts/${editing.value.id}`, {
      displayName: editForm.displayName, avatarUrl: editForm.avatarUrl.trim() || null, bio: editForm.bio,
      tags: editForm.tags, notes: editForm.notes,
      ...(editing.value.status === 'error' || editing.value.status !== editForm.status ? { status: editForm.status } : {}),
      ...((editing.value.refreshIntervalHours ?? 0) !== editForm.interval ? { refreshIntervalHours: editForm.interval || null } : {}),
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
</script>

<template>
  <PageContainer :title="t('tracked.title')">
    <template #extra>
      <a-button v-if="auth.isAdmin && platformScope.scope.features.youtubeKey" @click="router.push({ path: '/settings', query: { tab: 'tracked' } })">{{ t('tracked.youtubeKey') }}</a-button>
      <a-button v-if="auth.isAdmin" @click="runScheduler">{{ t('collect.runNow') }}</a-button>
      <a-button type="primary" @click="openAdd"><template #icon><PlusOutlined /></template>{{ t('tracked.add') }}</a-button>
    </template>

    <a-card :bordered="false">
      <SearchBar :loading="loading" @reset="reset" @refresh="load()">
        <a-input-search v-model:value="filters.q" :placeholder="t('tracked.searchPlaceholder')" allow-clear style="width: 220px" @search="search" />
        <a-select v-model:value="filters.platform" :placeholder="t('tracked.colPlatform')" allow-clear style="width: 130px" @change="search">
          <a-select-option v-for="p in platforms" :key="p.id" :value="p.id"><PlatformTag :platform="p.id" :name="p.label" /></a-select-option>
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
        <template #actions>
          <a-button v-if="collectable.length" @click="refreshBatch">
            {{ t('tracked.refreshBatch') }}{{ selectedCollectable ? ` (${selectedCollectable})` : '' }}
          </a-button>
        </template>
      </SearchBar>

      <a-table
        :data-source="items" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :scroll="{ x: 1580 }"
        :pagination="pagination({ current: page, pageSize, total, totalText: (n) => t('tracked.total', { n }) })"
        :row-selection="{ selectedRowKeys: selectedKeys, onChange: (k: any[]) => (selectedKeys = k as string[]) }"
        @change="onTableChange"
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
                <a class="ellipsis name" @click="openDetail(record as TrackedAccount)">{{ record.displayName || trackedHandle(record) }}</a>
                <a :href="record.profileUrl" target="_blank" rel="noopener noreferrer" class="muted small">{{ trackedHandle(record) }}</a>
              </div>
            </div>
          </template>
          <template v-else-if="column.key === 'platform'"><PlatformTag :platform="record.platform" :name="platformLabel(record.platform)" /></template>
          <template v-else-if="column.key === 'tags'">
            <a-tag v-for="tg in record.tags" :key="tg" class="small-tag">{{ tg }}</a-tag>
            <span v-if="!record.tags.length" class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'followers'">
            <a-tooltip :title="record.followers !== null ? record.followers.toLocaleString(dateLocale()) : undefined">
              <span class="num">{{ compactNumber(record.followers) }}</span>
            </a-tooltip>
            <div v-if="record.followersDelta !== null" :class="['delta small', record.followersDelta >= 0 ? 'up' : 'down']">
              {{ record.followersDelta >= 0 ? '+' : '' }}{{ compactNumber(record.followersDelta) }}
            </div>
          </template>
          <template v-else-if="column.key === 'checked'">
            <span v-if="record.lastCheckedAt">{{ new Date(record.lastCheckedAt).toLocaleString(dateLocale()) }}</span>
            <span v-else class="muted">{{ t('tracked.never') }}</span>
            <div v-if="record.lastSource" class="muted small">{{ t(`tracked.sources.${record.lastSource}`) }}</div>
          </template>
          <template v-else-if="column.key === 'schedule'">
            <span v-if="record.dataMode === 'manual_only'" class="muted small">{{ t('collect.manualOnly') }}</span>
            <template v-else>
              <span :class="{ muted: record.refreshIntervalHours === null }">{{ intervalText(record.refreshIntervalHours) }}</span>
              <div v-if="record.nextRefreshAt" class="muted small">{{ t('collect.next', { time: new Date(record.nextRefreshAt).toLocaleString(dateLocale()) }) }}</div>
              <div v-if="record.scheduleSkipCode" class="warn small">{{ t('collect.skipped', { reason: codeText(record.scheduleSkipCode, undefined, record.scheduleSkipCode) }) }}</div>
            </template>
          </template>
          <template v-else-if="column.key === 'status'">
            <a-tooltip :title="record.status === 'error' ? codeText(record.lastErrorCode, undefined, record.lastError ?? '') : undefined">
              <StatusTag kind="tracked" :status="record.status" />
            </a-tooltip>
            <a-tag v-if="busy(record as TrackedAccount)" color="processing">{{ t('tracked.refreshing') }}</a-tag>
            <div class="muted small">{{ t(`tracked.dataModes.${record.dataMode}`) }}</div>
          </template>
          <template v-else-if="column.key === 'owner'">{{ record.ownerName ?? '—' }}</template>
          <template v-else-if="column.key === 'ops'">
            <a-space :size="0">
              <a-button size="small" type="link" @click="openDetail(record as TrackedAccount)">{{ t('common.view') }}</a-button>
              <a-tooltip v-if="canCollect(record as TrackedAccount)" :title="record.dataMode === 'api_unconfigured' ? t('tracked.apiUnconfiguredHint') : record.status === 'paused' ? t('errors.tracked.paused') : undefined">
                <a-button size="small" type="link" :disabled="record.status === 'paused' || record.dataMode === 'api_unconfigured'" :loading="busy(record as TrackedAccount)"
                  @click="refreshOne(record as TrackedAccount)">{{ t('common.refresh') }}</a-button>
              </a-tooltip>
              <a-dropdown>
                <a-button size="small" type="link">{{ t('common.more') }}</a-button>
                <template #overlay>
                  <a-menu>
                    <a-menu-item key="edit" @click="openEdit(record as TrackedAccount)">{{ t('common.edit') }}</a-menu-item>
                    <a-menu-item key="delete" danger @click="remove(record as TrackedAccount)">{{ t('common.delete') }}</a-menu-item>
                  </a-menu>
                </template>
              </a-dropdown>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-card>
  </PageContainer>

  <TrackedAccountDrawer v-model:open="detailOpen" :account="detail" :platforms="platforms" @changed="replace" @edit="openEdit" @refresh="refreshOne" />

  <a-modal v-model:open="addOpen" :title="t('tracked.add')" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" :confirm-loading="adding" :width="MODAL_WIDTH.md" @ok="saveAdd">
    <a-form layout="vertical" :model="addForm">
      <a-form-item :label="t('tracked.input')" :validate-status="previewError ? 'error' : undefined" :help="previewError || undefined">
        <a-input-group compact style="display: flex">
          <a-select v-model:value="addForm.platform" :placeholder="t('tracked.autoPlatform')" allow-clear style="width: 140px" @change="parseInput">
            <a-select-option v-for="p in platforms" :key="p.id" :value="p.id"><PlatformTag :platform="p.id" :name="p.label" /></a-select-option>
          </a-select>
          <a-input v-model:value="addForm.input" :maxlength="500" :placeholder="ADD_HINT" style="flex: 1" @blur="parseInput" @press-enter="parseInput" />
        </a-input-group>
      </a-form-item>
      <div v-if="preview" class="preview small">
        {{ t('tracked.willTrack') }} <PlatformTag :platform="preview.platform" :name="platformLabel(preview.platform)" />
        <a :href="preview.profileUrl" target="_blank" rel="noopener noreferrer">{{ trackedHandle(preview) }}</a>
      </div>
      <a-form-item :label="t('tracked.displayName')"><a-input v-model:value="addForm.displayName" :maxlength="200" :placeholder="t('common.optional')" /></a-form-item>
      <a-form-item :label="t('tracked.tags')"><a-select v-model:value="addForm.tags" mode="tags" :options="tagOptions" :max-tag-count="6" /></a-form-item>
      <a-form-item :label="t('tracked.notes')"><a-textarea v-model:value="addForm.notes" :maxlength="1000" :auto-size="{ minRows: 2, maxRows: 4 }" /></a-form-item>
      <a-checkbox v-model:checked="addForm.favorite">{{ t('tracked.favorite') }}</a-checkbox>
    </a-form>
  </a-modal>

  <a-modal v-model:open="editOpen" :title="editing ? `${t('common.edit')} · ${trackedHandle(editing)}` : ''" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" :confirm-loading="editSaving" :width="MODAL_WIDTH.md" @ok="saveEdit">
    <a-form layout="vertical" :model="editForm">
      <a-form-item :label="t('tracked.displayName')"><a-input v-model:value="editForm.displayName" :maxlength="200" /></a-form-item>
      <a-form-item :label="t('tracked.avatarUrl')"><a-input v-model:value="editForm.avatarUrl" :maxlength="1000" :placeholder="URL_HINT" /></a-form-item>
      <a-form-item :label="t('tracked.bio')"><a-textarea v-model:value="editForm.bio" :maxlength="2000" :auto-size="{ minRows: 2, maxRows: 5 }" /></a-form-item>
      <a-form-item :label="t('tracked.tags')"><a-select v-model:value="editForm.tags" mode="tags" :options="tagOptions" /></a-form-item>
      <a-row :gutter="12">
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('tracked.trackingStatus')">
            <a-radio-group v-model:value="editForm.status">
              <a-radio-button value="active">{{ t('tracked.status.active') }}</a-radio-button>
              <a-radio-button value="paused">{{ t('tracked.status.paused') }}</a-radio-button>
            </a-radio-group>
          </a-form-item>
        </a-col>
        <a-col v-if="editing && canCollect(editing)" :xs="24" :sm="12">
          <a-form-item :label="t('collect.interval')">
            <a-select v-model:value="editForm.interval" :options="scheduleOptions" />
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item :label="t('tracked.notes')"><a-textarea v-model:value="editForm.notes" :maxlength="1000" :auto-size="{ minRows: 2, maxRows: 4 }" /></a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.small-tag { font-size: 11px; margin-top: 2px; }
.acct { display: flex; align-items: center; gap: 8px; min-width: 0; }
.acct-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.acct-text .name { font-weight: 500; }
.num { font-variant-numeric: tabular-nums; }
.delta.up { color: var(--cp-primary); }
.delta.down { color: var(--cp-error); }
.star { color: var(--cp-text-quaternary); }
.star.on { color: var(--cp-warning); }
.warn { color: var(--cp-warning); }
.preview { margin: -8px 0 12px; }
</style>

