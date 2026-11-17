<script setup lang="ts">
import { dateLocale } from '../i18n'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { DownOutlined, PlusOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { queryParam } from '../api/query'
import { api, codeText, errorText } from '../api/client'
import { langName } from '../api/lang'
import {
  CONTENT_STATUSES, PUBLISH_UNFINISHED,
  type Content, type ContentCategory, type ContentHints, type ContentMedia, type ContentStatus, type ContentTranslation, type LanguageSettings, type ManagedUser, type PostType, type PublishTaskItem,
  type SocialAccount,
} from '../api/types'
import PageContainer from '../components/common/PageContainer.vue'
import ScopedListManager from '../components/common/ScopedListManager.vue'
import SearchBar from '../components/common/SearchBar.vue'
import StatusTag from '../components/common/StatusTag.vue'
import { actionColumn, confirmDanger, DRAWER_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'
import VNodes from '../components/common/VNodes'
import ContentAccountsCell from '../components/content/ContentAccountsCell.vue'
import ContentTargetPicker from '../components/content/ContentTargetPicker.vue'
import DistributeModal from '../components/content/DistributeModal.vue'
import MediaPicker from '../components/content/MediaPicker.vue'
import MediaStrip from '../components/content/MediaStrip.vue'
import PhonePreview from '../components/content/PhonePreview.vue'
import PlatformTextTabs, { type TextTab } from '../components/content/PlatformTextTabs.vue'
import TemplateInsert from '../components/content/TemplateInsert.vue'
import PostTypeTag from '../components/publish/PostTypeTag.vue'
import PlatformTag from '../components/social/PlatformTag.vue'
import { platformName, textField, textMax } from '../components/social/platformMeta'
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
const filters = reactive({ q: '', status: queryParam<ContentStatus>(useRoute().query, 'status'), categoryId: undefined as string | undefined, tag: undefined as string | undefined, lang: undefined as string | undefined, ownerId: undefined as string | undefined })
const facets = ref<{ tags: string[] }>({ tags: [] })
const users = ref<ManagedUser[]>([])
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
const statusText = (s: string) => t(`content.status.${s}`)

async function load() {
  loading.value = true
  try {
    const p = new URLSearchParams({ page: String(page.current), pageSize: String(page.pageSize) })
    if (filters.q.trim()) p.set('q', filters.q.trim())
    for (const k of ['status', 'categoryId', 'tag', 'lang', 'ownerId'] as const) if (filters[k]) p.set(k, filters[k]!)
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
function reset() { Object.assign(filters, { q: '', status: undefined, categoryId: undefined, tag: undefined, lang: undefined, ownerId: undefined }); search(); void loadCategories() }

// ---------------------------------------------------------------- 内容分类: public + personal (admins: every user's, or the owner filter's)
const myId = computed(() => auth.user?.id)
const getCategories = (q: string) => api<{ categories: ContentCategory[] }>('GET', `/api/content-categories?${q}`).then((r) => r.categories)
const ownerScope = (ownerId?: string) => (!ownerId || ownerId === myId.value ? 'scope=mine' : `scope=all-users&ownerId=${ownerId}`)
const publicCats = ref<ContentCategory[]>([])
const personalCats = ref<ContentCategory[]>([])
async function loadCategories() {
  try {
    const personal = auth.isAdmin ? (filters.ownerId ? ownerScope(filters.ownerId) : 'scope=all-users') : 'scope=mine'
    ;[publicCats.value, personalCats.value] = await Promise.all([getCategories('scope=public'), getCategories(personal)])
  } catch (e) { message.error(errorText(e)) }
}
function categoryGroups(pub: ContentCategory[], own: ContentCategory[]) {
  const opt = (c: ContentCategory) => ({ value: c.id, label: c.ownerId && c.ownerId !== myId.value && c.ownerName ? `${c.name} · ${c.ownerName}` : c.name, title: c.description ?? undefined })
  return [
    ...(pub.length ? [{ label: t('content.categories.tabs.public'), options: pub.map(opt) }] : []),
    ...(own.length ? [{ label: t('content.categories.tabs.mine'), options: own.map(opt) }] : []),
  ]
}
const filterCategoryOptions = computed(() => [{ value: 'none', label: t('content.uncategorized') }, ...categoryGroups(publicCats.value, personalCats.value)])
const categoryManagerOpen = ref(false)
function categoriesChanged() { void loadCategories(); void load() }
/** 多语言内容: languages offered in the editor (admin setting). */
const langCfg = ref<LanguageSettings>({ languages: [], defaultSource: null })
async function loadLangs() { try { langCfg.value = await api<LanguageSettings>('GET', '/api/contents/languages') } catch { /* editor still works with the source only */ } }
const langOptions = computed(() => langCfg.value.languages.map((l) => ({ value: l, label: `${langName(l)} (${l})` })))
onMounted(() => { void load(); void loadFacets(); void loadLangs(); void loadCategories() })

const columns = computed(() => [
  { title: t('content.colTitle'), key: 'title', width: 260 },
  { title: t('content.colMedia'), key: 'media', width: 124 },
  { title: t('content.colPublish'), key: 'status', width: 124 },
  { title: t('content.colPublishAt'), key: 'publishAt', width: 124 },
  { title: t('content.colAccounts'), key: 'accounts', width: 176 },
  ...(auth.isAdmin ? [{ title: t('content.colAuthor'), key: 'owner', width: 112 }] : []),
  { title: t('content.colUpdated'), key: 'updated', width: 110 },
  actionColumn(170),
])
const scrollX = computed(() => columns.value.reduce((n, c) => n + c.width, 0))
function onTableChange(p: { current?: number; pageSize?: number }) { page.current = p.current ?? 1; page.pageSize = p.pageSize ?? page.pageSize; void load() }
/** 发布时间: the next due time while a publish task is unfinished, else the latest published time. */
const publishAt = (c: Content) => (c.nextPublishAt ? { at: c.nextPublishAt, next: true } : c.lastPublishedAt ? { at: c.lastPublishedAt, next: false } : null)
const shortFmt = (d: string) => {
  const x = new Date(d)
  return x.toLocaleString(dateLocale(), { ...(x.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}), month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
const TAG_MAX = 3
const publishTotal = (c: Content) => Object.entries(c.publishCounts).filter(([s]) => s !== 'cancelled').reduce((a, [, n]) => a + (n ?? 0), 0)

// ---------------------------------------------------------------- editor
const editorOpen = ref(false)
const saving = ref(false)
const editing = ref<Content | null>(null)
const editorTasks = ref<PublishTaskItem[]>([])
/** Platform hints as plain records; hints of platforms without a tab stay as loaded (and are saved again). */
type Hints = Record<string, Record<string, string | undefined>>
const form = reactive({
  title: '', categoryId: undefined as string | undefined, tags: [] as string[], media: [] as ContentMedia[], ownerId: undefined as string | undefined,
  texts: {} as Record<string, string>, hints: {} as Hints, targets: [] as string[],
})
const pickerOpen = ref(false)
/** 发布目标: accounts of the content's owner (admins pick the owner when creating; it defaults to themselves). */
const targetOwner = computed(() => editing.value?.userId ?? form.ownerId ?? auth.user?.id)
const targetAccounts = ref<SocialAccount[]>([])
const firstTarget = computed(() => targetAccounts.value[0] ?? null)
const previewType = ref<PostType>('feed')
/** The editor's categories: public ones + the content owner's personal ones; 新建分类 adds a personal one of that owner. */
const ownerCats = ref<ContentCategory[]>([])
const formCategoryOptions = computed(() => categoryGroups(publicCats.value, ownerCats.value))
async function loadOwnerCats() {
  if (!editorOpen.value) return
  try { ownerCats.value = await getCategories(ownerScope(targetOwner.value)) } catch (e) { message.error(errorText(e)) }
}
watch([targetOwner, editorOpen], () => { void loadOwnerCats() })
const newCategory = ref('')
async function addCategory() {
  const name = newCategory.value.trim()
  if (!name) return
  try {
    const o = targetOwner.value
    const r = await api<{ category: ContentCategory }>('POST', '/api/content-categories', { scope: 'mine', name, ...(o && o !== myId.value ? { ownerId: o } : {}) })
    newCategory.value = ''
    message.success(t('content.categories.created'))
    await Promise.all([loadOwnerCats(), loadCategories()])
    form.categoryId = r.category.id
  } catch (e) { message.error(errorText(e)) }
}

/**
 * 平台文案 tabs: one text box per enabled platform. The first tab is the body (the text every platform uses);
 * the others are that platform's override (empty = the body). Without enabled platforms there is one body tab ('').
 */
const textPlatforms = computed(() => platforms.scope.enabled.map((p) => p.id))
const primary = computed(() => textPlatforms.value[0] ?? '')
const textTab = ref('')
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const copyHints = (h: unknown): Hints => JSON.parse(JSON.stringify(h ?? {})) as Hints
function cleanHints(h: Hints): Hints {
  const out: Hints = {}
  for (const [p, o] of Object.entries(h)) {
    const v = Object.fromEntries(Object.entries(o ?? {}).filter(([, x]) => x !== undefined && x.trim() !== ''))
    if (Object.keys(v).length) out[p] = v
  }
  return out
}
/** Texts per tab. An older content may carry an override for the first platform: that tab shows it, since it is what gets published. */
function splitTexts(body: string, h: Hints): Record<string, string> {
  const p = primary.value
  const own = p ? str(h[p]?.[textField(p)]) : ''
  const out: Record<string, string> = { [p]: own.trim() ? own : body }
  for (const q of textPlatforms.value.slice(1)) out[q] = str(h[q]?.[textField(q)])
  return out
}
/** Back to body + hints: the first tab is the body (its own override is cleared), the other tabs are overrides. */
function joinTexts(texts: Record<string, string>, base: Hints): { body: string; platformHints: Hints } {
  const h = copyHints(base)
  const p = primary.value
  if (p && h[p]) delete h[p][textField(p)]
  for (const q of textPlatforms.value.slice(1)) (h[q] ??= {})[textField(q)] = texts[q] ?? ''
  return { body: texts[p] ?? '', platformHints: cleanHints(h) }
}
function textTabs(primaryPlaceholder?: string): TextTab[] {
  const p = primary.value
  if (!p) return [{ key: '', platform: null, label: t('content.caption'), max: 5000, placeholder: primaryPlaceholder }]
  return textPlatforms.value.map((q, i) => ({
    key: q, platform: q, max: textMax(q), placeholder: i === 0 ? primaryPlaceholder : t('content.useText', { name: platformName(p) }),
  }))
}
const sourceTabs = computed(() => textTabs())

/** Language versions in the editor ('' = source tab). Saved after the content: deletes, then changed/new versions. */
interface TrForm { lang: string; title: string; texts: Record<string, string>; hints: Hints }
const trs = ref<TrForm[]>([])
const trOrig = ref<Record<string, string>>({})
const SRC = '_source'
const langTab = ref(SRC)
const currentTr = computed(() => trs.value.find((f) => f.lang === langTab.value))
const trTabs = computed(() => textTabs(form.texts[primary.value]))
const sourceLang = ref<string | undefined>()
/** Key-order independent JSON, to tell changed versions apart. */
const stable = (v: unknown): string => (v && typeof v === 'object' && !Array.isArray(v)
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  : JSON.stringify(v))
const toTrForm = (x: ContentTranslation): TrForm => {
  const hints = copyHints(x.platformHints)
  hints.youtube ??= {}
  return { lang: x.lang, title: x.title, texts: splitTexts(x.body, hints), hints }
}
const trBody = (f: TrForm) => ({ title: f.title.trim(), ...joinTexts(f.texts, f.hints) })
function fillTranslations(list: ContentTranslation[]) {
  trs.value = list.map(toTrForm)
  trOrig.value = Object.fromEntries(list.map((x) => [x.lang, stable({ title: x.title.trim(), body: x.body, platformHints: cleanHints(copyHints(x.platformHints)) })]))
  if (!trs.value.some((f) => f.lang === langTab.value)) langTab.value = SRC
}
const addableLangs = computed(() => langCfg.value.languages.filter((l) => l !== sourceLang.value && !trs.value.some((f) => f.lang === l)))
const sourceLangOptions = computed(() => [...new Set([...langCfg.value.languages, ...(sourceLang.value ? [sourceLang.value] : [])])]
  .filter((l) => !trs.value.some((f) => f.lang === l)).map((l) => ({ value: l, label: `${langName(l)} (${l})` })))
function addLang(lang: string) {
  trs.value.push({ lang, title: '', texts: splitTexts('', {}), hints: { youtube: {} } })
  langTab.value = lang
}
function onLangTabEdit(key: unknown, action: 'add' | 'remove') {
  if (action !== 'remove') return
  const lang = String(key)
  confirmDanger({
    title: t('content.lang.removeConfirm', { lang: langName(lang) }), content: t('content.lang.removeHint'), okText: t('content.lang.remove'),
    onOk() { trs.value = trs.value.filter((f) => f.lang !== lang); if (langTab.value === lang) langTab.value = SRC },
  })
}

function fillForm(c: Content | null) {
  const hints = copyHints(c?.platformHints)
  hints.youtube ??= {}
  sourceLang.value = c ? (c.lang ?? undefined) : (langCfg.value.defaultSource ?? undefined)
  Object.assign(form, {
    title: c?.title ?? '', categoryId: c?.category?.id ?? undefined, tags: [...(c?.tags ?? [])], media: [...(c?.media ?? [])],
    ownerId: !c && auth.isAdmin ? auth.user?.id : undefined, targets: (c?.targets ?? []).map((x) => x.id),
    texts: splitTexts(c?.body ?? '', hints), hints,
  })
}
/** The tabs depend on the enabled platforms, so they must be known before the form is filled. */
const platformsReady = () => platforms.load().catch(() => undefined)
async function openNew() {
  await platformsReady()
  editing.value = null; editorTasks.value = []; langTab.value = SRC; textTab.value = primary.value
  fillTranslations([]); fillForm(null); editorOpen.value = true
}
async function openEdit(c: Content) {
  await platformsReady()
  editing.value = c
  langTab.value = SRC
  textTab.value = primary.value
  fillTranslations([])
  fillForm(c)
  editorOpen.value = true
  try {
    const r = await api<{ content: Content; translations: ContentTranslation[]; publishTasks: PublishTaskItem[] }>('GET', `/api/contents/${c.id}`)
    editing.value = r.content
    editorTasks.value = r.publishTasks
    fillForm(r.content)
    fillTranslations(r.translations)
  } catch (e) { message.error(errorText(e)) }
}
function moveMedia(i: number, d: number) {
  const m = [...form.media]
  const [x] = m.splice(i, 1)
  m.splice(i + d, 0, x!)
  form.media = m
}
/** 话术库: puts a post template's text into the current text tab; the person edits it before saving. */
function insertTemplate(text: string, replace: boolean) {
  const texts = currentTr.value?.texts ?? form.texts
  const cur = texts[textTab.value] ?? ''
  texts[textTab.value] = replace || !cur.trim() ? text : `${cur.replace(/\s+$/, '')}\n\n${text}`
}
/** Phone preview text: the active language + platform tab (an empty platform tab falls back to the body). */
const previewText = computed(() => {
  const texts = currentTr.value?.texts ?? form.texts
  return texts[textTab.value]?.trim() ? texts[textTab.value]! : texts[primary.value] ?? ''
})
const onPick = (picked: ContentMedia[]) => { form.media = [...form.media, ...picked.filter((p) => !form.media.some((m) => m.id === p.id))] }

/** Saves the editor; resolves to the saved content, or null when validation or a request failed (already shown). */
async function save(stage: 'draft' | 'ready'): Promise<Content | null> {
  if (!form.title.trim()) { langTab.value = SRC; message.warning(t('content.titleRequired')); return null }
  const untitled = trs.value.find((f) => !f.title.trim())
  if (untitled) { langTab.value = untitled.lang; message.warning(t('content.lang.needTitle', { lang: langName(untitled.lang) })); return null }
  saving.value = true
  try {
    const { body: text, platformHints } = joinTexts(form.texts, form.hints)
    const body = {
      title: form.title.trim(), body: text, categoryId: form.categoryId ?? null, tags: form.tags, mediaIds: form.media.map((m) => m.id), platformHints: platformHints as ContentHints,
      targetIds: form.targets,
      lang: sourceLang.value ?? null, ...(editing.value?.stage === 'archived' ? {} : { stage }),
    }
    let saved: Content
    const editId = editing.value?.id
    if (editId) {
      // Removed versions first, so the original language may move to a language whose version was just removed.
      for (const lang of Object.keys(trOrig.value)) if (!trs.value.some((f) => f.lang === lang)) await api('DELETE', `/api/contents/${editId}/translations/${lang}`)
      saved = (await api<{ content: Content }>('PUT', `/api/contents/${editId}`, body)).content
    } else saved = (await api<{ content: Content }>('POST', '/api/contents', { ...body, ...(form.ownerId && form.ownerId !== auth.user?.id ? { ownerId: form.ownerId } : {}) })).content
    const id = saved.id
    for (const f of trs.value) {
      const b = trBody(f)
      if (trOrig.value[f.lang] !== stable(b)) await api('PUT', `/api/contents/${id}/translations/${f.lang}`, b)
    }
    message.success(t('common.saved'))
    editorOpen.value = false
    void load(); void loadFacets()
    return saved
  } catch (e) { message.error(errorText(e)); return null } finally { saving.value = false }
}
/** 定时发布 / 立即发布 in the editor: save as ready (closes the editor), then the publishing step for that content. */
async function saveAndPublish(mode: 'now' | 'at') {
  const c = await save('ready')
  if (c) openDistribute(c, mode)
}
// ---------------------------------------------------------------- actions
const distributeOpen = ref(false)
const distributing = ref<Content | null>(null)
const distributeMode = ref<'now' | 'at'>('now')
function openDistribute(c: Content, mode: 'now' | 'at') { distributing.value = c; distributeMode.value = mode; distributeOpen.value = true }

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
      <a-button @click="categoryManagerOpen = true">{{ t('content.categories.manage') }}</a-button>
      <a-button @click="router.push('/publish')">{{ t('content.openScheduler') }}</a-button>
      <a-button type="primary" @click="openNew"><template #icon><PlusOutlined /></template>{{ t('content.add') }}</a-button>
    </template>

    <a-card :bordered="false">
      <SearchBar :loading="loading" @reset="reset" @refresh="load">
        <a-input-search v-model:value="filters.q" :placeholder="t('content.searchPlaceholder')" allow-clear style="width: 240px" @search="search" />
        <a-select v-model:value="filters.status" :placeholder="t('content.colStatus')" allow-clear style="width: 140px" @change="search">
          <a-select-option v-for="s in CONTENT_STATUSES" :key="s" :value="s">{{ statusText(s) }}</a-select-option>
        </a-select>
        <a-select v-model:value="filters.categoryId" :placeholder="t('content.colCategory')" allow-clear show-search option-filter-prop="label" style="width: 160px"
          :options="filterCategoryOptions" @change="search" />
        <a-select v-model:value="filters.lang" :placeholder="t('content.lang.filter')" allow-clear style="width: 140px" :options="langOptions" @change="search" />
        <a-select v-model:value="filters.tag" :placeholder="t('content.colTags')" allow-clear show-search style="width: 140px" :options="facets.tags.map((x) => ({ value: x, label: x }))" @change="search" />
        <a-select v-if="auth.isAdmin" v-model:value="filters.ownerId" :placeholder="t('content.colAuthor')" allow-clear show-search option-filter-prop="label" style="width: 140px"
          :options="users.map((u) => ({ value: u.id, label: u.username }))" @change="filters.categoryId = undefined; search(); loadFacets(); loadCategories()" />
      </SearchBar>

      <a-table :data-source="items" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :scroll="{ x: scrollX }"
        :pagination="pagination({ current: page.current, pageSize: page.pageSize, total })" @change="onTableChange">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'title'">
            <a class="title-link ellipsis" :title="record.title" @click="openEdit(record)">{{ record.title }}</a>
            <div v-if="record.category || record.tags.length || record.lang || record.translations.length" class="meta">
              <a-tag v-if="record.category" color="blue" class="chip">{{ record.category.name }}</a-tag>
              <a-tag v-for="tg in record.tags.slice(0, TAG_MAX)" :key="tg" class="chip">#{{ tg }}</a-tag>
              <a-tooltip v-if="record.tags.length > TAG_MAX" :title="record.tags.slice(TAG_MAX).map((x: string) => `#${x}`).join(' ')">
                <a-tag class="chip">+{{ record.tags.length - TAG_MAX }}</a-tag>
              </a-tooltip>
              <a-tooltip v-if="record.lang" :title="`${t('content.lang.source')} · ${langName(record.lang)}`"><a-tag class="chip lang">{{ record.lang }}</a-tag></a-tooltip>
              <a-tooltip v-for="l in record.translations" :key="l" :title="langName(l)"><a-tag class="chip lang">{{ l }}</a-tag></a-tooltip>
            </div>
          </template>
          <template v-else-if="column.key === 'media'">
            <MediaStrip v-if="record.media.length" :media="record.media" :size="32" :max="3" />
            <span v-else class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'status'">
            <div class="status-cell">
              <StatusTag kind="content" :status="record.status" />
              <a-tooltip v-if="publishTotal(record)" :title="t('content.publishSummary', { published: record.publishCounts.published ?? 0, total: publishTotal(record) })">
                <a class="small count" @click="router.push({ path: '/publish', query: { tab: 'queue', contentId: record.id } })">{{ record.publishCounts.published ?? 0 }}/{{ publishTotal(record) }}</a>
              </a-tooltip>
            </div>
          </template>
          <template v-else-if="column.key === 'publishAt'">
            <template v-if="publishAt(record)">
              <a-tooltip :title="fmt(publishAt(record)!.at)"><div class="nowrap">{{ shortFmt(publishAt(record)!.at) }}</div></a-tooltip>
              <div class="muted small">{{ publishAt(record)!.next ? t('content.publishAtNext') : t('content.publishAtLast') }}</div>
            </template>
            <span v-else class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'accounts'"><ContentAccountsCell :content="record" /></template>
          <template v-else-if="column.key === 'owner'">
            <span v-if="record.ownerName" class="author">
              <a-avatar :size="20" class="avatar">{{ record.ownerName.charAt(0).toUpperCase() }}</a-avatar>
              <span class="ellipsis" :title="record.ownerName">{{ record.ownerName }}</span>
            </span>
            <span v-else class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'updated'">
            <a-tooltip :title="fmt(record.updatedAt)"><span class="muted nowrap">{{ shortFmt(record.updatedAt) }}</span></a-tooltip>
          </template>
          <template v-else-if="column.key === 'ops'">
            <a-space :size="0">
              <a-button type="link" size="small" @click="openEdit(record)">{{ t('common.edit') }}</a-button>
              <template v-if="record.stage !== 'archived'">
                <a-button type="link" size="small" @click="openDistribute(record, 'now')">{{ t('content.publish') }}</a-button>
              </template>
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

  <a-drawer v-model:open="editorOpen" :title="editing ? t('content.edit') : t('content.add')" :width="DRAWER_WIDTH.lg + 360" destroy-on-close>
    <a-row :gutter="24">
    <a-col :xs="24" :lg="15">
    <a-tabs v-model:active-key="langTab" type="editable-card" size="small" hide-add class="lang-tabs" @edit="onLangTabEdit">
      <a-tab-pane :key="SRC" :closable="false">
        <template #tab>{{ sourceLang ? langName(sourceLang) : t('content.lang.source') }}<a-tag v-if="sourceLang" class="src-tag">{{ t('content.lang.source') }}</a-tag></template>
      </a-tab-pane>
      <a-tab-pane v-for="f in trs" :key="f.lang" :tab="langName(f.lang)" />
      <template #rightExtra>
        <a-dropdown :disabled="!addableLangs.length" :trigger="['click']">
          <a-button size="small"><template #icon><PlusOutlined /></template>{{ t('content.lang.add') }}</a-button>
          <template #overlay>
            <a-menu @click="({ key }: { key: string | number }) => addLang(String(key))">
              <a-menu-item v-for="l in addableLangs" :key="l">{{ langName(l) }} ({{ l }})</a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </template>
    </a-tabs>

    <a-form v-if="currentTr" :key="currentTr.lang" layout="vertical">
      <a-form-item :label="t('content.fieldTitle')" required>
        <a-input v-model:value="currentTr.title" :maxlength="200" show-count :placeholder="form.title" />
      </a-form-item>
      <a-form-item :label="t('content.caption')">
        <PlatformTextTabs v-model:active="textTab" :tabs="trTabs" :values="currentTr.texts">
          <template #extra><TemplateInsert :default-persona-id="firstTarget?.personaId" @insert="insertTemplate" /></template>
          <template #default="{ tab }">
            <a-form-item v-if="tab.key === 'youtube'" :label="t('content.ytTitle')" class="tab-field">
              <a-input v-model:value="currentTr.hints.youtube!.title" :maxlength="100" show-count :placeholder="form.hints.youtube?.title || currentTr.title || form.title" />
            </a-form-item>
          </template>
        </PlatformTextTabs>
      </a-form-item>
    </a-form>

    <a-form v-show="!currentTr" layout="vertical">
      <a-form-item v-if="!editing && auth.isAdmin" :label="t('content.owner')">
        <a-select v-model:value="form.ownerId" show-search option-filter-prop="label" :options="users.map((u) => ({ value: u.id, label: u.username }))" @change="form.targets = []; form.categoryId = undefined" />
      </a-form-item>
      <a-form-item :label="t('content.targets.label')">
        <ContentTargetPicker v-model="form.targets" :owner-id="targetOwner" @accounts="(a: SocialAccount[]) => (targetAccounts = a)" />
      </a-form-item>
      <a-form-item :label="t('content.fieldTitle')" required>
        <a-input v-model:value="form.title" :maxlength="200" show-count />
      </a-form-item>
      <a-form-item :label="t('content.caption')">
        <PlatformTextTabs v-model:active="textTab" :tabs="sourceTabs" :values="form.texts">
          <template #extra><TemplateInsert :default-persona-id="firstTarget?.personaId" @insert="insertTemplate" /></template>
          <template #default="{ tab }">
            <a-row v-if="tab.key === 'youtube'" :gutter="12" class="tab-field">
              <a-col :xs="24" :sm="16">
                <a-form-item :label="t('content.ytTitle')"><a-input v-model:value="form.hints.youtube!.title" :maxlength="100" show-count :placeholder="form.title" /></a-form-item>
              </a-col>
              <a-col :xs="24" :sm="8">
                <a-form-item :label="t('content.ytPrivacy')">
                  <a-select v-model:value="form.hints.youtube!.privacy" allow-clear :placeholder="t('distribute.privacyOpt.private')"
                    :options="['public', 'unlisted', 'private'].map((p) => ({ value: p, label: t(`distribute.privacyOpt.${p}`) }))" />
                </a-form-item>
              </a-col>
            </a-row>
          </template>
        </PlatformTextTabs>
      </a-form-item>
      <a-row :gutter="12">
        <a-col :xs="24" :sm="8">
          <a-form-item :label="t('content.lang.sourceLang')">
            <a-select v-model:value="sourceLang" :options="sourceLangOptions" allow-clear :placeholder="t('content.lang.notSet')" />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="8">
          <a-form-item :label="t('content.fieldCategory')">
            <a-select v-model:value="form.categoryId" :options="formCategoryOptions" :dropdown-style="{ minWidth: '240px' }" allow-clear show-search option-filter-prop="label" :placeholder="t('content.uncategorized')">
              <template #dropdownRender="{ menuNode }">
                <VNodes :vnodes="menuNode" />
                <a-divider style="margin: 4px 0" />
                <div class="new-category">
                  <a-input v-model:value="newCategory" size="small" :maxlength="50" :placeholder="t('content.categories.namePlaceholder')" @press-enter="addCategory" @keydown.stop />
                  <a-button type="link" size="small" :disabled="!newCategory.trim()" @click="addCategory"><template #icon><PlusOutlined /></template>{{ t('content.categories.add') }}</a-button>
                </div>
              </template>
            </a-select>
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="8">
          <a-form-item :label="t('content.fieldTags')">
            <a-select v-model:value="form.tags" mode="tags" :options="facets.tags.map((x) => ({ value: x }))" :token-separators="[',']" />
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item :label="t('content.fieldMedia', { n: form.media.length })">
        <MediaStrip :media="form.media" :size="88" editable @move="moveMedia" @remove="(i: number) => form.media.splice(i, 1)" />
        <a-button style="margin-top: 8px" :disabled="form.media.length >= 20" @click="pickerOpen = true"><template #icon><PlusOutlined /></template>{{ t('content.addMedia') }}</a-button>
      </a-form-item>
    </a-form>

    <template v-if="editing && editorTasks.length && !currentTr">
      <a-divider orientation="left" plain>{{ t('content.tasksOf') }}</a-divider>
      <a-list size="small" :data-source="editorTasks">
        <template #renderItem="{ item }">
          <a-list-item>
            <a-space wrap>
              <PlatformTag :platform="item.platform" />
              <PostTypeTag :type="item.postType" />
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
    </a-col>
    <a-col :xs="24" :lg="9">
      <div class="preview-col"><PhonePreview v-model:mode="previewType" :media="form.media" :text="previewText" :handle="firstTarget?.handle ?? null" /></div>
    </a-col>
    </a-row>

    <template #footer>
      <a-button @click="editorOpen = false">{{ t('common.cancel') }}</a-button>
      <a-button v-if="editing?.stage === 'archived'" type="primary" :loading="saving" @click="save('ready')">{{ t('common.save') }}</a-button>
      <template v-else>
        <a-button :loading="saving" @click="save('draft')">{{ t('content.saveDraft') }}</a-button>
        <a-dropdown-button type="primary" :loading="saving" :trigger="['click']" @click="saveAndPublish('at')">
          {{ t('content.publishLater') }}
          <template #icon><DownOutlined /></template>
          <template #overlay>
            <a-menu @click="saveAndPublish('now')">
              <a-menu-item key="now">{{ t('content.publishNow') }}</a-menu-item>
            </a-menu>
          </template>
        </a-dropdown-button>
      </template>
    </template>
  </a-drawer>

  <MediaPicker v-model:open="pickerOpen" :exclude="form.media.map((m) => m.id)" @pick="onPick" />
  <DistributeModal v-model:open="distributeOpen" :content="distributing" :mode="distributeMode" @done="load" />
  <ScopedListManager v-model:open="categoryManagerOpen" path="/api/content-categories" list-key="categories" texts="content.categories" @changed="categoriesChanged" />
</template>


<style scoped>
.title-link { display: block; font-weight: 500; }
.meta { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.meta .chip { margin: 0; font-size: 11px; line-height: 18px; padding-inline: 5px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta .chip.lang { color: var(--cp-text-secondary); }
.status-cell { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.status-cell :deep(.ant-tag) { margin: 0; }
.status-cell .count { font-variant-numeric: tabular-nums; }
.author { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0; }
.author .avatar { background: var(--cp-primary); flex: none; font-size: 11px; }
.src-tag { margin-inline-start: 6px; margin-inline-end: 0; font-size: 11px; line-height: 16px; padding-inline: 4px; }
.lang-tabs { margin-bottom: 12px; }
.tab-field { margin-top: 16px; margin-bottom: 0; }
.preview-col { position: sticky; top: 0; padding-bottom: 16px; }
.new-category { display: flex; gap: 4px; padding: 4px 8px; }
</style>
