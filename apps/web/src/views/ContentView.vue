<script setup lang="ts">
import { dateLocale, fmtDateTime } from '../i18n'
import { computed, h, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { LockOutlined, PlusOutlined } from '@ant-design/icons-vue'
import dayjs, { type Dayjs } from 'dayjs'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { api, codeText, errorText, type ErrorParams } from '../api/client'
import { langName } from '../api/lang'
import {
  CONTENT_STATUSES, PUBLISH_UNFINISHED,
  type Content, type ContentCategory, type ContentHints, type ContentMedia, type ContentStatus, type ContentLanguages, type ContentTranslation, type ManagedUser, type PostType, type PublishTaskItem,
  type MediaItem, type SocialAccount,
} from '../api/types'
import PageContainer from '../components/common/PageContainer.vue'
import BatchActions, { type BatchItem } from '../components/common/BatchActions.vue'
import BatchFormModal from '../components/common/BatchFormModal.vue'
import BatchPublishModal from '../components/content/BatchPublishModal.vue'
import ScopedListManager from '../components/common/ScopedListManager.vue'
import SearchBar from '../components/common/SearchBar.vue'
import StatusTag from '../components/common/StatusTag.vue'
import { actionColumn, confirmAction, confirmDanger, DRAWER_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'
import VNodes from '../components/common/VNodes'
import ContentAccountsCell from '../components/content/ContentAccountsCell.vue'
import ContentMediaUpload from '../components/content/ContentMediaUpload.vue'
import ContentTargetPicker from '../components/content/ContentTargetPicker.vue'
import MediaPicker from '../components/content/MediaPicker.vue'
import MediaStrip from '../components/content/MediaStrip.vue'
import PhonePreview from '../components/content/PhonePreview.vue'
import PlatformTextTabs, { type TextTab } from '../components/content/PlatformTextTabs.vue'
import TemplateInsert from '../components/content/TemplateInsert.vue'
import PersonaCard from '../components/comments/PersonaCard.vue'
import { toContentMedia } from '../components/media/media'
import PostTypeTag from '../components/publish/PostTypeTag.vue'
import PublishAttemptRows from '../components/publish/PublishAttemptRows.vue'
import PlatformTag from '../components/social/PlatformTag.vue'
import { platformName, textField, textMax } from '../components/social/platformMeta'
import { useAuthStore } from '../stores/auth'
import { usePlatformsStore } from '../stores/platforms'

/** Content management (内容管理): list, editor, distribution to social accounts. */
const { t } = useI18n()
const auth = useAuthStore()
const platforms = usePlatformsStore()
const router = useRouter()
const route = useRoute()

const items = ref<Content[]>([])
const total = ref(0)
const loading = ref(false)
const page = reactive({ current: 1, pageSize: 20 })
/** `tag` = the system tag filter only (「AI 草稿」 quick filter = `ai-draft`; also read from `?tag=`): manual tags have no UI. */
const filters = reactive({
  q: '', categoryId: undefined as string | undefined, tag: (typeof route.query.tag === 'string' && route.query.tag) || undefined as string | undefined,
  lang: undefined as string | undefined, ownerId: undefined as string | undefined,
})
const users = ref<ManagedUser[]>([])
const statusText = (s: string) => t(`content.status.${s}`)

/**
 * 分区 tabs over the derived contents.status (no extra field). `?status=` in the URL holds the tab's csv; a narrower
 * value (e.g. ?status=scheduled from a dashboard link) opens the tab containing it and keeps that filter until cleared.
 */
const TABS = {
  all: [], draft: ['draft'], pending: ['ready', 'scheduled'], published: ['published', 'partially_published'], failed: ['failed'], archived: ['archived'],
} as const satisfies Record<string, readonly ContentStatus[]>
type Tab = keyof typeof TABS
const TAB_KEYS = Object.keys(TABS) as Tab[]
function tabFromQuery(): { tab: Tab; only: ContentStatus[] } {
  const v = route.query.status
  const want = (typeof v === 'string' ? v.split(',') : []).filter((x): x is ContentStatus => (CONTENT_STATUSES as string[]).includes(x))
  if (!want.length) return { tab: 'all', only: [] }
  const same = (a: readonly string[]) => a.length === want.length && want.every((x) => a.includes(x))
  const exact = TAB_KEYS.find((k) => k !== 'all' && same(TABS[k]))
  if (exact) return { tab: exact, only: [] }
  return { tab: TAB_KEYS.find((k) => k !== 'all' && want.every((x) => (TABS[k] as readonly string[]).includes(x))) ?? 'all', only: want }
}
const initial = tabFromQuery()
const tab = ref<Tab>(initial.tab)
const onlyStatus = ref<ContentStatus[]>(initial.only)
const byStatus = ref<Partial<Record<ContentStatus, number>>>({})
const tabCount = (k: Tab) => (k === 'all' ? CONTENT_STATUSES : TABS[k]).reduce((n, s) => n + (byStatus.value[s] ?? 0), 0)
const statusParam = () => (onlyStatus.value.length ? onlyStatus.value : TABS[tab.value]).join(',')
function setTab(k: Tab) {
  tab.value = k
  onlyStatus.value = []
  selectedKeys.value = []
  void router.replace({ query: { ...route.query, status: statusParam() || undefined } })
  search()
}

async function load() {
  loading.value = true
  try {
    const p = new URLSearchParams({ page: String(page.current), pageSize: String(page.pageSize) })
    if (filters.q.trim()) p.set('q', filters.q.trim())
    if (statusParam()) p.set('status', statusParam())
    for (const k of ['categoryId', 'tag', 'lang', 'ownerId'] as const) if (filters[k]) p.set(k, filters[k]!)
    const r = await api<{ items: Content[]; total: number; byStatus: Partial<Record<ContentStatus, number>> }>('GET', `/api/contents?${p}`)
    items.value = r.items
    total.value = r.total
    byStatus.value = r.byStatus
    const ids = new Set(r.items.map((i) => i.id))
    selectedKeys.value = selectedKeys.value.filter((k) => ids.has(k))
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
async function loadUsers() {
  if (!auth.isAdmin || users.value.length) return
  try { users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users } catch (e) { message.error(errorText(e)) }
}
const search = () => { page.current = 1; void load() }
/** `?tag=` (an older link): shown as a closable chip; there is no tag UI any more. */
function setTagFilter(tag: string | undefined) {
  filters.tag = tag
  void router.replace({ query: { ...route.query, tag } })
  search()
}
function reset() { Object.assign(filters, { q: '', categoryId: undefined, lang: undefined, ownerId: undefined }); setTagFilter(undefined); void loadCategories() }

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
/**
 * 多语言内容: Chinese is the fixed source; 配置语系 = languages bound to the visible social accounts (list filter), or to
 * the content owner's accounts (editor, `editorLangs`).
 */
const SOURCE_LANG = 'zh-CN'
const langCfg = ref<ContentLanguages>({ source: SOURCE_LANG, configured: [], languages: [SOURCE_LANG] })
async function loadLangs() { try { langCfg.value = await api<ContentLanguages>('GET', '/api/contents/languages') } catch { /* filter offers Chinese only */ } }
const langOptions = computed(() => langCfg.value.languages.map((l) => ({ value: l, label: `${langName(l)} (${l})` })))
onMounted(() => { void load(); void loadUsers(); void loadLangs(); void loadCategories(); void openFromQuery() })

/** `?edit=<content>` opens that content in the editor (older links may still carry `account` / `postType`: ignored). */
async function openFromQuery() {
  const { edit, account: _a, postType: _p, ...rest } = route.query
  if (typeof edit !== 'string') return
  void router.replace({ query: rest })
  try {
    const r = await api<{ content: Content }>('GET', `/api/contents/${edit}`)
    await openEdit(r.content)
  } catch (e) { message.error(errorText(e)) }
}

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
/** AI 草稿 (system tag `ai-draft`) are marked 「AI 草稿」 (tooltip: persona, model, time). */
const aiInfo = (c: Content) => (c.aiGenerated
  ? t('content.aiDraftInfo', { persona: c.aiGenerated.personaName, model: c.aiGenerated.model, at: fmtDateTime(c.aiGenerated.generatedAt) })
  : '')

// ---------------------------------------------------------------- editor
const editorOpen = ref(false)
const saving = ref(false)
const editing = ref<Content | null>(null)
const editorTasks = ref<PublishTaskItem[]>([])
/** 已发布的内容不能编辑: the editor opens read only (查看); only the not yet published targets can still be published. */
const locked = computed(() => Boolean(editing.value?.locked))
const publishedIds = computed(() => new Set(editorTasks.value.filter((x) => x.status === 'published').map((x) => x.accountId)))
const remainingTargets = computed(() => form.targets.filter((id) => !publishedIds.value.has(id)))
/** 发布任务 in the editor: one block per account = its newest task, its older attempts (编辑后重新发布) always listed under it. */
const editorTaskGroups = computed(() => {
  const by = new Map<string, PublishTaskItem[]>()
  for (const x of [...editorTasks.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) by.set(x.accountId, [...(by.get(x.accountId) ?? []), x])
  return [...by.values()].map(([latest, ...older]) => ({ ...latest!, older }))
})
function openPublishTask(id: string) { void router.push({ path: '/publish', query: { tab: 'queue', task: id } }) }
/** Platform hints as plain records; hints of platforms without a tab stay as loaded (and are saved again). */
type Hints = Record<string, Record<string, string | undefined>>
const form = reactive({
  title: '', categoryId: undefined as string | undefined, media: [] as ContentMedia[], ownerId: undefined as string | undefined,
  texts: {} as Record<string, string>, hints: {} as Hints, targets: [] as string[],
})
const pickerOpen = ref(false)
/** 发布目标: accounts of the content's owner (admins pick the owner when creating; it defaults to themselves). */
const targetOwner = computed(() => editing.value?.userId ?? form.ownerId ?? auth.user?.id)
const targetAccounts = ref<SocialAccount[]>([])
const firstTarget = computed(() => targetAccounts.value[0] ?? null)
/** 配置语系 of the content owner (editor tabs when the content has no targets). */
const editorLangs = ref<string[]>([])
watch([targetOwner, editorOpen], async () => {
  if (!editorOpen.value) return
  const o = targetOwner.value
  try { editorLangs.value = (await api<ContentLanguages>('GET', `/api/contents/languages${auth.isAdmin && o ? `?ownerId=${o}` : ''}`)).configured } catch { editorLangs.value = [] }
})
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
/**
 * A translation's text tabs: the body plus only the platforms that carry their own text in the source or in this
 * translation (a platform without an override publishes the body, so its translation needs none either).
 */
const trTabs = computed(() => {
  const own = (q: string) => Boolean(form.texts[q]?.trim() || currentTr.value?.texts[q]?.trim() || (q === 'youtube' && (form.hints.youtube?.title || currentTr.value?.hints.youtube?.title)))
  return textTabs(form.texts[primary.value]).filter((tb, i) => i === 0 || own(tb.key))
})
watch([langTab, trTabs], () => {
  if (currentTr.value && !trTabs.value.some((tb) => tb.key === textTab.value)) textTab.value = primary.value
})
/** Source language: zh-CN for new contents; older contents keep theirs (read-only). */
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
  syncLangs()
}
/**
 * Languages the content needs: those of its target accounts (publishing uses the translation in the account's language,
 * else the source), or the owner's 配置语系 when it has no targets. Each one gets a translation block automatically
 * (`syncLangs`); an empty, never-saved block whose language is no longer needed is dropped again. Saved translations
 * stay until they are deleted explicitly (closing their tab).
 */
const wantedLangs = computed(() => {
  const fromTargets = [...new Set(targetAccounts.value.flatMap((a) => (a.lang ? [a.lang] : [])))]
  return (form.targets.length ? fromTargets : editorLangs.value).filter((l) => l !== sourceLang.value)
})
const emptyTr = (f: TrForm) => !f.title.trim() && !Object.values(f.texts).some((x) => x.trim()) && !Object.values(cleanHints(f.hints)).length
/** 已填 = title and text present; otherwise 缺少译文 (publishing to that language then uses the Chinese original). */
const trFilled = (f: TrForm) => Boolean(f.title.trim() && Object.values(f.texts).some((x) => x.trim()))
const isSaved = (lang: string) => lang in trOrig.value
function syncLangs() {
  const want = wantedLangs.value
  const kept = trs.value.filter((f) => want.includes(f.lang) || isSaved(f.lang) || !emptyTr(f))
  for (const l of want) if (!kept.some((f) => f.lang === l)) kept.push({ lang: l, title: '', texts: splitTexts('', {}), hints: { youtube: {} } })
  if (kept.length !== trs.value.length || kept.some((f, i) => f !== trs.value[i])) trs.value = kept
  if (langTab.value !== SRC && !kept.some((f) => f.lang === langTab.value)) langTab.value = SRC
}
watch(wantedLangs, syncLangs)
/** Target accounts per language (tab tooltip). */
const langAccounts = (lang: string) => targetAccounts.value.filter((a) => a.lang === lang).map((a) => `@${a.handle}`)
/** A needed, never-saved block would come straight back, so only saved or no longer needed blocks can be closed. */
const trClosable = (f: TrForm) => !locked.value && (isSaved(f.lang) || !wantedLangs.value.includes(f.lang))
function onLangTabEdit(key: unknown, action: 'add' | 'remove') {
  if (action !== 'remove') return
  const lang = String(key)
  const drop = () => { trs.value = trs.value.filter((f) => f.lang !== lang); if (langTab.value === lang) langTab.value = SRC; syncLangs() }
  if (!isSaved(lang)) { drop(); return }
  confirmDanger({
    title: t('content.lang.removeConfirm', { lang: langName(lang) }), content: t('content.lang.removeHint'), okText: t('content.lang.remove'),
    onOk: drop,
  })
}

function fillForm(c: Content | null) {
  const hints = copyHints(c?.platformHints)
  hints.youtube ??= {}
  sourceLang.value = c ? (c.lang ?? undefined) : SOURCE_LANG
  Object.assign(form, {
    title: c?.title ?? '', categoryId: c?.category?.id ?? undefined, media: [...(c?.media ?? [])],
    ownerId: !c && auth.isAdmin ? auth.user?.id : undefined, targets: (c?.targets ?? []).map((x) => x.id),
    texts: splitTexts(c?.body ?? '', hints), hints,
  })
}
/** The tabs depend on the enabled platforms, so they must be known before the form is filled. */
const platformsReady = () => platforms.load().catch(() => undefined)
async function openNew() {
  await platformsReady()
  editing.value = null; editorTasks.value = []; langTab.value = SRC; textTab.value = primary.value
  fillForm(null); fillTranslations([]); editorOpen.value = true
}
async function openEdit(c: Content) {
  await platformsReady()
  editing.value = c
  langTab.value = SRC
  textTab.value = primary.value
  fillForm(c)
  fillTranslations([])
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
/** 插入话术: puts a 范例 of a target account's persona into the current text tab; the person edits it before saving. */
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
/**
 * Persona cards beside the editor: the target accounts' 账号人设 (+ an AI draft's own persona). Their banned words are
 * refused by the API on save / publish (persona.banned_word); the cards flag them while typing (source texts + title).
 */
const editorPersonas = computed(() => [...new Set([
  ...targetAccounts.value.filter((a) => form.targets.includes(a.id)).flatMap((a) => (a.personaId ? [a.personaId] : [])),
  ...(editing.value?.aiGenerated?.personaId ? [editing.value.aiGenerated.personaId] : []),
])])
const personaText = computed(() => [form.title, ...Object.values(form.texts), ...(currentTr.value ? [currentTr.value.title, ...Object.values(currentTr.value.texts)] : [])].join('\n'))
const onPick = (picked: ContentMedia[]) => { form.media = [...form.media, ...picked.filter((p) => !form.media.some((m) => m.id === p.id))] }

/**
 * 上传: the editor uploads into the content owner's personal media (an admin on someone else's content via ownerId);
 * a content may only use its owner's private media (content.media_not_usable), so non-admins are blocked with a hint there. New assets are appended in order
 * while they are still processing (the API accepts that; publishing waits for ready: publish.media_not_ready) and are
 * polled until the media-process task has finished.
 */
const MAX_MEDIA = 20
const otherOwner = computed(() => Boolean(targetOwner.value && targetOwner.value !== myId.value))
/** Admin on another user's content: uploads go to that owner's personal media (ownerId); others are blocked. */
const uploadOwner = computed(() => (otherOwner.value && auth.isAdmin ? targetOwner.value : undefined))
const uploadOwnerName = computed(() => editing.value?.ownerName ?? users.value.find((u) => u.id === targetOwner.value)?.username ?? null)
const uploadBlocked = computed(() => (otherOwner.value && !auth.isAdmin ? t('content.uploadOtherOwner') : ''))
function onUploaded(items: ContentMedia[]) {
  const fresh = items.filter((p) => !form.media.some((m) => m.id === p.id))
  const room = Math.max(0, MAX_MEDIA - form.media.length)
  if (fresh.length > room) message.warning(t('content.uploadOverLimit', { max: MAX_MEDIA, n: fresh.length - room }))
  form.media = [...form.media, ...fresh.slice(0, room)]
}
const processingMedia = computed(() => form.media.filter((m) => m.status === 'processing').map((m) => m.id))
let mediaPoll: ReturnType<typeof setTimeout> | undefined
function scheduleMediaPoll() {
  clearTimeout(mediaPoll)
  if (editorOpen.value && processingMedia.value.length) mediaPoll = setTimeout(() => void pollMedia(), 3000)
}
async function pollMedia() {
  const fresh = await Promise.all(processingMedia.value.map((id) => api<{ item: MediaItem }>('GET', `/api/media/${id}`).then((r) => r.item).catch(() => null)))
  const done = fresh.filter((x): x is MediaItem => Boolean(x) && x!.status !== 'processing')
  if (!editorOpen.value) return
  if (!done.length) { scheduleMediaPoll(); return }
  form.media = form.media.map((m) => { const d = done.find((x) => x.id === m.id); return d ? toContentMedia(d) : m })
  for (const d of done) if (d.status === 'failed') message.error(t('content.uploadFailed', { name: d.name, error: d.error ?? '' }))
}
watch([processingMedia, editorOpen], scheduleMediaPoll)
onBeforeUnmount(() => clearTimeout(mediaPoll))

/** Saves the editor; resolves to the saved content, or null when validation or a request failed (already shown). */
async function save(stage: 'draft' | 'ready'): Promise<Content | null> {
  if (!form.title.trim()) { langTab.value = SRC; message.warning(t('content.titleRequired')); return null }
  // Empty blocks that were never saved (added for a target language, nothing written yet) are not saved.
  const toSave = trs.value.filter((f) => isSaved(f.lang) || !emptyTr(f))
  const untitled = toSave.find((f) => !f.title.trim())
  if (untitled) { langTab.value = untitled.lang; message.warning(t('content.lang.needTitle', { lang: langName(untitled.lang) })); return null }
  saving.value = true
  try {
    const { body: text, platformHints } = joinTexts(form.texts, form.hints)
    const body = {
      title: form.title.trim(), body: text, categoryId: form.categoryId ?? null, mediaIds: form.media.map((m) => m.id), platformHints: platformHints as ContentHints,
      targetIds: form.targets,
      ...(editing.value?.stage === 'archived' ? {} : { stage }),
    }
    let saved: Content
    const editId = editing.value?.id
    if (editId) {
      for (const lang of Object.keys(trOrig.value)) if (!trs.value.some((f) => f.lang === lang)) await api('DELETE', `/api/contents/${editId}/translations/${lang}`)
      saved = (await api<{ content: Content }>('PUT', `/api/contents/${editId}`, body)).content
    } else {
      saved = (await api<{ content: Content }>('POST', '/api/contents', { ...body, ...(form.ownerId && form.ownerId !== auth.user?.id ? { ownerId: form.ownerId } : {}) })).content
      // A new content's translations are saved right below; if one of them fails, saving again updates this content.
      editing.value = saved
    }
    const id = saved.id
    for (const f of toSave) {
      const b = trBody(f)
      if (trOrig.value[f.lang] !== stable(b)) {
        await api('PUT', `/api/contents/${id}/translations/${f.lang}`, b)
        trOrig.value = { ...trOrig.value, [f.lang]: stable(b) }
      }
    }
    message.success(t('common.saved'))
    editorOpen.value = false
    void load()
    return saved
  } catch (e) { message.error(errorText(e)); return null } finally { saving.value = false }
}
/** 排程发布 / 立即发布 in the editor: save as ready (closes the editor), then the publishing step for that content. */
/**
 * 立即发布 / 排程发布 straight from the editor (owner 2026-11-19 「点立即发布直接创建发布任务；点排程就配置下时间；不要再多一个弹窗」):
 * save, then distribute to the content's 发布目标 (minus accounts it is already published on) with the post type of the
 * phone preview (帖子 / Reels / 限动); 排程 only picks the time in a small popover on the button. API refusals (media,
 * banned words, platform rules…) come back as messages; the content stays saved.
 */
const schedOpen = ref(false)
const schedAt = ref<Dayjs | null>(null)
const pastDay = (d: Dayjs) => d.isBefore(dayjs(), 'day')
function openSchedule(v: boolean) { if (v && !schedAt.value) schedAt.value = dayjs().add(1, 'hour').startOf('hour'); schedOpen.value = v }
async function saveAndPublish(at: Dayjs | null) {
  if (!form.targets.length) { message.warning(t('content.publishNoTargets')); return }
  if (at && !at.isAfter(dayjs())) { message.warning(t('distribute.pickTime')); return }
  // A locked (published) content is not saved: the remaining targets get it as it is.
  const c = locked.value ? editing.value : await save('ready')
  if (!c) return
  const ids = remainingTargets.value
  if (!ids.length) { message.info(t('content.publishAllDone')); return }
  saving.value = true
  try {
    const r = await api<{ created: PublishTaskItem[]; existing: PublishTaskItem[] }>('POST', `/api/contents/${c.id}/distribute`, {
      targets: ids.map((accountId) => ({ accountId, scheduledAt: at ? at.toISOString() : null, ...(previewType.value !== 'feed' ? { postType: previewType.value } : {}) })),
    })
    schedOpen.value = false
    if (r.created.length) message.success(t('distribute.created', { n: r.created.length }))
    if (r.existing.length) message.info(t('distribute.existing', { n: r.existing.length }))
    editorOpen.value = false
    void load()
  } catch (e) { message.error(errorText(e)) } finally { saving.value = false }
}
// ---------------------------------------------------------------- actions

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

// ---------------------------------------------------------------- batch (批量操作, POST /api/contents/batch)
type BatchAction = 'delete' | 'archive' | 'unarchive' | 'cancel-publish' | 'set-category'
interface BatchResult { ok: string[]; skipped: { id: string; code: string; params?: ErrorParams }[]; changed: number; cancelledTasks?: number }
const selectedKeys = ref<string[]>([])
const batchCategory = ref<string | undefined>()
const batchCategoryOptions = computed(() => [{ value: 'none', label: t('content.batch.clearCategory') }, ...categoryGroups(publicCats.value, personalCats.value)])
/** Only the actions that make sense in the current tab. */
const batchShows = computed(() => ({
  publish: tab.value !== 'archived',
  archive: tab.value !== 'archived',
  unarchive: tab.value === 'all' || tab.value === 'archived',
  cancel: tab.value === 'all' || tab.value === 'pending' || tab.value === 'published',
}))
function batch(action: BatchAction) {
  const ids = [...selectedKeys.value]
  if (!ids.length) return
  const titles = new Map(items.value.map((i) => [i.id, i.title]))
  const run = async () => {
    try {
      const body: Record<string, unknown> = { ids, action }
      if (action === 'set-category') body.categoryId = batchCategory.value === 'none' ? null : batchCategory.value
      const r = await api<BatchResult>('POST', '/api/contents/batch', body)
      const done = action === 'cancel-publish' ? t('content.batch.doneCancel', { tasks: r.cancelledTasks ?? 0, n: r.ok.length }) : t('content.batch.done', { n: r.ok.length })
      if (r.skipped.length) {
        Modal.warning({
          title: t('content.batch.skippedTitle', { ok: r.ok.length, skipped: r.skipped.length }),
          content: h('div', [
            h('p', done),
            h('ul', { style: 'padding-inline-start: 18px; margin: 0; max-height: 240px; overflow: auto' },
              r.skipped.map((x) => h('li', `${titles.get(x.id) ?? x.id}: ${codeText(x.code, x.params, x.code)}`))),
          ]),
        })
      } else message.success(done)
      selectedKeys.value = []
      void load(); void loadCategories()
    } catch (e) { message.error(errorText(e)) }
  }
  const n = ids.length
  if (action === 'delete') confirmDanger({ title: t('content.batch.confirmDelete', { n }), content: t('content.batch.deleteHint'), onOk: run })
  else if (action === 'cancel-publish') confirmDanger({ title: t('content.batch.confirmCancel', { n }), content: t('content.batch.cancelHint'), okText: t('content.batch.cancelPublish'), onOk: run })
  else if (action === 'archive') confirmAction({ title: t('content.batch.confirmArchive', { n }), content: t('content.batch.archiveHint'), onOk: run })
  else return run()
}
/** 批量操作 menu; 设置分类 first asks for the category in a small dialog. */
type BatchFormAction = 'set-category'
const batchForm = ref<BatchFormAction | null>(null)
const batchFormBusy = ref(false)
const batchFormReady = computed(() => !!batchCategory.value)
const batchItems = computed<BatchItem[]>(() => [
  ...(batchShows.value.publish ? [{ key: 'publish', label: t('content.batch.publish') }] : []),
  { key: 'set-category', label: t('content.batch.setCategory') },
  ...(batchShows.value.archive ? [{ key: 'archive', label: t('content.batch.archive') }] : []),
  ...(batchShows.value.unarchive ? [{ key: 'unarchive', label: t('content.batch.unarchive') }] : []),
  ...(batchShows.value.cancel ? [{ key: 'cancel-publish', label: t('content.batch.cancelPublish'), danger: true }] : []),
  { key: 'delete', label: t('common.delete'), danger: true },
])
/** 批量发布: its own dialog (time, post type, dry-run summary), see BatchPublishModal. */
const batchPublishOpen = ref(false)
const batchPublishIds = ref<string[]>([])
const batchTitles = computed(() => new Map(items.value.map((i) => [i.id, i.title])))
function onBatchPublished() { selectedKeys.value = []; void load() }
function onBatch(key: string) {
  if (key === 'publish') { batchPublishIds.value = [...selectedKeys.value]; batchPublishOpen.value = true; return }
  if (key === 'set-category') {
    batchCategory.value = undefined
    batchForm.value = key
  } else void batch(key as BatchAction)
}
async function submitBatchForm() {
  if (!batchForm.value || !batchFormReady.value) return
  batchFormBusy.value = true
  try { await batch(batchForm.value); batchForm.value = null }
  finally { batchFormBusy.value = false }
}
</script>

<template>
  <PageContainer :title="t('content.title')">
    <template #extra>
      <a-button @click="categoryManagerOpen = true">{{ t('content.categories.manage') }}</a-button>
      <a-button type="primary" @click="openNew"><template #icon><PlusOutlined /></template>{{ t('content.add') }}</a-button>
    </template>

    <a-card :bordered="false">
      <SearchBar :loading="loading" @reset="reset" @refresh="load">
        <a-input-search v-model:value="filters.q" :placeholder="t('content.searchPlaceholder')" allow-clear style="width: 240px" @search="search" />
        <a-select v-model:value="filters.categoryId" :placeholder="t('content.colCategory')" allow-clear show-search option-filter-prop="label" style="width: 160px"
          :options="filterCategoryOptions" @change="search" />
        <a-select v-model:value="filters.lang" :placeholder="t('content.lang.filter')" allow-clear style="width: 140px" :options="langOptions" @change="search" />
        <a-tag v-if="filters.tag" closable @close="setTagFilter(undefined)">#{{ filters.tag }}</a-tag>
        <a-select v-if="auth.isAdmin" v-model:value="filters.ownerId" :placeholder="t('content.colAuthor')" allow-clear show-search option-filter-prop="label" style="width: 140px"
          :options="users.map((u) => ({ value: u.id, label: u.username }))" @change="filters.categoryId = undefined; search(); loadCategories()" />
        <template #actions>
          <BatchActions :count="selectedKeys.length" :items="batchItems" @select="onBatch" @clear="selectedKeys = []" />
        </template>
      </SearchBar>

      <BatchFormModal :open="!!batchForm" :title="t('content.batch.setCategory')" :note="t('content.selected', { n: selectedKeys.length })"
        :ready="batchFormReady" :busy="batchFormBusy" @ok="submitBatchForm" @update:open="(v: boolean) => { if (!v) batchForm = null }">
        <a-select v-model:value="batchCategory" :placeholder="t('content.batch.category')" show-search option-filter-prop="label"
          style="width: 100%" :options="batchCategoryOptions" />
      </BatchFormModal>

      <a-tabs :active-key="tab" size="small" class="status-tabs" @change="(k: string | number) => setTab(k as Tab)">
        <a-tab-pane v-for="k in TAB_KEYS" :key="k">
          <template #tab>{{ t(`content.tabs.${k}`) }} <span class="tab-count">{{ tabCount(k) }}</span></template>
        </a-tab-pane>
      </a-tabs>
      <a-tag v-if="onlyStatus.length" closable class="only-tag" @close="setTab(tab)">{{ t('content.onlyStatus', { status: onlyStatus.map(statusText).join(' / ') }) }}</a-tag>

      <a-table :data-source="items" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :scroll="{ x: scrollX }"
        :row-selection="{ selectedRowKeys: selectedKeys, onChange: (k: any[]) => (selectedKeys = k as string[]) }"
        :pagination="pagination({ current: page.current, pageSize: page.pageSize, total })" @change="onTableChange">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'title'">
            <a class="title-link ellipsis" :title="record.title" @click="openEdit(record)">{{ record.title }}</a>
            <div v-if="record.category || record.lang || record.translations.length" class="meta">
              <a-tag v-if="record.category" color="blue" class="chip">{{ record.category.name }}</a-tag>
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
              <a-tooltip v-if="record.locked" :title="t('content.lockedTag')"><LockOutlined class="lock-icon" /></a-tooltip>
            </div>
          </template>
          <template v-else-if="column.key === 'publishAt'">
            <template v-if="publishAt(record)">
              <a-tooltip :title="fmtDateTime(publishAt(record)!.at)"><div class="nowrap">{{ shortFmt(publishAt(record)!.at) }}</div></a-tooltip>
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
            <a-tooltip :title="fmtDateTime(record.updatedAt)"><span class="muted nowrap">{{ shortFmt(record.updatedAt) }}</span></a-tooltip>
          </template>
          <template v-else-if="column.key === 'ops'">
            <a-space :size="0">
              <a-button type="link" size="small" @click="openEdit(record)">{{ record.locked ? t('common.view') : t('common.edit') }}</a-button>
              <a-button v-if="record.stage === 'archived'" type="link" size="small" @click="setArchived(record, false)">{{ t('content.unarchive') }}</a-button>
              <a-tooltip v-else :title="hasUnfinished(record) ? t('content.archiveBlocked') : undefined">
                <a-button type="link" size="small" :disabled="hasUnfinished(record)" @click="setArchived(record, true)">{{ t('content.archive') }}</a-button>
              </a-tooltip>
              <a-button type="link" size="small" danger @click="remove(record)">{{ t('common.delete') }}</a-button>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-card>
  </PageContainer>

  <a-drawer v-model:open="editorOpen" :title="editing ? t(locked ? 'content.viewContent' : 'content.edit') : t('content.add')" :width="DRAWER_WIDTH.lg + 360" destroy-on-close>
    <a-alert v-if="locked" type="info" show-icon class="ai-notice" :message="t('content.lockedNotice')" :description="t('content.lockedHint')" />
    <a-alert v-if="editing?.aiGenerated && !locked" type="warning" show-icon class="ai-notice" :message="t('content.aiDraftNotice')">
      <template #description>
        {{ aiInfo(editing) }}<template v-if="editing.aiGenerated.mediaTags.length"> · {{ t('content.aiDraftMediaTags', { tags: editing.aiGenerated.mediaTags.join(', ') }) }}</template>
        <div v-if="editing.aiGenerated.needsTranslation?.length">
          <a-tag color="orange">{{ t('content.aiNeedsTranslation') }}</a-tag>
          <span class="small">{{ t('content.aiNeedsTranslationHint', { langs: editing.aiGenerated.needsTranslation.map(langName).join('、') }) }}</span>
        </div>
      </template>
    </a-alert>
    <a-row :gutter="24">
    <a-col :xs="24" :lg="15">
    <a-alert v-if="sourceLang && sourceLang !== SOURCE_LANG" type="info" show-icon class="lang-missing" :message="t('content.lang.legacySource', { lang: langName(sourceLang) })" />
    <a-tabs v-model:active-key="langTab" type="editable-card" size="small" hide-add class="lang-tabs" @edit="onLangTabEdit">
      <a-tab-pane :key="SRC" :closable="false">
        <template #tab>{{ sourceLang ? langName(sourceLang) : t('content.lang.source') }}<a-tag v-if="sourceLang" class="src-tag">{{ t('content.lang.source') }}</a-tag></template>
      </a-tab-pane>
      <a-tab-pane v-for="f in trs" :key="f.lang" :closable="trClosable(f)">
        <template #tab>
          <a-tooltip :title="langAccounts(f.lang).length ? t('content.lang.usedBy', { accounts: langAccounts(f.lang).join('、') }) : undefined">
            <span>{{ langName(f.lang) }}<a-tag :color="trFilled(f) ? 'success' : 'warning'" class="src-tag">{{ trFilled(f) ? t('content.lang.filled') : t('content.lang.missingOne') }}</a-tag></span>
          </a-tooltip>
        </template>
      </a-tab-pane>
    </a-tabs>
    <div v-if="trs.some((f) => !trFilled(f))" class="muted small lang-hint">{{ t('content.lang.missingHint') }}</div>

    <a-form v-if="currentTr" :key="currentTr.lang" layout="vertical" :disabled="locked">
      <a-form-item :label="t('content.fieldTitle')" required>
        <a-input v-model:value="currentTr.title" :maxlength="200" show-count :placeholder="form.title" />
      </a-form-item>
      <a-form-item :label="t('content.caption')">
        <PlatformTextTabs v-model:active="textTab" :tabs="trTabs" :values="currentTr.texts">
          <template #extra><TemplateInsert :persona-ids="editorPersonas" @insert="insertTemplate" /></template>
          <template #default="{ tab }">
            <a-form-item v-if="tab.key === 'youtube'" :label="t('content.ytTitle')" class="tab-field">
              <a-input v-model:value="currentTr.hints.youtube!.title" :maxlength="100" show-count :placeholder="form.hints.youtube?.title || currentTr.title || form.title" />
            </a-form-item>
          </template>
        </PlatformTextTabs>
      </a-form-item>
    </a-form>

    <a-form v-show="!currentTr" layout="vertical" :disabled="locked">
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
          <template #extra><TemplateInsert :persona-ids="editorPersonas" @insert="insertTemplate" /></template>
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
        <a-col :xs="24" :sm="12">
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
      </a-row>
      <a-form-item :label="t('content.fieldMedia', { n: form.media.length })">
        <MediaStrip :media="form.media" :size="88" :editable="!locked" @move="moveMedia" @remove="(i: number) => form.media.splice(i, 1)" />
        <a-space style="margin-top: 8px" wrap>
          <a-button :disabled="locked || form.media.length >= MAX_MEDIA" @click="pickerOpen = true"><template #icon><PlusOutlined /></template>{{ t('content.addMedia') }}</a-button>
          <ContentMediaUpload :disabled="locked || form.media.length >= MAX_MEDIA" :blocked="uploadBlocked" :owner-id="uploadOwner" :owner-name="uploadOwnerName" @uploaded="onUploaded" />
        </a-space>
        <div v-if="uploadBlocked || uploadOwner" class="muted small media-hint">{{ uploadBlocked || t('content.uploadOwnerHint', { user: uploadOwnerName || '?' }) }}</div>
        <div v-if="processingMedia.length" class="muted small media-hint">{{ t('content.mediaProcessingHint', { n: processingMedia.length }) }}</div>
      </a-form-item>
    </a-form>

    <template v-if="editing && editorTasks.length && !currentTr">
      <a-divider orientation="left" plain>{{ t('content.tasksOf') }}</a-divider>
      <div class="pt-groups">
        <div v-for="item in editorTaskGroups" :key="item.id" class="pt-group">
          <div class="pt-head">
            <div class="pt-who">
              <PlatformTag :platform="item.platform" />
              <PostTypeTag :type="item.postType" />
              <span class="pt-handle">@{{ item.account?.handle ?? '—' }}</span>
              <StatusTag kind="publish" :status="item.status" />
              <span class="muted small pt-time">{{ fmtDateTime(item.status === 'published' && item.publishedAt ? item.publishedAt : item.scheduledAt) }}</span>
            </div>
            <div class="pt-actions">
              <a v-if="item.url" :href="item.url" target="_blank" rel="noopener noreferrer">{{ t('publish.viewPost') }}</a>
              <a @click="openPublishTask(item.id)">{{ t('common.view') }}</a>
            </div>
          </div>
          <a-typography-text v-if="item.errorCode" type="danger" class="small pt-err">{{ codeText(item.errorCode, undefined, item.error ?? item.errorCode) }}</a-typography-text>
          <PublishAttemptRows v-if="item.older.length" class="pt-older" :attempts="item.older" @open="openPublishTask" @more="openPublishTask(item.id)" />
        </div>
      </div>
    </template>
    </a-col>
    <a-col :xs="24" :lg="9">
      <PersonaCard v-for="pid in editorPersonas" :key="pid" :persona-id="pid" kind="post" :text="personaText" />
      <div class="preview-col"><PhonePreview v-model:mode="previewType" :media="form.media" :text="previewText" :handle="firstTarget?.handle ?? null" /></div>
    </a-col>
    </a-row>

    <template #footer>
      <a-button @click="editorOpen = false">{{ locked ? t('content.close') : t('common.cancel') }}</a-button>
      <a-button v-if="editing?.stage === 'archived' && !locked" type="primary" :loading="saving" @click="save('ready')">{{ t('common.save') }}</a-button>
      <!-- locked (published): no save; 立即发布 / 排程发布 only while some target is not published yet (sent unsaved) -->
      <template v-else-if="editing?.stage !== 'archived' && (!locked || remainingTargets.length)">
        <a-button v-if="!locked" :loading="saving" @click="save('draft')">{{ t('content.saveDraft') }}</a-button>
        <a-popover :open="schedOpen" trigger="click" placement="topRight" @open-change="openSchedule">
          <template #content>
            <a-space>
              <a-date-picker v-model:value="schedAt" show-time format="YYYY-MM-DD HH:mm" :disabled-date="pastDay" :allow-clear="false" />
              <a-button type="primary" :loading="saving" @click="saveAndPublish(schedAt)">{{ t('common.ok') }}</a-button>
            </a-space>
          </template>
          <a-button :loading="saving">{{ t('content.publishLater') }}</a-button>
        </a-popover>
        <a-button type="primary" :loading="saving" @click="saveAndPublish(null)">{{ t('content.publishNow') }}</a-button>
      </template>
    </template>
  </a-drawer>

  <MediaPicker v-model:open="pickerOpen" :exclude="form.media.map((m) => m.id)" @pick="onPick" />
  <BatchPublishModal v-model:open="batchPublishOpen" :ids="batchPublishIds" :titles="batchTitles" @done="onBatchPublished" />
  <ScopedListManager v-model:open="categoryManagerOpen" path="/api/content-categories" list-key="categories" texts="content.categories" @changed="categoriesChanged" />
</template>


<style scoped>
.pt-groups { display: flex; flex-direction: column; }
.pt-group { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; border-bottom: 1px solid var(--cp-border-secondary); }
.pt-group:first-child { padding-top: 0; }
.pt-group:last-child { border-bottom: none; }
.pt-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.pt-who { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; min-width: 0; flex: 1; }
.pt-who :deep(.ant-tag) { margin: 0; }
.pt-handle { font-weight: 500; word-break: break-all; }
.pt-time { white-space: nowrap; font-variant-numeric: tabular-nums; }
.pt-actions { display: flex; gap: 16px; white-space: nowrap; line-height: 22px; }
.pt-older { margin-left: 4px; }
.ai-notice { margin-bottom: 16px; }
.lock-icon { color: var(--cp-text-secondary); }
.title-link { display: block; font-weight: 500; }
.meta { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.meta .chip { margin: 0; font-size: 11px; line-height: 18px; padding-inline: 5px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta .chip.lang { color: var(--cp-text-secondary); }
.status-cell { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.status-cell :deep(.ant-tag) { margin: 0; }
.author { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0; }
.author .avatar { background: var(--cp-primary); flex: none; font-size: 11px; }
.src-tag { margin-inline-start: 6px; margin-inline-end: 0; font-size: 11px; line-height: 16px; padding-inline: 4px; }
.lang-tabs { margin-bottom: 12px; }
.lang-missing { margin-bottom: 8px; }
.lang-hint { margin: -4px 0 8px; }
.tab-field { margin-top: 16px; margin-bottom: 0; }
.preview-col { position: sticky; top: 0; padding-bottom: 16px; }
.new-category { display: flex; gap: 4px; padding: 4px 8px; }
.media-hint { margin-top: 4px; }
.status-tabs { margin-bottom: 4px; }
.tab-count { color: var(--cp-text-secondary); font-variant-numeric: tabular-nums; margin-inline-start: 2px; }
.only-tag { margin-bottom: var(--cp-gap); }
</style>
