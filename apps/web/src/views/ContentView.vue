<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { queryParam } from '../api/query'
import { api, codeText, errorText } from '../api/client'
import {
  CONTENT_STATUS_COLOR, CONTENT_STATUSES, PUBLISH_STATUS_COLOR, PUBLISH_UNFINISHED,
  type Content, type ContentHints, type ContentMedia, type ContentStatus, type ManagedUser, type PublishTaskItem,
} from '../api/types'
import DistributeModal from '../components/content/DistributeModal.vue'
import MediaPicker from '../components/content/MediaPicker.vue'
import MediaStrip from '../components/content/MediaStrip.vue'
import PlatformTag from '../components/social/PlatformTag.vue'
import { useAuthStore } from '../stores/auth'

/** Content management (内容管理): list, editor, distribution to social accounts. */
const { t } = useI18n()
const auth = useAuthStore()
const router = useRouter()

const items = ref<Content[]>([])
const total = ref(0)
const loading = ref(false)
const page = reactive({ current: 1, pageSize: 20 })
const filters = reactive({ q: '', status: queryParam<ContentStatus>(useRoute().query, 'status'), category: undefined as string | undefined, tag: undefined as string | undefined, ownerId: undefined as string | undefined })
const facets = ref<{ categories: string[]; tags: string[] }>({ categories: [], tags: [] })
const users = ref<ManagedUser[]>([])
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : '—')
const statusText = (s: string) => t(`content.status.${s}`)

async function load() {
  loading.value = true
  try {
    const p = new URLSearchParams({ page: String(page.current), pageSize: String(page.pageSize) })
    if (filters.q.trim()) p.set('q', filters.q.trim())
    for (const k of ['status', 'category', 'tag', 'ownerId'] as const) if (filters[k]) p.set(k, filters[k]!)
    const r = await api<{ items: Content[]; total: number }>('GET', `/api/contents?${p}`)
    items.value = r.items
    total.value = r.total
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
async function loadFacets() {
  try {
    facets.value = await api('GET', `/api/contents/facets${filters.ownerId ? `?ownerId=${filters.ownerId}` : ''}`)
    if (auth.isAdmin && !users.value.length) users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users
  } catch (e) { message.error(errorText(e)) }
}
const search = () => { page.current = 1; void load() }
function reset() { Object.assign(filters, { q: '', status: undefined, category: undefined, tag: undefined, ownerId: undefined }); search() }
onMounted(() => { void load(); void loadFacets() })

const columns = computed(() => [
  { title: t('content.colTitle'), key: 'title' },
  { title: t('content.colMedia'), key: 'media', width: 200 },
  { title: t('content.colStatus'), key: 'status', width: 120 },
  { title: t('content.colCategory'), key: 'category', width: 140 },
  { title: t('content.colPublish'), key: 'publish', width: 160 },
  ...(auth.isAdmin ? [{ title: t('content.colOwner'), key: 'owner', width: 110 }] : []),
  { title: t('content.colUpdated'), key: 'updated', width: 170 },
  { title: t('common.action'), key: 'action', width: 200 },
])
const publishTotal = (c: Content) => Object.entries(c.publishCounts).filter(([s]) => s !== 'cancelled').reduce((a, [, n]) => a + (n ?? 0), 0)

// ---------------------------------------------------------------- editor
const editorOpen = ref(false)
const saving = ref(false)
const editing = ref<Content | null>(null)
const editorTasks = ref<PublishTaskItem[]>([])
const form = reactive({
  title: '', body: '', category: undefined as string | undefined, tags: [] as string[], media: [] as ContentMedia[],
  yt: { title: '', description: '', privacy: undefined as 'public' | 'unlisted' | 'private' | undefined }, ig: { caption: '' }, tt: { caption: '' }, ownerId: undefined as string | undefined,
})
const pickerOpen = ref(false)

function fillForm(c: Content | null) {
  const h: ContentHints = c?.platformHints ?? {}
  Object.assign(form, {
    title: c?.title ?? '', body: c?.body ?? '', category: c?.category ?? undefined, tags: [...(c?.tags ?? [])], media: [...(c?.media ?? [])],
    yt: { title: h.youtube?.title ?? '', description: h.youtube?.description ?? '', privacy: h.youtube?.privacy },
    ig: { caption: h.instagram?.caption ?? '' }, tt: { caption: h.tiktok?.caption ?? '' }, ownerId: undefined,
  })
}
function openNew() { editing.value = null; editorTasks.value = []; fillForm(null); editorOpen.value = true }
async function openEdit(c: Content) {
  editing.value = c
  fillForm(c)
  editorOpen.value = true
  try {
    const r = await api<{ content: Content; publishTasks: PublishTaskItem[] }>('GET', `/api/contents/${c.id}`)
    editing.value = r.content
    editorTasks.value = r.publishTasks
    fillForm(r.content)
  } catch (e) { message.error(errorText(e)) }
}
function moveMedia(i: number, d: number) {
  const m = [...form.media]
  const [x] = m.splice(i, 1)
  m.splice(i + d, 0, x!)
  form.media = m
}
const onPick = (picked: ContentMedia[]) => { form.media = [...form.media, ...picked.filter((p) => !form.media.some((m) => m.id === p.id))] }

function hints(): ContentHints {
  const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>
  const out: ContentHints = {}
  const yt = clean(form.yt); if (Object.keys(yt).length) out.youtube = yt
  const ig = clean(form.ig); if (Object.keys(ig).length) out.instagram = ig
  const tt = clean(form.tt); if (Object.keys(tt).length) out.tiktok = tt
  return out
}

async function save(stage: 'draft' | 'ready') {
  if (!form.title.trim()) { message.warning(t('content.titleRequired')); return }
  saving.value = true
  try {
    const body = {
      title: form.title.trim(), body: form.body, category: form.category ?? null, tags: form.tags, mediaIds: form.media.map((m) => m.id), platformHints: hints(),
      ...(editing.value?.stage === 'archived' ? {} : { stage }),
    }
    if (editing.value) await api('PUT', `/api/contents/${editing.value.id}`, body)
    else await api('POST', '/api/contents', { ...body, ...(form.ownerId ? { ownerId: form.ownerId } : {}) })
    message.success(t('common.saved'))
    editorOpen.value = false
    void load(); void loadFacets()
  } catch (e) { message.error(errorText(e)) } finally { saving.value = false }
}

// ---------------------------------------------------------------- actions
const distributeOpen = ref(false)
const distributing = ref<Content | null>(null)
function openDistribute(c: Content) { distributing.value = c; distributeOpen.value = true }

async function setArchived(c: Content, archived: boolean) {
  try {
    await api('PUT', `/api/contents/${c.id}`, { stage: archived ? 'archived' : 'ready' })
    message.success(archived ? t('content.archived') : t('content.unarchived'))
    void load()
  } catch (e) { message.error(errorText(e)) }
}
function remove(c: Content) {
  Modal.confirm({
    title: t('content.deleteConfirm', { title: c.title }), content: t('content.deleteHint'), okType: 'danger', okText: t('common.delete'), cancelText: t('common.cancel'),
    async onOk() {
      try { await api('DELETE', `/api/contents/${c.id}`); message.success(t('common.deleted')); void load() } catch (e) { message.error(errorText(e)) }
    },
  })
}
const hasUnfinished = (c: Content) => PUBLISH_UNFINISHED.some((s) => (c.publishCounts[s] ?? 0) > 0)
</script>

<template>
  <a-card :title="t('content.title')" size="small">
    <template #extra>
      <a-space wrap>
        <a-button @click="router.push('/publish')">{{ t('content.openScheduler') }}</a-button>
        <a-button type="primary" @click="openNew"><PlusOutlined /> {{ t('content.add') }}</a-button>
      </a-space>
    </template>

    <a-space wrap style="margin-bottom: 12px">
      <a-input-search v-model:value="filters.q" :placeholder="t('content.searchPlaceholder')" allow-clear style="width: 220px" @search="search" />
      <a-select v-model:value="filters.status" :placeholder="t('content.colStatus')" allow-clear style="width: 140px" @change="search">
        <a-select-option v-for="s in CONTENT_STATUSES" :key="s" :value="s">{{ statusText(s) }}</a-select-option>
      </a-select>
      <a-select v-model:value="filters.category" :placeholder="t('content.colCategory')" allow-clear style="width: 140px" @change="search">
        <a-select-option value="none">{{ t('content.uncategorized') }}</a-select-option>
        <a-select-option v-for="c in facets.categories" :key="c" :value="c">{{ c }}</a-select-option>
      </a-select>
      <a-select v-model:value="filters.tag" :placeholder="t('content.colTags')" allow-clear show-search style="width: 140px" :options="facets.tags.map((x) => ({ value: x, label: x }))" @change="search" />
      <a-select v-if="auth.isAdmin" v-model:value="filters.ownerId" :placeholder="t('content.colOwner')" allow-clear show-search option-filter-prop="label" style="width: 140px"
        :options="users.map((u) => ({ value: u.id, label: u.username }))" @change="search(); loadFacets()" />
      <a-button @click="reset">{{ t('common.reset') }}</a-button>
    </a-space>

    <a-table :data-source="items" :columns="columns" row-key="id" size="small" :loading="loading" :scroll="{ x: 1100 }"
      :pagination="{ current: page.current, pageSize: page.pageSize, total, showSizeChanger: true, showTotal: (n: number) => t('content.total', { n }) }"
      @change="(p: any) => { page.current = p.current; page.pageSize = p.pageSize; load() }">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'title'">
          <a @click="openEdit(record)">{{ record.title }}</a>
          <div v-if="record.tags.length" style="margin-top: 2px"><a-tag v-for="tg in record.tags" :key="tg">{{ tg }}</a-tag></div>
        </template>
        <template v-else-if="column.key === 'media'"><MediaStrip :media="record.media" :size="36" :max="4" /></template>
        <template v-else-if="column.key === 'status'"><a-tag :color="CONTENT_STATUS_COLOR[record.status as ContentStatus]">{{ statusText(record.status) }}</a-tag></template>
        <template v-else-if="column.key === 'category'">{{ record.category ?? '—' }}</template>
        <template v-else-if="column.key === 'publish'">
          <span v-if="!publishTotal(record)" class="muted">—</span>
          <a v-else @click="router.push({ path: '/publish', query: { tab: 'queue', contentId: record.id } })">
            {{ t('content.publishSummary', { published: record.publishCounts.published ?? 0, total: publishTotal(record) }) }}
          </a>
        </template>
        <template v-else-if="column.key === 'owner'">{{ record.ownerName ?? '—' }}</template>
        <template v-else-if="column.key === 'updated'">{{ fmt(record.updatedAt) }}</template>
        <template v-else-if="column.key === 'action'">
          <a-space size="small" wrap>
            <a @click="openEdit(record)">{{ t('common.edit') }}</a>
            <a v-if="record.stage !== 'archived'" @click="openDistribute(record)">{{ t('content.distribute') }}</a>
            <a v-if="record.stage !== 'archived'" :class="{ disabled: hasUnfinished(record) }" @click="!hasUnfinished(record) && setArchived(record, true)">{{ t('content.archive') }}</a>
            <a v-else @click="setArchived(record, false)">{{ t('content.unarchive') }}</a>
            <a class="danger" @click="remove(record)">{{ t('common.delete') }}</a>
          </a-space>
        </template>
      </template>
    </a-table>
  </a-card>

  <a-drawer v-model:open="editorOpen" :title="editing ? t('content.edit') : t('content.add')" width="min(760px, 100vw)" destroy-on-close>
    <a-form layout="vertical">
      <a-form-item v-if="!editing && auth.isAdmin" :label="t('content.owner')" :extra="t('content.ownerHint')">
        <a-select v-model:value="form.ownerId" allow-clear show-search option-filter-prop="label" :placeholder="t('content.ownerSelf')" :options="users.map((u) => ({ value: u.id, label: u.username }))" />
      </a-form-item>
      <a-form-item :label="t('content.fieldTitle')" required>
        <a-input v-model:value="form.title" :maxlength="200" show-count />
      </a-form-item>
      <a-form-item :label="t('content.fieldBody')">
        <a-textarea v-model:value="form.body" :rows="5" :maxlength="5000" show-count :placeholder="t('content.bodyPlaceholder')" />
      </a-form-item>
      <a-row :gutter="12">
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('content.fieldCategory')">
            <a-auto-complete v-model:value="form.category" :options="facets.categories.map((c) => ({ value: c }))" allow-clear :maxlength="50" />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('content.fieldTags')">
            <a-select v-model:value="form.tags" mode="tags" :options="facets.tags.map((x) => ({ value: x }))" :token-separators="[',']" />
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item :label="t('content.fieldMedia', { n: form.media.length })">
        <MediaStrip :media="form.media" :size="88" editable @move="moveMedia" @remove="(i: number) => form.media.splice(i, 1)" />
        <a-button style="margin-top: 8px" :disabled="form.media.length >= 20" @click="pickerOpen = true"><PlusOutlined /> {{ t('content.addMedia') }}</a-button>
        <div class="muted" style="margin-top: 4px">{{ t('content.mediaHint') }}</div>
      </a-form-item>
      <a-collapse ghost>
        <a-collapse-panel key="hints" :header="t('content.hints')">
          <p class="muted">{{ t('content.hintsHelp') }}</p>
          <a-divider orientation="left" plain><PlatformTag platform="youtube" /></a-divider>
          <a-form-item :label="t('content.ytTitle')"><a-input v-model:value="form.yt.title" :maxlength="100" show-count /></a-form-item>
          <a-form-item :label="t('content.ytDescription')"><a-textarea v-model:value="form.yt.description" :rows="3" :maxlength="5000" /></a-form-item>
          <a-form-item :label="t('content.ytPrivacy')">
            <a-select v-model:value="form.yt.privacy" allow-clear style="width: 200px" :placeholder="t('distribute.privacyOpt.private')"
              :options="['public', 'unlisted', 'private'].map((p) => ({ value: p, label: t(`distribute.privacyOpt.${p}`) }))" />
          </a-form-item>
          <a-divider orientation="left" plain><PlatformTag platform="instagram" /></a-divider>
          <a-form-item :label="t('content.caption')"><a-textarea v-model:value="form.ig.caption" :rows="3" :maxlength="2200" show-count /></a-form-item>
          <a-divider orientation="left" plain><PlatformTag platform="tiktok" /></a-divider>
          <a-form-item :label="t('content.caption')"><a-textarea v-model:value="form.tt.caption" :rows="3" :maxlength="2200" show-count /></a-form-item>
        </a-collapse-panel>
      </a-collapse>
    </a-form>

    <template v-if="editing && editorTasks.length">
      <a-divider orientation="left" plain>{{ t('content.tasksOf') }}</a-divider>
      <a-list size="small" :data-source="editorTasks">
        <template #renderItem="{ item }">
          <a-list-item>
            <a-space wrap>
              <PlatformTag :platform="item.platform" />
              <span>@{{ item.account?.handle ?? '—' }}</span>
              <a-tag :color="PUBLISH_STATUS_COLOR[item.status as PublishTaskItem['status']]">{{ t(`publish.status.${item.status}`) }}</a-tag>
              <span class="muted">{{ fmt(item.scheduledAt) }}</span>
              <span v-if="item.errorCode" class="err">{{ codeText(item.errorCode, undefined, item.error ?? item.errorCode) }}</span>
              <a v-if="item.url" :href="item.url" target="_blank" rel="noopener noreferrer">{{ t('publish.viewPost') }}</a>
            </a-space>
            <template #actions><a @click="router.push({ path: '/publish', query: { tab: 'queue', task: item.id } })">{{ t('common.view') }}</a></template>
          </a-list-item>
        </template>
      </a-list>
    </template>

    <template #footer>
      <a-space style="float: right">
        <a-button @click="editorOpen = false">{{ t('common.cancel') }}</a-button>
        <template v-if="editing?.stage === 'archived'">
          <a-button type="primary" :loading="saving" @click="save('ready')">{{ t('common.save') }}</a-button>
        </template>
        <template v-else>
          <a-button :loading="saving" @click="save('draft')">{{ t('content.saveDraft') }}</a-button>
          <a-button type="primary" :loading="saving" @click="save('ready')">{{ t('content.saveReady') }}</a-button>
        </template>
      </a-space>
    </template>
  </a-drawer>

  <MediaPicker v-model:open="pickerOpen" :exclude="form.media.map((m) => m.id)" @pick="onPick" />
  <DistributeModal v-model:open="distributeOpen" :content="distributing" @done="load" />
</template>

<style scoped>
.muted { color: var(--cp-text-tertiary); font-size: 12px; }
.err { color: var(--cp-error); font-size: 12px; }
.danger { color: var(--cp-error); }
.disabled { color: var(--cp-text-quaternary); cursor: not-allowed; }
</style>
