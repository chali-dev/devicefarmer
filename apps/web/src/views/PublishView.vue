<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { LeftOutlined, RightOutlined } from '@ant-design/icons-vue'
import dayjs, { type Dayjs } from 'dayjs'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { queryParam } from '../api/query'
import { api, codeText, errorText } from '../api/client'
import {
  POST_TYPES, type CommentReplyItem, type CommentReplyStatus, type ManagedUser, type PostType, type PublishPlatform, type PublishStatus, type PublishTaskItem,
  type SocialAccount,
} from '../api/types'
import CommentDrawer from '../components/comments/CommentDrawer.vue'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import StatusTag from '../components/common/StatusTag.vue'
import SocialAccountFeedDrawer from '../components/feed/SocialAccountFeedDrawer.vue'
import { replyKind, replyParked, replyTime } from '../components/feed/replyKind'
import CommentSendTable from '../components/publish/CommentSendTable.vue'
import PostTypeTag from '../components/publish/PostTypeTag.vue'
import PublishTaskDrawer from '../components/publish/PublishTaskDrawer.vue'
import PublishTaskTable from '../components/publish/PublishTaskTable.vue'
import PlatformTag from '../components/social/PlatformTag.vue'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

/**
 * 排程发布 (publish scheduler): week calendar (drag a card to another day), today (今日发布), pending queue, history.
 * One filter model for every tab (search, platform, type, account, owner, status, date range); a task's day is
 * when it was published, else when it is due (same rule as the API's from/to). Scheduled comment sends (回复 /
 * 评论 after 排程, GET /api/comment-replies; never drafts) are shown next to the publish tasks: type 评论 in the
 * filter, their own cards in the calendar (draggable while scheduled = POST …/reschedule), their own table below
 * the publish tasks, and in the counts. Their status filter maps from the publish statuses (REPLY_OF).
 */
const { t } = useI18n()
const auth = useAuthStore()
const store = useInstancesStore()
const route = useRoute()
const router = useRouter()

type Tab = 'calendar' | 'today' | 'queue' | 'history'
const TABS: Tab[] = ['calendar', 'today', 'queue', 'history']
const tab = computed<Tab>({
  get: () => (TABS.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'calendar'),
  set: (v) => { void router.replace({ query: { ...route.query, tab: v } }) },
})
const QUEUE: PublishStatus[] = ['pending', 'scheduled', 'running', 'awaiting_operator']
/** dry_run (former test mode) is no longer produced; db:migrate turned old rows into cancelled. */
const HISTORY: PublishStatus[] = ['published', 'failed', 'cancelled']
const ALL: PublishStatus[] = [...QUEUE, ...HISTORY]
/** Today = every task of the day except cancelled ones (same as the dashboard card). */
const statusesOf = (k: Tab) => (k === 'queue' ? QUEUE : k === 'history' ? HISTORY : k === 'today' ? ALL.filter((s) => s !== 'cancelled') : ALL)
/** The comment sends shown for a publish status (drafts and the legacy review states never). */
const REPLY_OF: Partial<Record<PublishStatus, CommentReplyStatus[]>> = {
  scheduled: ['scheduled'], running: ['sending'], awaiting_operator: ['awaiting_operator'], published: ['sent'], failed: ['failed'], cancelled: ['cancelled'],
}
const replyStatusesOf = (xs: PublishStatus[]) => [...new Set(xs.flatMap((s) => REPLY_OF[s] ?? []))]

/** Type filter: the post types, plus 评论 = comment sends. */
type PlanType = PostType | 'comment'
const platforms = ref<PublishPlatform[]>([])
const users = ref<ManagedUser[]>([])
const accounts = ref<SocialAccount[]>([])
const filters = reactive({
  q: '', platform: undefined as string | undefined, ownerId: undefined as string | undefined, accountId: undefined as string | undefined,
  status: queryParam<PublishStatus>(route.query, 'status'), postType: queryParam<PlanType>(route.query, 'postType', [...POST_TYPES, 'comment']),
  range: null as [Dayjs, Dayjs] | null,
})
const contentId = computed(() => (typeof route.query.contentId === 'string' ? route.query.contentId : undefined))
const statusText = (s: string) => t(`publish.status.${s}`)
const typeText = (x: PlanType) => (x === 'comment' ? t('publish.typeComments') : t(`publish.type.${x}`))
const when = (x: PublishTaskItem) => dayjs(x.publishedAt ?? x.scheduledAt)
/** Post types of the enabled platforms (the filter only offers those). */
const postTypes = computed(() => POST_TYPES.filter((x) => platforms.value.some((p) => p.postTypes.includes(x))))
const typeOptions = computed<PlanType[]>(() => [...postTypes.value, 'comment'])
/** Which of the two kinds the type filter shows; a content filter (from 内容管理) shows its publish tasks only. */
const showPosts = computed(() => filters.postType !== 'comment')
const showReplies = computed(() => (!filters.postType || filters.postType === 'comment') && !contentId.value)

function baseParams(): URLSearchParams {
  // One entry per content + account (its newest task; older attempts folded under it), also in the calendar.
  const p = new URLSearchParams({ group: 'content' })
  if (filters.q.trim()) p.set('q', filters.q.trim())
  if (filters.platform) p.set('platform', filters.platform)
  if (filters.ownerId) p.set('ownerId', filters.ownerId)
  if (filters.accountId) p.set('accountId', filters.accountId)
  if (filters.postType && filters.postType !== 'comment') p.set('postType', filters.postType)
  if (contentId.value) p.set('contentId', contentId.value)
  return p
}
/** The same filters for GET /api/comment-replies (status = the comment statuses of `statuses`). */
function replyParams(statuses: CommentReplyStatus[]): URLSearchParams {
  const p = new URLSearchParams({ status: statuses.join(',') })
  if (filters.q.trim()) p.set('q', filters.q.trim())
  if (filters.platform) p.set('platform', filters.platform)
  if (filters.ownerId) p.set('ownerId', filters.ownerId)
  if (filters.accountId) p.set('accountId', filters.accountId)
  return p
}
const setRange = (p: URLSearchParams, from: Dayjs, to: Dayjs) => { p.set('from', from.toISOString()); p.set('to', to.toISOString()) }
type ReplyList = { items: CommentReplyItem[]; total: number; byStatus: Partial<Record<CommentReplyStatus, number>> }
const NO_REPLIES: ReplyList = { items: [], total: 0, byStatus: {} }

// ---------------------------------------------------------------- calendar
// One week at a time (the owner wants the schedule by week, not by month).
const cursor = ref<Dayjs>(dayjs())
const calItems = ref<PublishTaskItem[]>([])
const calReplies = ref<CommentReplyItem[]>([])
const calLoading = ref(false)
const range = computed(() => ({ from: cursor.value.startOf('week'), to: cursor.value.startOf('week').add(1, 'week') }))
const weekDays = computed(() => Array.from({ length: 7 }, (_, i) => range.value.from.add(i, 'day')))
async function loadCalendar() {
  calLoading.value = true
  try {
    const p = baseParams()
    setRange(p, range.value.from, range.value.to); p.set('sort', 'scheduled_asc'); p.set('limit', '500')
    if (filters.status) p.set('status', filters.status)
    const rs = replyStatusesOf(filters.status ? [filters.status] : ALL)
    const rp = replyParams(rs)
    setRange(rp, range.value.from, range.value.to); rp.set('sort', 'time_asc'); rp.set('limit', '500')
    const [posts, replies] = await Promise.all([
      showPosts.value ? api<{ items: PublishTaskItem[] }>('GET', `/api/publish/tasks?${p}`) : { items: [] },
      showReplies.value && rs.length ? api<ReplyList>('GET', `/api/comment-replies?${rp}`) : NO_REPLIES,
    ])
    calItems.value = posts.items; calReplies.value = replies.items
  } catch (e) { message.error(errorText(e)) } finally { calLoading.value = false }
}
/** A calendar card: a publish task or a comment send. */
interface CalEntry { key: string; at: Dayjs; post?: PublishTaskItem; reply?: CommentReplyItem }
const calEntries = computed<CalEntry[]>(() => [
  ...calItems.value.map((x) => ({ key: `p:${x.id}`, at: when(x), post: x })),
  ...calReplies.value.map((r) => ({ key: `r:${r.id}`, at: dayjs(replyTime(r)), reply: r })),
])
const dayItems = (d: Dayjs) => calEntries.value.filter((e) => e.at.isSame(d, 'day')).sort((a, b) => a.at.valueOf() - b.at.valueOf())
function shift(n: number) { cursor.value = cursor.value.add(n, 'week') }
watch(cursor, () => { if (tab.value === 'calendar') void loadCalendar() })

// Drag a card to another day = reschedule to that day at the same local time (the viewer's tz, like the
// calendar itself). Only waiting tasks (the API's reschedule rule) the viewer owns (admins: all) can be
// dragged; comment sends only while scheduled with a send task (not sending, not parked on a halted phone).
// Days before today never accept a drop; today only while the card's time is still ahead (the API would
// publish a past time at once). Keyboard/touch users reschedule in the drawer (cards still open it).
const now = ref(dayjs())
const nowTimer = setInterval(() => { now.value = dayjs() }, 30_000)
const isPast = (d: Dayjs) => d.isBefore(now.value, 'day')
const mine = (userId: string) => auth.isAdmin || userId === auth.user?.id
function canDrag(e: CalEntry) {
  if (moving.has(e.key)) return false
  if (e.post) return (e.post.status === 'pending' || e.post.status === 'scheduled') && mine(e.post.userId)
  return !!e.reply && e.reply.status === 'scheduled' && !!e.reply.taskId && mine(e.reply.userId)
}
const dragging = ref<CalEntry | null>(null)
const overDay = ref<number | null>(null)
const moving = reactive(new Set<string>())
/** The card's time of day moved onto day d. */
const atDay = (e: CalEntry, d: Dayjs) => d.hour(e.at.hour()).minute(e.at.minute()).second(e.at.second()).millisecond(0)
type DropState = 'same' | 'ok' | 'past' | 'elapsed'
function dropState(d: Dayjs): DropState | null {
  const x = dragging.value
  if (!x) return null
  if (x.at.isSame(d, 'day')) return 'same'
  if (isPast(d)) return 'past'
  return atDay(x, d).isAfter(dayjs()) ? 'ok' : 'elapsed'
}
function onDragStart(ev: DragEvent, e: CalEntry) {
  if (!canDrag(e) || !ev.dataTransfer) { ev.preventDefault(); return }
  ev.dataTransfer.effectAllowed = 'move'
  ev.dataTransfer.setData('text/plain', e.key) // Firefox needs data to start a drag
  now.value = dayjs()
  dragging.value = e
}
function onDragEnd() { dragging.value = null; overDay.value = null }
function onDragOver(e: DragEvent, d: Dayjs) {
  const st = dropState(d)
  if (!st) return
  overDay.value = d.valueOf()
  if (st === 'ok' || st === 'same') { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move' }
  else if (e.dataTransfer) e.dataTransfer.dropEffect = 'none' // no preventDefault: the browser shows "no drop"
}
function onDragLeave(e: DragEvent, d: Dayjs) {
  const to = e.relatedTarget as Node | null
  if (to && (e.currentTarget as HTMLElement).contains(to)) return
  if (overDay.value === d.valueOf()) overDay.value = null
}
async function onDrop(e: DragEvent, d: Dayjs) {
  e.preventDefault()
  const x = dragging.value
  const st = dropState(d)
  onDragEnd()
  if (!x || st === 'same') return
  if (st !== 'ok') { message.warning(t(st === 'past' ? 'publish.dropPast' : 'publish.dropElapsed')); return }
  const at = atDay(x, d)
  const row = (x.post ?? x.reply)!
  const before = row.scheduledAt
  row.scheduledAt = at.toISOString() // optimistic: the card shows on the new day while the request runs
  moving.add(x.key)
  try {
    await api('POST', x.post ? `/api/publish/tasks/${row.id}/reschedule` : `/api/comment-replies/${row.id}/reschedule`, { scheduledAt: at.toISOString() })
    message.success(t('publish.movedTo', { time: at.format('YYYY-MM-DD HH:mm') }))
  } catch (err) {
    row.scheduledAt = before // back to where it was
    message.error(errorText(err))
  } finally {
    moving.delete(x.key)
    void loadCalendar()
  }
}
function dayClass(d: Dayjs) {
  const st = dropState(d)
  return {
    today: d.isSame(now.value, 'day'), past: isPast(d),
    'drop-ok': st === 'ok', 'drop-no': st === 'past' || st === 'elapsed',
    'drop-over': overDay.value === d.valueOf() && st === 'ok',
  }
}

// ---------------------------------------------------------------- today / queue / history (tables)
const items = ref<PublishTaskItem[]>([])
const total = ref(0)
const byStatus = ref<Partial<Record<PublishStatus, number>>>({})
const byPostType = ref<Partial<Record<PostType, number>>>({})
const loading = ref(false)
const page = reactive({ current: 1, pageSize: 20 })
const replies = ref<CommentReplyItem[]>([])
const replyTotal = ref(0)
const replyByStatus = ref<Partial<Record<CommentReplyStatus, number>>>({})
const rLoading = ref(false)
const rPage = reactive({ current: 1, pageSize: 20 })
const today = ref(dayjs().startOf('day'))
const tabStatuses = () => {
  const statuses = statusesOf(tab.value)
  return filters.status && statuses.includes(filters.status) ? [filters.status] : statuses
}
function listRange(p: URLSearchParams) {
  if (tab.value === 'today') setRange(p, today.value, today.value.add(1, 'day'))
  else if (filters.range) setRange(p, filters.range[0].startOf('day'), filters.range[1].startOf('day').add(1, 'day'))
}
async function loadList() {
  loading.value = true
  try {
    if (tab.value === 'today') today.value = dayjs().startOf('day')
    const p = baseParams()
    p.set('status', tabStatuses().join(','))
    listRange(p)
    p.set('sort', tab.value === 'history' ? 'updated_desc' : 'scheduled_asc')
    p.set('limit', String(page.pageSize)); p.set('offset', String((page.current - 1) * page.pageSize))
    const [r] = await Promise.all([
      api<{ items: PublishTaskItem[]; total: number; byStatus: Record<PublishStatus, number>; byPostType: Record<PostType, number> }>('GET', `/api/publish/tasks?${p}`),
      loadReplies(),
    ])
    items.value = r.items; total.value = r.total; byStatus.value = r.byStatus; byPostType.value = r.byPostType
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
/**
 * Comment sends of the tab (also while the type filter shows posts only: the counts need them). A status filter
 * without a comment equivalent (待处理) lists none but still reads the counts.
 */
async function loadReplies() {
  if (contentId.value) { replies.value = []; replyTotal.value = 0; replyByStatus.value = {}; return }
  rLoading.value = true
  try {
    const own = replyStatusesOf(tabStatuses())
    const p = replyParams(own.length ? own : replyStatusesOf(statusesOf(tab.value)))
    listRange(p)
    p.set('sort', tab.value === 'history' ? 'updated_desc' : 'time_asc')
    p.set('limit', String(rPage.pageSize)); p.set('offset', String((rPage.current - 1) * rPage.pageSize))
    const r = await api<ReplyList>('GET', `/api/comment-replies?${p}`)
    replies.value = own.length ? r.items : []; replyTotal.value = own.length ? r.total : 0; replyByStatus.value = r.byStatus
  } catch (e) { message.error(errorText(e)) } finally { rLoading.value = false }
}
/** Status option counts: publish tasks and/or comment sends, as the type filter shows them. */
const countOf = (s: PublishStatus) => (showPosts.value ? byStatus.value[s] ?? 0 : 0)
  + (showReplies.value ? (REPLY_OF[s] ?? []).reduce((n, x) => n + (replyByStatus.value[x] ?? 0), 0) : 0)
/** Today: counts per type (byPostType ignores the type filter; the comment sends of the day except cancelled). */
const todayComments = computed(() => replyStatusesOf(statusesOf('today')).reduce((n, x) => n + (replyByStatus.value[x] ?? 0), 0))
const todayTotal = computed(() => postTypes.value.reduce((s, x) => s + (byPostType.value[x] ?? 0), 0) + todayComments.value)
function pickType(x: PlanType | undefined) { filters.postType = x; search() }

function load() { return tab.value === 'calendar' ? loadCalendar() : loadList() }
const search = () => { page.current = 1; rPage.current = 1; void load() }
function reset() {
  Object.assign(filters, { q: '', platform: undefined, ownerId: undefined, accountId: undefined, status: undefined, postType: undefined, range: null })
  if (contentId.value) void router.replace({ query: { ...route.query, contentId: undefined } })
  else search()
}
watch(tab, () => { filters.status = undefined; page.current = 1; rPage.current = 1; void load() })
watch(contentId, () => search())

function onTableChange(p: { current?: number; pageSize?: number }) { page.current = p.current ?? 1; page.pageSize = p.pageSize ?? page.pageSize; void loadList() }
function onReplyTableChange(p: { current?: number; pageSize?: number }) { rPage.current = p.current ?? 1; rPage.pageSize = p.pageSize ?? rPage.pageSize; void loadReplies() }

async function loadAccounts() {
  try {
    const q = new URLSearchParams({ pageSize: '200' })
    if (filters.ownerId) q.set('ownerId', filters.ownerId)
    accounts.value = (await api<{ items: SocialAccount[] }>('GET', `/api/social/accounts?${q}`)).items
  } catch { accounts.value = [] }
}
function onOwner() { filters.accountId = undefined; void loadAccounts(); search() }

// ---------------------------------------------------------------- drawers + live updates
const drawerOpen = ref(false)
const drawerId = ref<string | null>(null)
const drawer = ref<InstanceType<typeof PublishTaskDrawer>>()
function openTask(id: string) { drawerId.value = id; drawerOpen.value = true }
watch(() => route.query.task, (id) => { if (typeof id === 'string') openTask(id) }, { immediate: true })
watch(drawerOpen, (o) => { if (!o && route.query.task) void router.replace({ query: { ...route.query, task: undefined } }) })

// A comment send opens where it is handled already: a reply to a comment → the comment drawer (状态, 取消, 记录结果);
// a comment under a post / on a tracked account's post → the sending account's 回复记录. Both belong to 我的媒体.
const commentOpen = ref(false)
const commentId = ref<string | null>(null)
const feedOpen = ref(false)
const feedAccount = ref<CommentReplyItem['account']>(null)
function openReply(r: CommentReplyItem) {
  if (!auth.menuAllowed('social')) { message.info(codeText('rbac.menu_disabled', undefined, t('publish.replyNeedsSocial'))); return }
  if (r.commentId) { commentId.value = r.commentId; commentOpen.value = true }
  else if (r.account) { feedAccount.value = r.account; feedOpen.value = true }
}
function openEntry(e: CalEntry) { if (e.post) openTask(e.post.id); else if (e.reply) openReply(e.reply) }

let timer: ReturnType<typeof setTimeout> | null = null
const off = store.onTaskEvent((ev) => {
  if (ev.type !== 'task.updated' || (ev.task.type !== 'publish' && ev.task.type !== 'comment-reply')) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    void load()
    if (drawerOpen.value && ev.task.refId === drawerId.value) void drawer.value?.reload()
  }, 400)
})
onBeforeUnmount(() => { off(); if (timer) clearTimeout(timer); clearInterval(nowTimer) })

onMounted(async () => {
  void load()
  void loadAccounts()
  try {
    platforms.value = (await api<{ platforms: PublishPlatform[] }>('GET', '/api/publish/platforms')).platforms
    if (auth.isAdmin) users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users
  } catch (e) { message.error(errorText(e)) }
})
</script>

<template>
  <PageContainer :title="t('publish.title')">
    <a-card :bordered="false">
      <SearchBar :loading="tab === 'calendar' ? calLoading : loading" @reset="reset" @refresh="load">
        <a-input-search v-model:value="filters.q" :placeholder="t('publish.searchPlaceholder')" allow-clear style="width: 240px" @search="search" />
        <a-select v-model:value="filters.platform" :placeholder="t('publish.platform')" allow-clear style="width: 130px" @change="search">
          <a-select-option v-for="p in platforms" :key="p.id" :value="p.id"><PlatformTag :platform="p.id" :name="p.name" /></a-select-option>
        </a-select>
        <a-select v-model:value="filters.postType" :placeholder="t('publish.postType')" allow-clear style="width: 120px" @change="search">
          <a-select-option v-for="x in typeOptions" :key="x" :value="x">{{ typeText(x) }}</a-select-option>
        </a-select>
        <a-select v-model:value="filters.accountId" :placeholder="t('publish.colAccount')" allow-clear show-search option-filter-prop="label" style="width: 180px"
          :options="accounts.map((a) => ({ value: a.id, label: `@${a.handle}` }))" @change="search" />
        <a-select v-model:value="filters.status" :placeholder="t('common.status')" allow-clear style="width: 160px" @change="search">
          <a-select-option v-for="s in statusesOf(tab)" :key="s" :value="s">{{ statusText(s) }}<template v-if="tab !== 'calendar'"> ({{ countOf(s) }})</template></a-select-option>
        </a-select>
        <a-range-picker v-if="tab === 'queue' || tab === 'history'" v-model:value="filters.range" style="width: 240px" @change="search" />
        <a-select v-if="auth.isAdmin" v-model:value="filters.ownerId" :placeholder="t('content.colOwner')" allow-clear show-search option-filter-prop="label" style="width: 140px"
          :options="users.map((u) => ({ value: u.id, label: u.username }))" @change="onOwner" />
        <a-tag v-if="contentId" closable color="blue" @close="reset">{{ t('publish.filteredByContent') }}</a-tag>
      </SearchBar>

      <a-tabs v-model:active-key="tab">
        <a-tab-pane key="calendar" :tab="t('publish.tabs.calendar')">
          <a-space style="margin-bottom: 12px" wrap>
            <a-button-group>
              <a-button :aria-label="t('publish.prev')" @click="shift(-1)"><template #icon><LeftOutlined /></template></a-button>
              <a-button @click="cursor = dayjs()">{{ t('publish.today') }}</a-button>
              <a-button :aria-label="t('publish.next')" @click="shift(1)"><template #icon><RightOutlined /></template></a-button>
            </a-button-group>
            <span class="week-label">{{ `${weekDays[0]!.format('YYYY-MM-DD')} – ${weekDays[6]!.format('MM-DD')}` }}</span>
          </a-space>
          <a-spin :spinning="calLoading">
            <div class="week">
              <div v-for="d in weekDays" :key="d.valueOf()" class="day" :class="dayClass(d)"
                @dragover="onDragOver($event, d)" @dragleave="onDragLeave($event, d)" @drop="onDrop($event, d)">
                <div class="day-head">{{ d.format('ddd MM-DD') }} <span v-if="dayItems(d).length" class="muted small">· {{ dayItems(d).length }}</span></div>
                <div v-if="dropState(d) === 'elapsed'" class="drop-hint small">{{ t('publish.dropElapsedHint') }}</div>
                <div v-for="e in dayItems(d)" :key="e.key" class="ev" role="button" tabindex="0"
                  :class="{ draggable: canDrag(e), dragging: dragging?.key === e.key, moving: moving.has(e.key) }"
                  :draggable="canDrag(e) ? 'true' : undefined" :title="canDrag(e) ? t('publish.dragHint') : undefined"
                  @dragstart="onDragStart($event, e)" @dragend="onDragEnd" @click="openEntry(e)" @keydown.enter="openEntry(e)">
                  <template v-if="e.post">
                    <div class="ev-time">{{ e.at.format('HH:mm') }} <PlatformTag :platform="e.post.platform" icon-only /> <PostTypeTag :type="e.post.postType" /></div>
                    <div class="ellipsis">@{{ e.post.account?.handle }}</div>
                    <div class="ellipsis muted">{{ e.post.content?.title }}</div>
                    <StatusTag kind="publish" :status="e.post.status" />
                  </template>
                  <template v-else-if="e.reply">
                    <div class="ev-time">{{ e.at.format('HH:mm') }} <PlatformTag :platform="e.reply.platform" icon-only /> <a-tag color="cyan" class="kind">{{ t(`publish.sendType.${replyKind(e.reply)}`) }}</a-tag></div>
                    <div class="ellipsis">@{{ e.reply.account?.handle }}</div>
                    <div class="ellipsis muted">{{ e.reply.text }}</div>
                    <StatusTag kind="commentReply" :status="e.reply.status" />
                    <div v-if="replyParked(e.reply)" class="warn small">{{ codeText(e.reply.errorCode, undefined, e.reply.errorCode ?? '') }}</div>
                  </template>
                </div>
                <div v-if="!dayItems(d).length" class="faint empty">—</div>
              </div>
            </div>
          </a-spin>
        </a-tab-pane>
        <a-tab-pane v-for="k in (['today', 'queue', 'history'] as const)" :key="k" :tab="t(`publish.tabs.${k}`)">
          <div v-if="k === 'today'" class="today-bar">
            <span class="week-label">{{ t('publish.todayOf', { date: today.format('YYYY-MM-DD ddd') }) }}</span>
            <a-radio-group :value="filters.postType ?? ''" button-style="solid" size="small" @update:value="(v: string) => pickType((v || undefined) as PlanType | undefined)">
              <a-radio-button value="">{{ t('publish.allTypes') }} {{ todayTotal }}</a-radio-button>
              <a-radio-button v-for="x in postTypes" :key="x" :value="x">{{ typeText(x) }} {{ byPostType[x] ?? 0 }}</a-radio-button>
              <a-radio-button value="comment">{{ typeText('comment') }} {{ todayComments }}</a-radio-button>
            </a-radio-group>
          </div>
          <PublishTaskTable v-if="showPosts" :items="items" :total="total" :loading="loading" :current="page.current" :page-size="page.pageSize"
            :mode="k === 'queue' ? 'queue' : 'result'" :empty-text="k === 'today' ? t('publish.todayEmpty') : undefined" @change="onTableChange" @open="openTask" />
          <!-- comment sends: their own table (with posts shown only when there are any) -->
          <template v-if="showReplies && (!showPosts || replyTotal)">
            <div v-if="showPosts" class="section-title">{{ t('publish.commentSends') }} · {{ replyTotal }}</div>
            <CommentSendTable :items="replies" :total="replyTotal" :loading="rLoading" :current="rPage.current" :page-size="rPage.pageSize"
              @change="onReplyTableChange" @open="openReply" />
          </template>
        </a-tab-pane>
      </a-tabs>
    </a-card>
  </PageContainer>
  <PublishTaskDrawer ref="drawer" v-model:open="drawerOpen" :task-id="drawerId" @changed="load" />
  <CommentDrawer v-model:open="commentOpen" :comment-id="commentId" @changed="load" />
  <SocialAccountFeedDrawer v-model:open="feedOpen" :account="feedAccount" initial-tab="replies" />
</template>

<style scoped>
.week-label { font-weight: 600; }
.week { display: grid; grid-template-columns: repeat(7, minmax(120px, 1fr)); gap: 8px; overflow-x: auto; }
.day { border: 1px solid var(--cp-border-secondary); border-radius: var(--cp-radius); padding: 8px; min-height: 240px; min-width: 0; transition: background-color .15s, border-color .15s, opacity .15s; }
.day.today { border-color: var(--cp-primary); background: var(--cp-primary-bg); }
/* days before today: dimmed, never a drop target */
.day.past { background: var(--cp-bg-disabled); }
.day.past .day-head { color: var(--cp-text-tertiary); }
.day.past .ev { opacity: .75; }
/* while dragging: droppable days are outlined, the hovered one filled; refused days fade further */
.day.drop-ok { border-style: dashed; border-color: var(--cp-primary); }
.day.drop-over { background: var(--cp-primary-bg); box-shadow: inset 0 0 0 1px var(--cp-primary); }
.day.drop-no { opacity: .55; cursor: not-allowed; }
.drop-hint { color: var(--cp-text-tertiary); margin-bottom: 6px; }
.day-head { font-weight: 600; margin-bottom: 8px; }
.ev { border: 1px solid var(--cp-border-secondary); border-radius: var(--cp-radius); background: var(--cp-bg-container); padding: 4px 6px; margin-bottom: 6px; cursor: pointer; font-size: 12px; }
.ev:hover { border-color: var(--cp-primary); }
.ev.draggable { cursor: grab; }
.ev.draggable:active { cursor: grabbing; }
.ev.dragging { opacity: .4; }
.ev.moving { opacity: .6; cursor: progress; }
.ev-time { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.empty { text-align: center; }
.kind { margin-inline-end: 0; }
.warn { color: var(--cp-warning); }
.section-title { font-weight: 600; margin: 16px 0 8px; }
.today-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
</style>
