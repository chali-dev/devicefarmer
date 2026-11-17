<script setup lang="ts">
import { dateLocale } from '../i18n'
import { computed, onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { PlusOutlined, QuestionCircleOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { queryParam } from '../api/query'
import { api, codeText, errorText } from '../api/client'
import {
  CONTENT_STATUSES, PUBLISH_UNFINISHED,
  type Content, type ContentHints, type ContentMedia, type ContentStatus, type ManagedUser, type PublishTaskItem,
} from '../api/types'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import StatusTag from '../components/common/StatusTag.vue'
import { actionColumn, confirmDanger, DRAWER_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'
import DistributeModal from '../components/content/DistributeModal.vue'
import MediaPicker from '../components/content/MediaPicker.vue'
import MediaStrip from '../components/content/MediaStrip.vue'
import TemplateInsert, { type InsertTarget } from '../components/content/TemplateInsert.vue'
import PlatformTag from '../components/social/PlatformTag.vue'
import { useAuthStore } from '../stores/auth'
import { usePlatformsStore } from '../stores/platforms'

/** Content management (内容管理): list, editor, distribution to social accounts. */
const { t } = useI18n()
const auth = useAuthStore()
const platforms = usePlatformsStore()
const router = useRouter()

const items = ref<Content[]>([])
const total = ref(0)
const loading = ref(false)
const page = reactive({ current: 1, pageSize: 20 })
const filters = reactive({ q: '', status: queryParam<ContentStatus>(useRoute().query, 'status'), category: undefined as string | undefined, tag: undefined as string | undefined, ownerId: undefined as string | undefined })
const facets = ref<{ categories: string[]; tags: string[] }>({ categories: [], tags: [] })
const users = ref<ManagedUser[]>([])
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
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
  { title: t('content.colTitle'), key: 'title', width: 280 },
  { title: t('content.colMedia'), key: 'media', width: 200 },
  { title: t('content.colStatus'), key: 'status', width: 120 },
  { title: t('content.colCategory'), key: 'category', width: 140 },
  { title: t('content.colPublish'), key: 'publish', width: 160 },
  ...(auth.isAdmin ? [{ title: t('content.colOwner'), key: 'owner', width: 110 }] : []),
  { title: t('content.colUpdated'), key: 'updated', width: 170 },
  actionColumn(170),
])
const scrollX = computed(() => columns.value.reduce((n, c) => n + c.width, 0))
function onTableChange(p: { current?: number; pageSize?: number }) { page.current = p.current ?? 1; page.pageSize = p.pageSize ?? page.pageSize; void load() }
const publishTotal = (c: Content) => Object.entries(c.publishCounts).filter(([s]) => s !== 'cancelled').reduce((a, [, n]) => a + (n ?? 0), 0)

// ---------------------------------------------------------------- editor
const editorOpen = ref(false)
const saving = ref(false)
const editing = ref<Content | null>(null)
const editorTasks = ref<PublishTaskItem[]>([])
const form = reactive({
  title: '', body: '', category: undefined as string | undefined, tags: [] as string[], media: [] as ContentMedia[],
  yt: { title: '', description: '', privacy: undefined as 'public' | 'unlisted' | 'private' | undefined }, ig: { caption: '' }, tt: { caption: '' }, fb: { caption: '' }, ownerId: undefined as string | undefined,
})
const pickerOpen = ref(false)

function fillForm(c: Content | null) {
  const h: ContentHints = c?.platformHints ?? {}
  Object.assign(form, {
    title: c?.title ?? '', body: c?.body ?? '', category: c?.category ?? undefined, tags: [...(c?.tags ?? [])], media: [...(c?.media ?? [])],
    yt: { title: h.youtube?.title ?? '', description: h.youtube?.description ?? '', privacy: h.youtube?.privacy },
    ig: { caption: h.instagram?.caption ?? '' }, tt: { caption: h.tiktok?.caption ?? '' }, fb: { caption: h.facebook?.caption ?? '' }, ownerId: undefined,
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
/** 话术库: puts a post template's text into one field; the person edits it before saving. */
function insertTemplate(target: InsertTarget, text: string, replace: boolean) {
  const join = (cur: string) => (replace || !cur.trim() ? text : `${cur.replace(/\s+$/, '')}\n\n${text}`)
  if (target === 'body') form.body = join(form.body)
  else if (target === 'ytDescription') form.yt.description = join(form.yt.description)
  else if (target === 'igCaption') form.ig.caption = join(form.ig.caption)
  else if (target === 'ttCaption') form.tt.caption = join(form.tt.caption)
  else form.fb.caption = join(form.fb.caption)
}
const onPick = (picked: ContentMedia[]) => { form.media = [...form.media, ...picked.filter((p) => !form.media.some((m) => m.id === p.id))] }

function hints(): ContentHints {
  const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>
  const out: ContentHints = {}
  const yt = clean(form.yt); if (Object.keys(yt).length) out.youtube = yt
  const ig = clean(form.ig); if (Object.keys(ig).length) out.instagram = ig
  const tt = clean(form.tt); if (Object.keys(tt).length) out.tiktok = tt
  const fb = clean(form.fb); if (Object.keys(fb).length) out.facebook = fb
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
  confirmDanger({
    title: t('content.deleteConfirm', { title: c.title }), content: t('content.deleteHint'),
    async onOk() {
      try { await api('DELETE', `/api/contents/${c.id}`); message.success(t('common.deleted')); void load() } catch (e) { message.error(errorText(e)) }
    },
  })
}
const hasUnfinished = (c: Content) => PUBLISH_UNFINISHED.some((s) => (c.publishCounts[s] ?? 0) > 0)
</script>

<template>
  <PageContainer :title="t('content.title')">
    <template #extra>
      <a-button @click="router.push('/publish')">{{ t('content.openScheduler') }}</a-button>
      <a-button type="primary" @click="openNew"><template #icon><PlusOutlined /></template>{{ t('content.add') }}</a-button>
    </template>

    <a-card :bordered="false">
      <SearchBar :loading="loading" @reset="reset" @refresh="load">
        <a-input-search v-model:value="filters.q" :placeholder="t('content.searchPlaceholder')" allow-clear style="width: 240px" @search="search" />
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
      </SearchBar>

      <a-table :data-source="items" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :scroll="{ x: scrollX }"
        :pagination="pagination({ current: page.current, pageSize: page.pageSize, total })" @change="onTableChange">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'title'">
            <a @click="openEdit(record)">{{ record.title }}</a>
            <div v-if="record.tags.length" style="margin-top: 2px"><a-tag v-for="tg in record.tags" :key="tg">{{ tg }}</a-tag></div>
          </template>
          <template v-else-if="column.key === 'media'"><MediaStrip :media="record.media" :size="36" :max="4" /></template>
          <template v-else-if="column.key === 'status'"><StatusTag kind="content" :status="record.status" /></template>
          <template v-else-if="column.key === 'category'">{{ record.category ?? '—' }}</template>
          <template v-else-if="column.key === 'publish'">
            <span v-if="!publishTotal(record)" class="muted">—</span>
            <a v-else @click="router.push({ path: '/publish', query: { tab: 'queue', contentId: record.id } })">
              {{ t('content.publishSummary', { published: record.publishCounts.published ?? 0, total: publishTotal(record) }) }}
            </a>
          </template>
          <template v-else-if="column.key === 'owner'">{{ record.ownerName ?? '—' }}</template>
          <template v-else-if="column.key === 'updated'">{{ fmt(record.updatedAt) }}</template>
          <template v-else-if="column.key === 'ops'">
            <a-space :size="0">
              <a-button type="link" size="small" @click="openEdit(record)">{{ t('common.edit') }}</a-button>
              <a-button v-if="record.stage !== 'archived'" type="link" size="small" @click="openDistribute(record)">{{ t('content.distribute') }}</a-button>
              <a-button v-else type="link" size="small" @click="setArchived(record, false)">{{ t('content.unarchive') }}</a-button>
              <a-dropdown>
                <a-button type="link" size="small">{{ t('common.more') }}</a-button>
                <template #overlay>
                  <a-menu>
                    <a-menu-item v-if="record.stage !== 'archived'" key="archive" :disabled="hasUnfinished(record)" @click="setArchived(record, true)">{{ t('content.archive') }}</a-menu-item>
                    <a-menu-item key="delete" danger @click="remove(record)">{{ t('common.delete') }}</a-menu-item>
                  </a-menu>
                </template>
              </a-dropdown>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-card>
  </PageContainer>

  <a-drawer
  <a-drawer v-model:open="editorOpen" :title="editing ? t('content.edit') : t('content.add')" :width="DRAWER_WIDTH.lg" destroy-on-close>
    <a-form layout="vertical">
      <a-form-item v-if="!editing && auth.isAdmin" :label="t('content.owner')">
        <a-select v-model:value="form.ownerId" allow-clear show-search option-filter-prop="label" :placeholder="t('content.ownerSelf')" :options="users.map((u) => ({ value: u.id, label: u.username }))" />
      </a-form-item>
      <a-form-item :label="t('content.fieldTitle')" required>
        <a-input v-model:value="form.title" :maxlength="200" show-count />
      </a-form-item>
      <a-form-item :label="t('content.fieldBody')">
        <template #extra><TemplateInsert style="margin-top: 4px" @insert="insertTemplate" /></template>
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
        <a-button style="margin-top: 8px" :disabled="form.media.length >= 20" @click="pickerOpen = true"><template #icon><PlusOutlined /></template>{{ t('content.addMedia') }}</a-button>
      </a-form-item>
      <a-collapse ghost>
        <a-collapse-panel key="hints">
          <template #header>
            {{ t('content.hints') }}
            <a-tooltip :title="t('content.hintsHelp')"><QuestionCircleOutlined class="muted" style="margin-left: 4px" /></a-tooltip>
          </template>
          <!-- Hints of disabled platforms stay in the form (and are saved) but are not shown. -->
          <template v-if="platforms.isEnabled('youtube')">
            <a-divider orientation="left" plain><PlatformTag platform="youtube" /></a-divider>
            <a-form-item :label="t('content.ytTitle')"><a-input v-model:value="form.yt.title" :maxlength="100" show-count /></a-form-item>
            <a-form-item :label="t('content.ytDescription')"><a-textarea v-model:value="form.yt.description" :rows="3" :maxlength="5000" /></a-form-item>
            <a-form-item :label="t('content.ytPrivacy')">
              <a-select v-model:value="form.yt.privacy" allow-clear style="width: 200px" :placeholder="t('distribute.privacyOpt.private')"
                :options="['public', 'unlisted', 'private'].map((p) => ({ value: p, label: t(`distribute.privacyOpt.${p}`) }))" />
            </a-form-item>
          </template>
          <template v-if="platforms.isEnabled('instagram')">
            <a-divider orientation="left" plain><PlatformTag platform="instagram" /></a-divider>
            <a-form-item :label="t('content.caption')"><a-textarea v-model:value="form.ig.caption" :rows="3" :maxlength="2200" show-count /></a-form-item>
          </template>
          <template v-if="platforms.isEnabled('tiktok')">
            <a-divider orientation="left" plain><PlatformTag platform="tiktok" /></a-divider>
            <a-form-item :label="t('content.caption')"><a-textarea v-model:value="form.tt.caption" :rows="3" :maxlength="2200" show-count /></a-form-item>
          </template>
          <template v-if="platforms.isEnabled('facebook')">
            <a-divider orientation="left" plain><PlatformTag platform="facebook" /></a-divider>
            <a-form-item :label="t('content.caption')"><a-textarea v-model:value="form.fb.caption" :rows="3" :maxlength="5000" show-count /></a-form-item>
          </template>
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
              <StatusTag kind="publish" :status="item.status" />
              <span class="muted small">{{ fmt(item.scheduledAt) }}</span>
              <a-typography-text v-if="item.errorCode" type="danger" class="small">{{ codeText(item.errorCode, undefined, item.error ?? item.errorCode) }}</a-typography-text>
              <a v-if="item.url" :href="item.url" target="_blank" rel="noopener noreferrer">{{ t('publish.viewPost') }}</a>
            </a-space>
            <template #actions><a @click="router.push({ path: '/publish', query: { tab: 'queue', task: item.id } })">{{ t('common.view') }}</a></template>
          </a-list-item>
        </template>
      </a-list>
    </template>

    <template #footer>
      <a-button @click="editorOpen = false">{{ t('common.cancel') }}</a-button>
      <a-button v-if="editing?.stage === 'archived'" type="primary" :loading="saving" @click="save('ready')">{{ t('common.save') }}</a-button>
      <template v-else>
        <a-button :loading="saving" @click="save('draft')">{{ t('content.saveDraft') }}</a-button>
        <a-button type="primary" :loading="saving" @click="save('ready')">{{ t('content.saveReady') }}</a-button>
      </template>
    </template>
  </a-drawer>

  <MediaPicker v-model:open="pickerOpen" :exclude="form.media.map((m) => m.id)" @pick="onPick" />
  <DistributeModal v-model:open="distributeOpen" :content="distributing" @done="load" />
</template>

