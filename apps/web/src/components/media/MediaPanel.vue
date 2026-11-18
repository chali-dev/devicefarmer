<script setup lang="ts">
import { dateLocale } from '../../i18n'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  AppstoreOutlined, BarsOutlined, CloudUploadOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, EyeOutlined, FolderOutlined, LoadingOutlined,
  PictureOutlined, PlayCircleFilled, SendOutlined, StarFilled, StarOutlined, VideoCameraOutlined,
} from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { ManagedUser, MediaCategory, MediaItem, MediaLimits, MediaScope } from '../../api/types'
import { useAuthStore } from '../../stores/auth'
import { useInstancesStore } from '../../stores/instances'
import BatchActions, { type BatchItem } from '../common/BatchActions.vue'
import SearchBar from '../common/SearchBar.vue'
import StatusTag from '../common/StatusTag.vue'
import { actionColumn, confirmDanger, MODAL_WIDTH, pagination, TABLE_SIZE } from '../common/ui'
import ScopedListManager from '../common/ScopedListManager.vue'
import MediaUploader from './MediaUploader.vue'
import { fetchAuthBlob, fmtDuration, fmtSize, useThumbs } from './media'

/** One tab of the media library: public, mine (admin: any user's private media) or favorites. */
const props = defineProps<{ tab: 'public' | 'mine' | 'favorites'; limits: MediaLimits | null }>()
const auth = useAuthStore()
const store = useInstancesStore()
const { t } = useI18n()
const errMsg = errorText

// ---------------------------------------------------------------- filters
/** Admin, "mine" tab: '' = own media, '*' = every user's private media, else a user id. */
const owner = ref('')
const users = ref<ManagedUser[]>([])
const apiScope = computed<MediaScope>(() => (props.tab === 'mine' && auth.isAdmin && owner.value ? 'all-users' : props.tab))
const ownerId = computed(() => (apiScope.value === 'all-users' && owner.value !== '*' ? owner.value : undefined))
const ownOnly = computed(() => props.tab === 'mine' && !owner.value)
const tabLabel = computed(() => t(`media.tabs.${props.tab}`))

const q = ref('')
const type = ref<'' | 'image' | 'video'>('')
const categoryId = ref<string>('')
const tags = ref<string[]>([])
const status = ref<string>('')
const page = ref(1)
const pageSize = ref(24)
const VIEW_KEY = 'cloudphone.media.view'
const view = ref<'grid' | 'list'>(readView())
function readView(): 'grid' | 'list' { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid' } catch { return 'grid' } }
watch(view, (v) => { try { localStorage.setItem(VIEW_KEY, v) } catch { /* storage unavailable */ } })

const canUpload = computed(() => (props.tab === 'public' ? auth.isAdmin : ownOnly.value))
const canManageCategories = canUpload
const showStatus = computed(() => auth.isAdmin || props.tab === 'mine')
/** Category source for filters/edit: public for public+favorites, own or the picked user for mine. */
const categoryQuery = computed(() => {
  if (props.tab !== 'mine') return 'scope=public'
  if (!owner.value) return 'scope=mine'
  return ownerId.value ? `scope=mine&ownerId=${ownerId.value}` : null
})

// ---------------------------------------------------------------- data
const items = ref<MediaItem[]>([])
const total = ref(0)
const loading = ref(false)
const categories = ref<MediaCategory[]>([])
const tagOptions = ref<string[]>([])
const thumbs = useThumbs()

async function load(silent = false) {
  if (!silent) loading.value = true
  try {
    const p = new URLSearchParams({ scope: apiScope.value, page: String(page.value), pageSize: String(pageSize.value) })
    if (ownerId.value) p.set('ownerId', ownerId.value)
    if (q.value.trim()) p.set('q', q.value.trim())
    if (type.value) p.set('type', type.value)
    if (categoryId.value) p.set('categoryId', categoryId.value)
    if (tags.value.length) p.set('tags', tags.value.join(','))
    if (status.value) p.set('status', status.value)
    const r = await api<{ items: MediaItem[]; total: number }>('GET', `/api/media?${p}`)
    if (!r.items.length && r.total && page.value > 1) { page.value = Math.ceil(r.total / pageSize.value); return load(silent) }
    items.value = r.items
    total.value = r.total
    selected.value = selected.value.filter((id) => r.items.some((i) => i.id === id))
    void thumbs.load(r.items)
    schedulePoll()
  } catch (e) { if (!silent) message.error(errMsg(e)) }
  finally { loading.value = false }
}

async function loadCategories() {
  const qs = categoryQuery.value
  if (!qs) { categories.value = []; return }
  try { categories.value = (await api<{ categories: MediaCategory[] }>('GET', `/api/media/categories?${qs}`)).categories }
  catch (e) { message.error(errMsg(e)) }
}
async function loadTags() {
  const p = new URLSearchParams({ scope: apiScope.value })
  if (ownerId.value) p.set('ownerId', ownerId.value)
  try { tagOptions.value = (await api<{ tags: string[] }>('GET', `/api/media/tags?${p}`)).tags } catch { tagOptions.value = [] }
}
const refreshAll = () => Promise.all([load(), loadCategories(), loadTags()])

/** While something is processing, refresh quietly every 3 s. */
let pollTimer: ReturnType<typeof setTimeout> | undefined
function schedulePoll() {
  clearTimeout(pollTimer)
  if (items.value.some((i) => i.status === 'processing')) pollTimer = setTimeout(() => void load(true), 3000)
}

onMounted(async () => {
  if (auth.isAdmin && props.tab === 'mine') {
    try { users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users } catch { /* filter stays limited */ }
  }
  await refreshAll()
})
onBeforeUnmount(() => { clearTimeout(pollTimer); thumbs.dispose(); closePreview() })

watch([type, categoryId, tags, status], () => { page.value = 1; void load() })
watch(owner, () => { categoryId.value = ''; tags.value = []; page.value = 1; void refreshAll() })
function search() { page.value = 1; void load() }
function onPage(p: number, size: number) { page.value = p; pageSize.value = size; void load() }

const typeOptions = computed(() => [{ value: '', label: t('media.allTypes') }, { value: 'image', label: t('media.image') }, { value: 'video', label: t('media.video') }])
const categoryOptions = computed(() => [
  { value: '', label: t('media.allCategories') }, { value: 'none', label: t('media.uncategorized') },
  ...categories.value.map((c) => ({ value: c.id, label: `${c.name} (${c.count})` })),
])
const statusOptions = computed(() => [{ value: '', label: t('media.allStatus') }, ...(['processing', 'ready', 'failed'] as const)
  .map((s) => ({ value: s, label: t(`media.statuses.${s}`) }))])
const ownerOptions = computed(() => [
  { value: '', label: t('media.ownerMine') }, { value: '*', label: t('media.ownerAll') },
  ...users.value.filter((u) => u.id !== auth.user?.id).map((u) => ({ value: u.id, label: u.displayName ? `${u.displayName} (${u.username})` : u.username })),
])

// ---------------------------------------------------------------- selection + batch
const selected = ref<string[]>([])
const selectedItems = computed(() => items.value.filter((i) => selected.value.includes(i.id)))
function toggle(id: string, on: boolean) { selected.value = on ? [...new Set([...selected.value, id])] : selected.value.filter((x) => x !== id) }
const allChecked = computed(() => items.value.length > 0 && selected.value.length === items.value.length)

/** Warning line when assets are used by contents (deleting drops them from those contents); '' otherwise. */
async function usageWarning(ids: string[]): Promise<string> {
  try {
    const { usage } = await api<{ usage: Record<string, number> }>('GET', `/api/media/usage?ids=${ids.join(',')}`)
    const n = Object.values(usage).reduce((a, b) => a + b, 0)
    return n ? ` ${t('media.usedByContents', { n })}` : ''
  } catch { return '' } // the warning is advisory: never block the delete dialog
}

async function batchDelete() {
  const ok = selectedItems.value.filter((i) => i.canManage)
  if (!ok.length) { message.warning(t('media.noPermitted')); return }
  const skip = selectedItems.value.length - ok.length
  const used = await usageWarning(ok.map((i) => i.id))
  confirmDanger({
    title: t('media.batchDeleteConfirm', { n: ok.length }),
    content: `${t('media.deleteContent')}${used}${skip ? ` ${t('media.batchDeleteSkip', { n: skip })}` : ''}`,
    onOk: async () => {
      try {
        const r = await api<{ results: { id: string; ok: boolean; error?: string; code?: string; params?: Record<string, string | number> }[]; deleted: number; failed: number }>(
          'POST', '/api/media/batch-delete', { ids: ok.map((i) => i.id) })
        if (r.failed) message.warning(t('media.batchDeleteResult', { ok: r.deleted, failed: r.failed }))
        else message.success(t('media.batchDeleteResult', { ok: r.deleted, failed: 0 }))
        selected.value = []
        await Promise.all([load(), loadCategories()])
      } catch (e) { message.error(errMsg(e)) }
    },
  })
}

/** 批量操作 menu: push to devices, delete (only assets the viewer may manage; batchDelete confirms). */
const batchItems = computed<BatchItem[]>(() => [
  { key: 'push', label: t('media.pushToDevice') },
  { key: 'delete', label: t('common.delete'), danger: true, disabled: !selectedItems.value.some((i) => i.canManage) },
])
function onBatch(key: string) {
  if (key === 'push') openPush(selectedItems.value)
  else if (key === 'delete') void batchDelete()
}

// ---------------------------------------------------------------- single actions
async function toggleFavorite(m: MediaItem) {
  try {
    await api(m.isFavorite ? 'DELETE' : 'POST', `/api/media/${m.id}/favorite`)
    message.success(m.isFavorite ? t('media.unfavorited') : t('media.favorited'))
    if (props.tab === 'favorites' && m.isFavorite) await load()
    else m.isFavorite = !m.isFavorite
  } catch (e) { message.error(errMsg(e)) }
}

async function remove(m: MediaItem) {
  const used = await usageWarning([m.id])
  confirmDanger({
    title: t('media.confirmDelete', { name: m.name }), content: `${t('media.deleteContent')}${used}`,
    onOk: async () => {
      try {
        await api('DELETE', `/api/media/${m.id}`)
        message.success(t('common.deleted'))
        await Promise.all([load(), loadCategories()])
      } catch (e) { message.error(errMsg(e)) }
    },
  })
}

async function download(m: MediaItem) {
  const hide = message.loading(t('media.downloading', { name: m.name }), 0)
  try {
    const url = URL.createObjectURL(await fetchAuthBlob(`${m.contentUrl}?download=1`))
    const a = document.createElement('a')
    a.href = url
    a.download = m.fileName || m.name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch (e) { message.error(errMsg(e)) }
  finally { hide() }
}

// preview
const previewItem = ref<MediaItem | null>(null)
const previewUrl = ref('')
const previewLoading = ref(false)
let previewToken = 0
async function openPreview(m: MediaItem) {
  closePreview()
  previewItem.value = m
  if (m.status === 'failed' || m.status === 'processing') return
  const token = ++previewToken
  previewLoading.value = true
  try {
    const blob = await fetchAuthBlob(m.contentUrl)
    if (token !== previewToken) return
    previewUrl.value = URL.createObjectURL(blob)
  } catch (e) { message.error(errMsg(e)) }
  finally { if (token === previewToken) previewLoading.value = false }
}
function closePreview() {
  previewToken++
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
  previewItem.value = null
  previewLoading.value = false
}
/** "12.3 MB → 2.1 MB · 2000×2500 → 1080×1350" (crop/compress at upload). */
function processedText(m: MediaItem): string {
  const r = m.processing?.result
  if (!r) return ''
  if (r.kept) return t('media.processKept')
  const dim = (f: { width: number | null; height: number | null }) => (f.width ? `${f.width}×${f.height}` : '')
  const dims = dim(r.before) && dim(r.before) !== dim(r.after) ? ` · ${dim(r.before)} → ${dim(r.after)}` : ''
  return `${fmtSize(r.before.size)} → ${fmtSize(r.after.size)}${dims}`
}

// edit
const editing = ref<MediaItem | null>(null)
const editForm = reactive({ name: '', categoryId: undefined as string | undefined, tags: [] as string[] })
const editCategories = ref<MediaCategory[]>([])
const editSaving = ref(false)
async function openEdit(m: MediaItem) {
  editing.value = m
  editForm.name = m.name
  editForm.categoryId = m.categoryId ?? undefined
  editForm.tags = [...m.tags]
  const qs = m.ownerType === 'public' ? 'scope=public' : m.ownerId === auth.user?.id ? 'scope=mine' : `scope=mine&ownerId=${m.ownerId}`
  try { editCategories.value = (await api<{ categories: MediaCategory[] }>('GET', `/api/media/categories?${qs}`)).categories }
  catch { editCategories.value = [] }
}
async function saveEdit() {
  const m = editing.value
  if (!m) return
  const name = editForm.name.trim()
  if (!name) { message.warning(t('media.nameRequired')); return }
  const tagList = editForm.tags.map((x) => x.trim()).filter(Boolean)
  if (tagList.some((x) => x.length > 32)) { message.warning(t('media.tagTooLong')); return }
  if (tagList.length > 20) { message.warning(t('media.tooManyTags')); return }
  const body: Record<string, unknown> = { name, categoryId: editForm.categoryId ?? null, tags: tagList }
  editSaving.value = true
  try {
    await api('PUT', `/api/media/${m.id}`, body)
    editing.value = null
    message.success(t('common.saved'))
    await Promise.all([load(), loadCategories(), loadTags()])
  } catch (e) { message.error(errMsg(e)) }
  finally { editSaving.value = false }
}

// push
const pushItems = ref<MediaItem[] | null>(null)
const pushTargets = ref<string[]>([])
const pushing = ref(false)
const runningDevices = computed(() => store.list.filter((i) => i.status === 'running').map((i) => ({ value: i.id, label: i.name })))
function openPush(list: MediaItem[]) {
  const ready = list.filter((m) => m.status === 'ready')
  if (!ready.length) { message.warning(t('media.pushNotReady')); return }
  if (ready.length > 20) { message.warning(t('media.pushLimit')); return }
  pushItems.value = ready
  pushTargets.value = []
}
async function doPush() {
  if (!pushItems.value || !pushTargets.value.length) { message.warning(t('media.pickDevice')); return }
  pushing.value = true
  try {
    const r = await api<{ accepted: unknown[]; skipped: { reason: string }[] }>('POST', '/api/media/push', {
      assetIds: pushItems.value.map((m) => m.id), instanceIds: pushTargets.value,
    })
    message.success(t('media.pushSubmitted', { n: r.accepted.length }))
    if (r.skipped.length) message.warning(t('media.pushSkipped', { n: r.skipped.length, reasons: [...new Set(r.skipped.map((s) => s.reason))].join(t('common.reasonSep')) }))
    pushItems.value = null
    selected.value = []
  } catch (e) { message.error(errMsg(e)) }
  finally { pushing.value = false }
}

// upload + categories
const uploadOpen = ref(false)
const categoriesOpen = ref(false)
const uploadScope = computed<'public' | 'mine'>(() => (props.tab === 'public' ? 'public' : 'mine'))

// ---------------------------------------------------------------- list view columns
const columns = computed(() => [
  { key: 'thumb', width: 72 },
  { key: 'name', title: t('common.name'), width: 260 },
  { key: 'type', title: t('media.type'), width: 90 },
  { key: 'size', title: t('media.size'), width: 100 },
  { key: 'info', title: t('media.resolution'), width: 130 },
  ...(apiScope.value === 'all-users' ? [{ key: 'owner', title: t('media.owner'), width: 120 }] : []),
  { key: 'category', title: t('media.category'), width: 120 },
  { key: 'status', title: t('common.status'), width: 110 },
  { key: 'createdAt', title: t('media.uploadedAt'), width: 170 },
  actionColumn(190),
])
const columnsWidth = computed(() => columns.value.reduce((n, c) => n + (c.width ?? 0), 0) + 48)
const rowSelection = computed(() => ({
  selectedRowKeys: selected.value,
  onChange: (keys: (string | number)[]) => { selected.value = keys.map(String) },
}))
const fmtTime = (s: string) => new Date(s).toLocaleString(dateLocale())
</script>

<template>
  <div>
    <SearchBar :loading="loading" @refresh="refreshAll">
      <a-select v-if="tab === 'mine' && auth.isAdmin" v-model:value="owner" :options="ownerOptions" show-search option-filter-prop="label" style="width: 200px" />
      <a-input-search v-model:value="q" :placeholder="t('media.searchPlaceholder')" allow-clear style="width: 240px" @search="search" />
      <a-select v-model:value="type" :options="typeOptions" style="width: 130px" />
      <a-select v-if="categoryQuery" v-model:value="categoryId" :options="categoryOptions" style="width: 180px" />
      <a-select
        v-model:value="tags" mode="multiple" :placeholder="t('media.tagFilter')" allow-clear :max-tag-count="2" style="width: 180px"
        :options="tagOptions.map((x) => ({ value: x, label: x }))"
      />
      <a-select v-if="showStatus" v-model:value="status" :options="statusOptions" style="width: 130px" />
      <a-checkbox
        v-if="items.length && view === 'grid'" :checked="allChecked" :indeterminate="selected.length > 0 && !allChecked"
        @change="(e: any) => (selected = e.target.checked ? items.map((i) => i.id) : [])"
      >{{ t('media.selectAll') }}</a-checkbox>
      <template #actions>
        <BatchActions :count="selected.length" :items="batchItems" @select="onBatch" @clear="selected = []" />
        <a-radio-group v-model:value="view" button-style="solid">
          <a-radio-button value="grid"><a-tooltip :title="t('media.gridView')"><AppstoreOutlined /></a-tooltip></a-radio-button>
          <a-radio-button value="list"><a-tooltip :title="t('media.listView')"><BarsOutlined /></a-tooltip></a-radio-button>
        </a-radio-group>
        <a-button v-if="canManageCategories" @click="categoriesOpen = true"><template #icon><FolderOutlined /></template>{{ t('media.categories.manage') }}</a-button>
        <a-button v-if="canUpload" type="primary" @click="uploadOpen = true"><template #icon><CloudUploadOutlined /></template>{{ t('media.upload') }}</a-button>
      </template>
    </SearchBar>

    <a-spin :spinning="loading">
      <a-empty v-if="!items.length && !loading" :description="tab === 'favorites' ? t('media.emptyFavorites') : t('media.empty')" style="margin: 32px 0" />

      <!-- grid -->
      <div v-if="view === 'grid' && items.length" class="grid">
        <div v-for="m in items" :key="m.id" class="item" :class="{ checked: selected.includes(m.id) }">
          <div class="thumb" @click="openPreview(m)">
            <img v-if="thumbs.get(m)" :src="thumbs.get(m)" :alt="m.name" />
            <LoadingOutlined v-else-if="m.status === 'processing'" class="icon" />
            <VideoCameraOutlined v-else-if="m.fileType === 'video'" class="icon" />
            <PictureOutlined v-else class="icon" />
            <PlayCircleFilled v-if="m.fileType === 'video' && thumbs.get(m)" class="play" />
            <span v-if="m.fileType === 'video' && m.duration" class="duration">{{ fmtDuration(m.duration) }}</span>
            <a-checkbox class="check" :checked="selected.includes(m.id)" @click.stop @change="(e: any) => toggle(m.id, e.target.checked)" />
            <a-tooltip v-if="m.status !== 'ready'" :title="m.status === 'failed' ? t('media.failedReason', { error: m.error ?? '' }) : undefined">
              <StatusTag kind="media" :status="m.status" class="badge" />
            </a-tooltip>
          </div>
          <div class="meta">
            <div class="name-row">
              <a-typography-text class="name" :content="m.name" :ellipsis="{ tooltip: m.name }" />
              <a-tooltip v-if="m.ownerType === 'public'" :title="m.isFavorite ? t('media.unfavorite') : t('media.favorite')">
                <span class="star" :class="{ on: m.isFavorite }" @click="toggleFavorite(m)">
                  <StarFilled v-if="m.isFavorite" /><StarOutlined v-else />
                </span>
              </a-tooltip>
            </div>
            <div class="muted small ellipsis">
              {{ m.fileType === 'video' ? t('media.video') : t('media.image') }} · {{ fmtSize(m.fileSize) }}<template v-if="m.width"> · {{ m.width }}×{{ m.height }}</template>
            </div>
            <div class="muted small ellipsis">{{ fmtTime(m.createdAt) }}<template v-if="apiScope === 'all-users' && m.ownerName"> · {{ m.ownerName }}</template></div>
            <div v-if="m.categoryName || m.tags.length" class="tags">
              <a-tag v-if="m.categoryName" color="blue"><FolderOutlined /> {{ m.categoryName }}</a-tag>
              <a-tag v-for="x in m.tags" :key="x">{{ x }}</a-tag>
            </div>
          </div>
          <div class="actions">
            <a-tooltip :title="t('media.preview')"><a-button type="text" size="small" :aria-label="t('media.preview')" @click="openPreview(m)"><EyeOutlined /></a-button></a-tooltip>
            <a-tooltip :title="t('media.pushToDevice')">
              <a-button type="text" size="small" :aria-label="t('media.pushToDevice')" :disabled="m.status !== 'ready'" @click="openPush([m])"><SendOutlined /></a-button>
            </a-tooltip>
            <a-tooltip :title="t('media.download')"><a-button type="text" size="small" :aria-label="t('media.download')" @click="download(m)"><DownloadOutlined /></a-button></a-tooltip>
            <a-tooltip v-if="m.canManage" :title="t('media.edit')"><a-button type="text" size="small" :aria-label="t('media.edit')" @click="openEdit(m)"><EditOutlined /></a-button></a-tooltip>
            <a-tooltip v-if="m.canManage" :title="t('common.delete')"><a-button type="text" size="small" danger :aria-label="t('common.delete')" @click="remove(m)"><DeleteOutlined /></a-button></a-tooltip>
          </div>
        </div>
      </div>

      <!-- list -->
      <a-table
        v-if="view === 'list' && items.length" :data-source="items" :columns="columns" row-key="id" :size="TABLE_SIZE" :pagination="false"
        :row-selection="rowSelection" :scroll="{ x: columnsWidth }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'thumb'">
            <div class="mini" @click="openPreview(record)">
              <img v-if="thumbs.get(record)" :src="thumbs.get(record)" :alt="record.name" />
              <VideoCameraOutlined v-else-if="record.fileType === 'video'" />
              <PictureOutlined v-else />
            </div>
          </template>
          <template v-else-if="column.key === 'name'">
            <div class="name-row">
              <span v-if="record.ownerType === 'public'" class="star" :class="{ on: record.isFavorite }" @click="toggleFavorite(record)">
                <StarFilled v-if="record.isFavorite" /><StarOutlined v-else />
              </span>
              <a-typography-text class="name" :content="record.name" :ellipsis="{ tooltip: record.name }" />
            </div>
            <div v-if="record.tags.length"><a-tag v-for="x in record.tags" :key="x">{{ x }}</a-tag></div>
          </template>
          <template v-else-if="column.key === 'type'">{{ record.fileType === 'video' ? t('media.video') : t('media.image') }}</template>
          <template v-else-if="column.key === 'size'">{{ fmtSize(record.fileSize) }}</template>
          <template v-else-if="column.key === 'info'">
            <template v-if="record.width">{{ record.width }}×{{ record.height }}</template>
            <template v-if="record.duration"> · {{ fmtDuration(record.duration) }}</template>
          </template>
          <template v-else-if="column.key === 'owner'">{{ record.ownerName }}</template>
          <template v-else-if="column.key === 'category'">{{ record.categoryName ?? '—' }}</template>
          <template v-else-if="column.key === 'status'">
            <a-tooltip :title="record.status === 'failed' ? t('media.failedReason', { error: record.error ?? '' }) : undefined">
              <StatusTag kind="media" :status="record.status" />
            </a-tooltip>
          </template>
          <template v-else-if="column.key === 'createdAt'">{{ fmtTime(record.createdAt) }}</template>
          <template v-else-if="column.key === 'ops'">
            <a-space :size="0">
              <a-button type="link" size="small" @click="openPreview(record)">{{ t('media.preview') }}</a-button>
              <a-button type="link" size="small" :disabled="record.status !== 'ready'" @click="openPush([record])">{{ t('common.push') }}</a-button>
              <a-dropdown>
                <a-button type="link" size="small">{{ t('common.more') }}</a-button>
                <template #overlay>
                  <a-menu>
                    <a-menu-item key="download" @click="download(record)">{{ t('media.download') }}</a-menu-item>
                    <a-menu-item v-if="record.canManage" key="edit" @click="openEdit(record)">{{ t('media.edit') }}</a-menu-item>
                    <a-menu-item v-if="record.canManage" key="delete" danger @click="remove(record)">{{ t('common.delete') }}</a-menu-item>
                  </a-menu>
                </template>
              </a-dropdown>
            </a-space>
          </template>
        </template>
      </a-table>

      <div v-if="total > 0" class="pager">
        <a-pagination v-bind="pagination({ current: page, pageSize, total, pageSizeOptions: ['12', '24', '48', '96'] })" @change="onPage" />
      </div>
    </a-spin>

    <!-- preview -->
    <a-modal :open="!!previewItem" :title="previewItem?.name" :footer="null" :width="MODAL_WIDTH.lg" centered destroy-on-close @cancel="closePreview">
      <template v-if="previewItem">
        <div class="preview">
          <a-spin v-if="previewLoading" />
          <a-alert v-else-if="previewItem.status === 'failed'" type="error" :message="t('media.failedReason', { error: previewItem.error ?? '' })" />
          <a-alert v-else-if="previewItem.status === 'processing'" type="info" :message="t('media.processingNote')" />
          <img v-else-if="previewUrl && previewItem.fileType === 'image'" :src="previewUrl" :alt="previewItem.name" />
          <video v-else-if="previewUrl" :src="previewUrl" controls autoplay playsinline />
        </div>
        <a-descriptions size="small" :column="{ xs: 1, sm: 2 }" style="margin-top: 12px">
          <a-descriptions-item :label="t('media.type')">{{ previewItem.mimeType }}</a-descriptions-item>
          <a-descriptions-item :label="t('media.size')">{{ fmtSize(previewItem.fileSize) }}</a-descriptions-item>
          <a-descriptions-item v-if="previewItem.width" :label="t('media.resolution')">{{ previewItem.width }}×{{ previewItem.height }}</a-descriptions-item>
          <a-descriptions-item v-if="previewItem.processing?.result" :label="t('media.processed')" :span="2">{{ processedText(previewItem) }}</a-descriptions-item>
          <a-descriptions-item v-if="previewItem.duration" :label="t('media.duration')">{{ fmtDuration(previewItem.duration) }}</a-descriptions-item>
          <a-descriptions-item :label="t('media.uploadedAt')">{{ fmtTime(previewItem.createdAt) }}</a-descriptions-item>
          <a-descriptions-item v-if="previewItem.ownerName" :label="t('media.owner')">{{ previewItem.ownerName }}</a-descriptions-item>
        </a-descriptions>
      </template>
    </a-modal>

    <!-- edit -->
    <a-modal :open="!!editing" :title="t('media.editTitle')" :width="MODAL_WIDTH.sm" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" :confirm-loading="editSaving" @ok="saveEdit" @cancel="editing = null">
      <a-form layout="vertical">
        <a-form-item :label="t('common.name')"><a-input v-model:value="editForm.name" :maxlength="200" /></a-form-item>
        <a-form-item :label="t('media.category')">
          <a-select v-model:value="editForm.categoryId" allow-clear :placeholder="t('media.uncategorized')" :options="editCategories.map((c) => ({ value: c.id, label: c.name }))" />
        </a-form-item>
        <a-form-item :label="t('media.tags')">
          <a-select v-model:value="editForm.tags" mode="tags" :options="tagOptions.map((x) => ({ value: x }))" :placeholder="t('media.addTag')" style="width: 100%" />
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- push -->
    <a-modal
      :open="!!pushItems" :title="pushItems?.length === 1 ? t('media.pushOne', { name: pushItems[0]!.name }) : t('media.pushMany', { n: pushItems?.length ?? 0 })"
      :width="MODAL_WIDTH.sm" :ok-text="t('common.push')" :cancel-text="t('common.cancel')" :confirm-loading="pushing" @ok="doPush" @cancel="pushItems = null"
    >
      <a-select
        v-model:value="pushTargets" mode="multiple" style="width: 100%" :placeholder="t('media.pickRunning')" :options="runningDevices"
        :not-found-content="t('media.noRunning')" option-filter-prop="label"
      />
      <div class="muted small" style="margin-top: 8px">{{ t('media.pushHint') }}</div>
    </a-modal>

    <MediaUploader
      v-if="canUpload" v-model:open="uploadOpen" :scope="uploadScope" :scope-label="tabLabel" :limits="limits" :categories="categories"
      :tag-options="tagOptions" @uploaded="refreshAll" @categories-changed="loadCategories"
    />
    <ScopedListManager v-if="canManageCategories" v-model:open="categoriesOpen" path="/api/media/categories" list-key="categories" texts="media.categories"
      :merge-into-public="false" :initial-tab="uploadScope" @changed="() => { void loadCategories(); void load() }" />
  </div>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: var(--cp-gap); }
.item { border: 1px solid var(--cp-border-secondary); border-radius: var(--cp-radius-lg); overflow: hidden; background: var(--cp-bg-container); display: flex; flex-direction: column; min-width: 0; }
.item.checked { border-color: var(--cp-primary); box-shadow: 0 0 0 1px var(--cp-primary); }
.thumb { position: relative; height: 140px; background: var(--cp-fill-alter); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.icon { font-size: 36px; color: var(--cp-text-quaternary); }
/* Play icon and duration sit on top of a photo, not on a theme surface, so they stay light-on-dark in both themes. */
.play { position: absolute; font-size: 36px; color: rgba(255, 255, 255, 0.85); filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.5)); pointer-events: none; }
.duration { position: absolute; right: 6px; bottom: 6px; background: rgba(0, 0, 0, 0.6); color: #fff; font-size: 12px; padding: 0 6px; border-radius: 4px; }
.check { position: absolute; top: 8px; left: 8px; }
.badge { position: absolute; top: 8px; right: 0; }
.meta { padding: 8px 12px 0; min-width: 0; flex: 1; }
.name-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.name { flex: 1; min-width: 0; font-weight: 500; }
.star { cursor: pointer; color: var(--cp-text-quaternary); }
.star.on { color: var(--cp-warning); }
.tags { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px 0; }
.actions { display: flex; justify-content: space-around; border-top: 1px solid var(--cp-border-secondary); padding: 2px 0; margin-top: 8px; }
.mini { width: 56px; height: 40px; border-radius: 4px; overflow: hidden; background: var(--cp-fill-alter); display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--cp-text-quaternary); }
.mini img { width: 100%; height: 100%; object-fit: cover; }
.pager { display: flex; justify-content: flex-end; margin-top: var(--cp-gap); }
.preview { display: flex; justify-content: center; align-items: center; min-height: 200px; background: var(--cp-fill-alter); border-radius: var(--cp-radius-lg); }
.preview img, .preview video { max-width: 100%; max-height: 70vh; display: block; }
@media (max-width: 640px) {
  .grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .thumb { height: 110px; }
}
</style>
