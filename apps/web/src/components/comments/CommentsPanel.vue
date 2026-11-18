<script setup lang="ts">
import { dateLocale } from '../../i18n'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { Dayjs } from 'dayjs'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { api, codeText, errorText } from '../../api/client'
import {
  type CommentAccount, type CommentItem, type ManagedUser, type CommentReplyItem, type CommentReplyStatus, type CommentStatus,
} from '../../api/types'
import CommentDrawer from './CommentDrawer.vue'
import FoldToggle from './FoldToggle.vue'
import EvidenceModal from '../feed/EvidenceModal.vue'
import FeedReplyModal from '../feed/FeedReplyModal.vue'
import ReplyScheduleModal from '../feed/ReplyScheduleModal.vue'
import SearchBar from '../common/SearchBar.vue'
import StatusTag from '../common/StatusTag.vue'
import { actionColumn, confirmDanger, MODAL_WIDTH, pagination, TABLE_SIZE } from '../common/ui'
import PlatformTag from '../social/PlatformTag.vue'
import { platformName } from '../social/platformMeta'
import { useAuthStore } from '../../stores/auth'
import { useInstancesStore } from '../../stores/instances'

/**
 * 媒体管理 → 回文日志 (formerly the 评论互动 page, merged 2026-11-18): every comment and reply of the viewer's accounts
 * (admins: all, or one user's). Three views (`?view=`): 收到的评论 (threads, manual entry, mark read / hide / ignore,
 * reply composer in the drawer), 待发送 (drafts with 编辑 / 排程 / 删除, scheduled, sending, waiting for the operator)
 * and 已处理 (sent / failed / cancelled), each with the account and status filters. No approval step (removed
 * 2026-11-18); the reply rules are edited on the 风控 page. Draft first: nothing is sent before 排程.
 * Header actions are teleported into `extraTo` (the page header).
 */
defineProps<{ extraTo?: string }>()
const { t } = useI18n()
const auth = useAuthStore()
const store = useInstancesStore()
const route = useRoute()
const router = useRouter()

type View = 'comments' | 'queue' | 'history'
const VIEWS: View[] = ['comments', 'queue', 'history']
/** `?view=` (the page's `?tab=` is the 媒体管理 tab); old /comments?tab=… links are redirected to it by the router. */
const tab = computed<View>({
  get: () => (VIEWS.includes(route.query.view as View) ? (route.query.view as View) : 'comments'),
  set: (v) => { void router.replace({ query: { ...route.query, view: v, status: undefined, replyStatus: undefined } }) },
})
/** `approved` / `pending_review` only on rows older than the removal of the approval step. */
const QUEUE: CommentReplyStatus[] = ['draft', 'pending_review', 'approved', 'scheduled', 'sending', 'awaiting_operator']
/** `dry_run` (former test mode) only on old rows of an old colour; db:migrate turned the rest into drafts. */
const HISTORY: CommentReplyStatus[] = ['sent', 'dry_run', 'failed', 'rejected', 'cancelled']
const STATUSES: CommentStatus[] = ['new', 'read', 'replied', 'hidden', 'ignored']
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
const errText = (code: string | null, raw: string | null, platform?: string) => (code ? codeText(code, { platform: platform ?? '' }, raw ?? code) : raw ?? '')

const accounts = ref<CommentAccount[]>([])
const users = ref<ManagedUser[]>([])
const posts = ref<{ postId: string; postUrl: string | null; n: number; title: string | null }[]>([])
const filters = reactive({
  accountId: (typeof route.query.account === 'string' ? route.query.account : undefined) as string | undefined,
  postId: undefined as string | undefined, status: (typeof route.query.status === 'string' ? route.query.status : undefined) as CommentStatus | undefined, source: undefined as 'api' | 'manual' | 'device' | undefined, q: '',
  /** 待发送 / 已处理: one reply status of the view (none = all of them). */
  replyStatus: (typeof route.query.replyStatus === 'string' ? route.query.replyStatus : undefined) as CommentReplyStatus | undefined,
  /** admins: one user's accounts */
  ownerId: undefined as string | undefined,
})
/** Reply statuses offered in the filter (legacy statuses only when rows have them). */
const replyStatuses = computed(() => (tab.value === 'queue' ? QUEUE : HISTORY).filter((s) => !['pending_review', 'approved', 'dry_run', 'rejected'].includes(s) || (rByStatus.value[s] ?? 0) > 0))
const account = computed(() => accounts.value.find((a) => a.id === filters.accountId) ?? null)

async function loadAccounts() {
  try { accounts.value = (await api<{ accounts: CommentAccount[] }>('GET', '/api/comments/accounts')).accounts } catch (e) { message.error(errorText(e)) }
}
async function loadPosts() {
  posts.value = []
  if (!filters.accountId) return
  try { posts.value = (await api<{ posts: typeof posts.value }>('GET', `/api/comments/posts?accountId=${filters.accountId}`)).posts } catch (e) { message.error(errorText(e)) }
}

// ---------------------------------------------------------------- comments
const items = ref<CommentItem[]>([])
const total = ref(0)
const byStatus = ref<Partial<Record<CommentStatus, number>>>({})
const loading = ref(false)
const page = reactive({ current: 1, pageSize: 20 })
async function loadComments() {
  loading.value = true
  try {
    const p = new URLSearchParams()
    if (filters.accountId) p.set('accountId', filters.accountId)
    if (filters.ownerId) p.set('ownerId', filters.ownerId)
    if (filters.postId) p.set('postId', filters.postId)
    if (filters.status) p.set('status', filters.status)
    if (filters.source) p.set('source', filters.source)
    if (filters.q.trim()) p.set('q', filters.q.trim())
    p.set('limit', String(page.pageSize)); p.set('offset', String((page.current - 1) * page.pageSize))
    const r = await api<{ items: CommentItem[]; total: number; byStatus: Record<CommentStatus, number> }>('GET', `/api/comments?${p}`)
    items.value = r.items; total.value = r.total; byStatus.value = r.byStatus
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}

// Replies are collapsed under their comment (V toggle). Expanded thread ids survive reloads (a status change on a
// reply reloads the list and must not collapse it); ids that left the list are dropped on each load.
const expanded = ref(new Set<string>())
function toggleThread(id: string) {
  const s = new Set(expanded.value)
  if (!s.delete(id)) s.add(id)
  expanded.value = s
}
watch(items, (list) => {
  const ids = new Set(list.map((c) => c.id))
  if ([...expanded.value].some((id) => !ids.has(id))) expanded.value = new Set([...expanded.value].filter((id) => ids.has(id)))
})
/** GET /api/comments loads the replies of the whole page with one query capped at 2000 rows and no per-thread
 *  total, so once the cap is reached a thread's count may be short: it is then shown as "N+". */
const CHILDREN_CAP = 2000
const childrenCapped = computed(() => items.value.reduce((n, c) => n + (c.children?.length ?? 0), 0) >= CHILDREN_CAP)
const ACTIVE_REPLY: CommentReplyStatus[] = ['draft', 'pending_review', 'approved', 'scheduled', 'sending', 'awaiting_operator']
/** Replies that need attention, flagged on the collapsed toggle so they aren't hidden: new ones and ones with a reply in progress. */
function threadInfo(c: CommentItem) {
  const kids = c.children ?? []
  return {
    n: childrenCapped.value ? `${kids.length}+` : String(kids.length),
    fresh: kids.filter((k) => k.status === 'new').length,
    pending: kids.filter((k) => k.reply && ACTIVE_REPLY.includes(k.reply.status)).length,
  }
}

async function setStatus(c: CommentItem, status: CommentStatus) {
  try { await api('PATCH', `/api/comments/${c.id}`, { status }); await loadComments() } catch (e) { message.error(errorText(e)) }
}
function remove(c: CommentItem) {
  confirmDanger({
    title: t('comments.deleteConfirm'),
    onOk: async () => { try { await api('DELETE', `/api/comments/${c.id}`); message.success(t('common.deleted')); await loadComments() } catch (e) { message.error(errorText(e)) } },
  })
}

// ---------------------------------------------------------------- manual entry
const manualOpen = ref(false)
const manual = reactive({ text: '', authorName: '', authorHandle: '', externalId: '', externalPostId: '', postUrl: '', at: null as Dayjs | null, parentId: undefined as string | undefined })
const manualBusy = ref(false)
function openManual(parent?: CommentItem) {
  Object.assign(manual, { text: '', authorName: '', authorHandle: '', externalId: '', externalPostId: parent?.externalPostId ?? filters.postId ?? '', postUrl: '', at: null, parentId: parent?.id })
  manualOpen.value = true
}
async function saveManual() {
  if (!filters.accountId || !manual.text.trim() || !manual.authorName.trim()) { message.warning(t('common.required')); return }
  manualBusy.value = true
  try {
    await api('POST', '/api/comments', {
      accountId: filters.accountId, text: manual.text, authorName: manual.authorName, authorHandle: manual.authorHandle || null,
      externalId: manual.externalId || null, externalPostId: manual.externalPostId || null, postUrl: manual.postUrl || null,
      publishedAt: manual.at ? manual.at.toISOString() : null, parentId: manual.parentId ?? null,
    })
    message.success(t('comments.created'))
    manualOpen.value = false
    await Promise.all([loadComments(), loadPosts(), loadAccounts()])
  } catch (e) { message.error(errorText(e)) } finally { manualBusy.value = false }
}
const parentItem = computed(() => items.value.find((x) => x.id === manual.parentId) ?? null)

// ---------------------------------------------------------------- replies (queue / history)
const replies = ref<CommentReplyItem[]>([])
const rTotal = ref(0)
const rByStatus = ref<Partial<Record<CommentReplyStatus, number>>>({})
const rLoading = ref(false)
const rPage = reactive({ current: 1, pageSize: 20 })
async function loadReplies() {
  rLoading.value = true
  try {
    const p = new URLSearchParams()
    if (filters.accountId) p.set('accountId', filters.accountId)
    if (filters.ownerId) p.set('ownerId', filters.ownerId)
    if (filters.q.trim()) p.set('q', filters.q.trim())
    const group = tab.value === 'queue' ? QUEUE : HISTORY
    p.set('status', (filters.replyStatus && group.includes(filters.replyStatus) ? [filters.replyStatus] : group).join(','))
    p.set('limit', String(rPage.pageSize)); p.set('offset', String((rPage.current - 1) * rPage.pageSize))
    const r = await api<{ items: CommentReplyItem[]; total: number; byStatus: Record<CommentReplyStatus, number> }>('GET', `/api/comment-replies?${p}`)
    replies.value = r.items; rTotal.value = r.total; rByStatus.value = r.byStatus
  } catch (e) { message.error(errorText(e)) } finally { rLoading.value = false }
}
const replyColumns = computed(() => [
  { title: t('comments.colAccount'), key: 'account', width: 180 },
  { title: t('comments.colComment'), key: 'comment', width: 280 },
  { title: t('comments.colReply'), key: 'reply', width: 280 },
  { title: t('comments.colStatus'), key: 'status', width: 150 },
  { title: t('comments.colPeople'), key: 'people', width: 180 },
  { title: t('comments.colTime'), key: 'time', width: 160 },
  ...(auth.isAdmin ? [{ title: t('content.colOwner'), key: 'owner', width: 100 }] : []),
  ...(tab.value === 'queue' ? [actionColumn(170)] : []),
])
// ---- drafts in the queue: 编辑 (a reply to a comment: in the comment drawer) / 排程 / 删除
const draftEditOpen = ref(false)
const scheduleOpen = ref(false)
const currentDraft = ref<CommentReplyItem | null>(null)
function editDraft(r: CommentReplyItem) {
  if (r.commentId) { openComment(r.commentId); return }
  currentDraft.value = r; draftEditOpen.value = true
}
function scheduleDraft(r: CommentReplyItem) { currentDraft.value = r; scheduleOpen.value = true }
function removeDraft(r: CommentReplyItem) {
  confirmDanger({
    title: t('feed.deleteDraftConfirm'),
    onOk: async () => { try { await api('DELETE', `/api/comment-replies/${r.id}`); message.success(t('common.deleted')); changed() } catch (e) { message.error(errorText(e)) } },
  })
}


// ---------------------------------------------------------------- loading / live updates
function load() {
  if (tab.value === 'comments') return loadComments()
  return loadReplies()
}
const search = () => { page.current = 1; rPage.current = 1; void load() }
function onRepliesChange(p: { current?: number; pageSize?: number }) {
  rPage.current = p.current ?? 1; rPage.pageSize = p.pageSize ?? rPage.pageSize
  void loadReplies()
}
function reset() {
  Object.assign(filters, { accountId: undefined, postId: undefined, status: undefined, source: undefined, q: '', replyStatus: undefined, ownerId: undefined })
  search()
}
watch(() => filters.accountId, (id) => {
  filters.postId = undefined
  void router.replace({ query: { ...route.query, account: id } })
  void loadPosts()
  search()
})
watch(tab, () => { filters.replyStatus = undefined; rPage.current = 1; void load() })

const drawerOpen = ref(false)
const drawerId = ref<string | null>(null)
const drawer = ref<InstanceType<typeof CommentDrawer>>()
function openComment(id: string) { drawerId.value = id; drawerOpen.value = true }
/** Screenshot of a device send (before 发布). */
const evidenceOpen = ref(false)
const evidenceId = ref<string | null>(null)
function showEvidence(id: string) { evidenceId.value = id; evidenceOpen.value = true }
function changed() { void load(); void loadAccounts() }

let timer: ReturnType<typeof setTimeout> | null = null
const off = store.onTaskEvent((ev) => {
  if (ev.type !== 'task.updated' || ev.task.type !== 'comment-reply') return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    void load(); void loadAccounts()
    if (drawerOpen.value) void drawer.value?.reload()
  }, 400)
})
onBeforeUnmount(() => { off(); if (timer) clearTimeout(timer) })
onMounted(async () => {
  void load(); void loadAccounts()
  if (filters.accountId) void loadPosts()
  if (auth.isAdmin) { try { users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users } catch { /* filter only */ } }
})
/** Accounts offered in the filter: those of the picked user (admins). */
const accountOptions = computed(() => accounts.value.filter((a) => !filters.ownerId || a.userId === filters.ownerId))
function onOwner() {
  if (filters.accountId && !accountOptions.value.some((a) => a.id === filters.accountId)) filters.accountId = undefined // the watch reloads
  else search()
}
</script>

<template>
  <div>
    <Teleport v-if="auth.isAdmin" defer :to="extraTo || 'body'" :disabled="!extraTo">
      <a-button @click="$router.push('/risk')">{{ t('comments.rules') }}</a-button>
    </Teleport>

    <div>
      <a-radio-group v-model:value="tab" button-style="solid" class="views">
        <a-radio-button v-for="k in VIEWS" :key="k" :value="k">{{ t(`comments.tabs.${k}`) }}</a-radio-button>
      </a-radio-group>

      <SearchBar @reset="reset">
        <a-select v-if="auth.isAdmin" v-model:value="filters.ownerId" :placeholder="t('content.colOwner')" allow-clear show-search option-filter-prop="label" style="width: 140px"
          :options="users.map((u) => ({ value: u.id, label: u.username }))" @change="onOwner" />
        <a-select v-model:value="filters.accountId" :placeholder="t('comments.allAccounts')" allow-clear show-search option-filter-prop="label" style="width: 240px">
          <a-select-option v-for="a in accountOptions" :key="a.id" :value="a.id" :label="`${platformName(a.platform)} @${a.handle}`">
            <PlatformTag :platform="a.platform" :name="`@${a.handle}${a.newCount ? ` (${a.newCount})` : ''}`" />
          </a-select-option>
        </a-select>
        <a-select v-if="filters.accountId && tab === 'comments'" v-model:value="filters.postId" :placeholder="t('comments.allPosts')" allow-clear style="width: 220px" @change="search">
          <a-select-option v-for="p in posts" :key="p.postId" :value="p.postId">{{ p.title ?? p.postId }} ({{ p.n }})</a-select-option>
        </a-select>
        <a-select v-if="tab === 'comments'" v-model:value="filters.status" :placeholder="t('comments.colStatus')" allow-clear style="width: 140px" @change="search">
          <a-select-option v-for="s in STATUSES" :key="s" :value="s">{{ t(`comments.status.${s}`) }} ({{ byStatus[s] ?? 0 }})</a-select-option>
        </a-select>
        <a-select v-if="tab === 'comments'" v-model:value="filters.source" :placeholder="t('comments.source')" allow-clear style="width: 130px" @change="search">
          <a-select-option value="api">{{ t('comments.sourceApi') }}</a-select-option>
          <a-select-option value="manual">{{ t('comments.sourceManual') }}</a-select-option>
        </a-select>
        <a-select v-if="tab !== 'comments'" v-model:value="filters.replyStatus" :placeholder="t('comments.colStatus')" allow-clear style="width: 150px" @change="search">
          <a-select-option v-for="s in replyStatuses" :key="s" :value="s">{{ t(`comments.replyStatus.${s}`) }} ({{ rByStatus[s] ?? 0 }})</a-select-option>
        </a-select>
        <a-input-search v-model:value="filters.q" :placeholder="t('comments.searchPlaceholder')" allow-clear style="width: 220px" @search="search" />
      </SearchBar>

      <div v-if="account" class="acc-bar">
        <PlatformTag :platform="account.platform" /> <b>@{{ account.handle }}</b>
        <span class="muted small">{{ t('comments.manualOnlyHint') }}</span>
        <a-space class="acc-actions" :size="8">
          <a-button size="small" type="primary" @click="openManual()">{{ t('comments.addManual') }}</a-button>
        </a-space>
      </div>

      <!-- comments -->
      <a-spin v-if="tab === 'comments'" :spinning="loading">
        <a-empty v-if="!items.length && !loading" :description="filters.accountId ? t('comments.emptyManual') : `${t('comments.empty')} · ${t('comments.selectAccount')}`">
          <a-button v-if="filters.accountId" type="primary" @click="openManual()">{{ t('comments.addManual') }}</a-button>
        </a-empty>
        <div v-for="c in items" :key="c.id" class="thread">
          <div v-for="m in (expanded.has(c.id) ? [c, ...(c.children ?? [])] : [c])" :key="m.id" class="msg" :class="{ child: m.id !== c.id, hidden: m.status === 'hidden' || m.status === 'ignored' }">
            <div class="meta">
              <PlatformTag v-if="m.id === c.id" :platform="m.platform" />
              <span v-if="m.id === c.id && !filters.accountId" class="muted">@{{ m.account?.handle }}</span>
              <b>{{ m.authorName ?? '—' }}</b>
              <span v-if="m.authorHandle" class="muted">{{ m.authorHandle }}</span>
              <span class="muted">{{ fmt(m.publishedAt ?? m.createdAt) }}</span>
              <StatusTag kind="comment" :status="m.status" />
              <a-tag v-if="m.source === 'manual'">{{ t('comments.sourceManual') }}</a-tag>
              <a-tag v-else-if="m.source === 'device'" color="cyan">{{ t('comments.sourceDevice') }}</a-tag>
              <span v-if="m.likeCount" class="muted">{{ t('comments.likes', { n: m.likeCount }) }}</span>
              <a v-if="m.id === c.id && m.postUrl" :href="m.postUrl" target="_blank" rel="noopener noreferrer">{{ t('comments.viewPost') }}</a>
              <span v-if="m.id === c.id && m.publishTask?.title" class="muted">{{ t('comments.publishedContent', { title: m.publishTask.title }) }}</span>
            </div>
            <div class="text">{{ m.text }}</div>
            <div v-if="m.reply" class="reply-line">
              <StatusTag kind="commentReply" :status="m.reply.status" />
              <span class="ellipsis">{{ m.reply.text }}</span>
            </div>
            <a-space class="actions" wrap :size="0">
              <a-button size="small" type="link" @click="openComment(m.id)">{{ t('comments.reply') }}</a-button>
              <a-button v-if="m.status === 'new'" size="small" type="link" @click="setStatus(m, 'read')">{{ t('comments.markRead') }}</a-button>
              <a-button v-if="m.status === 'read'" size="small" type="link" @click="setStatus(m, 'new')">{{ t('comments.markNew') }}</a-button>
              <a-button v-if="m.status !== 'hidden'" size="small" type="link" @click="setStatus(m, 'hidden')">{{ t('comments.hide') }}</a-button>
              <a-button v-else size="small" type="link" @click="setStatus(m, 'read')">{{ t('comments.unhide') }}</a-button>
              <a-button v-if="m.status !== 'ignored' && m.status !== 'replied'" size="small" type="link" @click="setStatus(m, 'ignored')">{{ t('comments.ignore') }}</a-button>
              <a-button v-if="m.id === c.id && filters.accountId === m.accountId" size="small" type="link" @click="openManual(m)">{{ t('comments.addManual') }}</a-button>
              <a-button v-if="m.source === 'manual'" size="small" type="link" danger @click="remove(m)">{{ t('common.delete') }}</a-button>
            </a-space>
            <template v-if="m.id === c.id && c.children?.length">
              <FoldToggle v-for="info in [threadInfo(c)]" :key="c.id" :open="expanded.has(c.id)"
                :label="expanded.has(c.id) ? t('comments.collapseReplies') : t('comments.expandReplies', { n: info.n })" @toggle="toggleThread(c.id)">
                <a-tag v-if="info.fresh" color="blue">{{ t('comments.newReplies', { n: info.fresh }) }}</a-tag>
                <a-tag v-if="info.pending" color="orange">{{ t('comments.pendingReplies', { n: info.pending }) }}</a-tag>
              </FoldToggle>
            </template>
          </div>
        </div>
        <a-pagination v-model:current="page.current" v-model:page-size="page.pageSize" v-bind="pagination({ total, hideOnSinglePage: true })" class="pager" @change="loadComments" />
      </a-spin>

      <!-- queue / history -->
      <a-table v-else :data-source="replies" :columns="replyColumns" row-key="id" :size="TABLE_SIZE" :loading="rLoading" :scroll="{ x: 1230 }"
        :pagination="pagination({ current: rPage.current, pageSize: rPage.pageSize, total: rTotal })"
        @change="onRepliesChange">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'account'"><PlatformTag :platform="record.platform" /> @{{ record.account?.handle ?? '—' }}</template>
          <template v-else-if="column.key === 'comment'">
            <template v-if="record.comment">
              <div class="muted small">{{ record.comment.authorName }}</div>
              <div class="ellipsis2">{{ record.comment.text }}</div>
            </template>
            <template v-else-if="record.post">
              <div class="muted small">{{ t('feed.onPost') }}</div>
              <a v-if="record.post.permalink" class="ellipsis2" :href="record.post.permalink" target="_blank" rel="noopener noreferrer">{{ record.post.caption || record.post.permalink }}</a>
              <div v-else class="ellipsis2">{{ record.post.caption }}</div>
            </template>
          </template>
          <template v-else-if="column.key === 'reply'">
            <a v-if="record.commentId" class="ellipsis2" @click="openComment(record.commentId)">{{ record.text }}</a>
            <span v-else class="ellipsis2">{{ record.text }}</span>
            <a v-if="record.hasEvidence" class="small" @click="showEvidence(record.id)">{{ t('feed.evidence') }}</a>
          </template>
          <template v-else-if="column.key === 'status'">
            <StatusTag kind="commentReply" :status="record.status" />
            <div v-if="record.method" class="muted small">{{ t(`comments.method.${record.method}`) }}</div>
            <div v-if="record.status === 'failed' && record.errorCode" class="err">{{ errText(record.errorCode, record.error, record.platform) }}<template v-if="record.errorCode === 'comment.operator_failed' && record.error">: {{ record.error }}</template></div>
            <div v-if="record.status === 'rejected' && record.reviewNote" class="err">{{ record.reviewNote }}</div>
          </template>
          <template v-else-if="column.key === 'people'">
            <div>{{ record.authorName ?? '—' }}</div>
            <div v-if="record.status === 'sent'" class="muted small">{{ t('comments.sentBy', { name: record.senderName ?? t('comments.method.api') }) }}</div>
          </template>
          <template v-else-if="column.key === 'time'">{{ fmt(record.sentAt ?? record.scheduledAt ?? record.updatedAt) }}</template>
          <template v-else-if="column.key === 'owner'">{{ record.ownerName ?? '—' }}</template>
          <template v-else-if="column.key === 'ops'">
            <a-space v-if="record.status === 'draft'" :size="0" wrap>
              <a-button size="small" type="link" @click="editDraft(record as CommentReplyItem)">{{ t('common.edit') }}</a-button>
              <a-button size="small" type="link" @click="scheduleDraft(record as CommentReplyItem)">{{ t('feed.submit') }}</a-button>
              <a-button size="small" type="link" danger @click="removeDraft(record as CommentReplyItem)">{{ t('common.delete') }}</a-button>
            </a-space>
          </template>
        </template>
      </a-table>
    </div>
  </div>

  <CommentDrawer ref="drawer" v-model:open="drawerOpen" :comment-id="drawerId" @changed="changed" />
  <EvidenceModal v-model:open="evidenceOpen" :reply-id="evidenceId" />
  <FeedReplyModal v-model:open="draftEditOpen" :draft="currentDraft" @done="changed" />
  <ReplyScheduleModal v-model:open="scheduleOpen" :reply="currentDraft" @done="changed" />

  <a-modal v-model:open="manualOpen" :title="t('comments.manualTitle')" :width="MODAL_WIDTH.md" :confirm-loading="manualBusy" @ok="saveManual">
    <a-form layout="vertical">
      <a-form-item v-if="parentItem" :label="t('comments.parent')"><a-typography-text :ellipsis="{ tooltip: parentItem.text }" :content="`${parentItem.authorName}: ${parentItem.text}`" /></a-form-item>
      <a-row :gutter="12">
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('comments.authorName')" required><a-input v-model:value="manual.authorName" :maxlength="200" /></a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('comments.authorHandle')"><a-input v-model:value="manual.authorHandle" :maxlength="200" /></a-form-item>
        </a-col>
      </a-row>
      <a-form-item :label="t('comments.text')" required><a-textarea v-model:value="manual.text" :auto-size="{ minRows: 3, maxRows: 8 }" :maxlength="10000" /></a-form-item>
      <a-row :gutter="12">
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('comments.publishedAt')"><a-date-picker v-model:value="manual.at" show-time style="width: 100%" /></a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('comments.externalId')"><a-input v-model:value="manual.externalId" :maxlength="200" /></a-form-item>
        </a-col>
      </a-row>
      <a-row v-if="!parentItem" :gutter="12">
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('comments.externalPostId')"><a-input v-model:value="manual.externalPostId" :maxlength="200" /></a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12">
          <a-form-item :label="t('comments.postUrl')"><a-input v-model:value="manual.postUrl" :maxlength="1000" /></a-form-item>
        </a-col>
      </a-row>
    </a-form>
  </a-modal>


</template>

<style scoped>
.views { margin-bottom: var(--cp-gap); }
.acc-bar {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: var(--cp-gap);
  padding: 8px 12px; background: var(--cp-fill-alter); border-radius: var(--cp-radius);
}
.acc-actions { margin-inline-start: auto; }
.thread { border: 1px solid var(--cp-border-secondary); border-radius: var(--cp-radius); padding: 8px 12px; margin-bottom: 8px; }
.msg { padding: 4px 0; }
.msg.child { margin-left: 24px; border-top: 1px dashed var(--cp-border-secondary); }
.msg.hidden { opacity: 0.6; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; }
.text { white-space: pre-wrap; word-break: break-word; margin: 2px 0; }
.reply-line { display: flex; gap: 6px; align-items: center; font-size: 12px; min-width: 0; }
.actions { margin-inline-start: -7px; }
.err { color: var(--cp-error); font-size: 12px; }
.pre { white-space: pre-wrap; }
.ellipsis2 { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
.pager { margin-top: var(--cp-gap); text-align: right; }
</style>
