<script setup lang="ts">
import { dateLocale } from '../i18n'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { Dayjs } from 'dayjs'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { api, codeText, errorText } from '../api/client'
import { PlusOutlined } from '@ant-design/icons-vue'
import {
  taskStatusText,
  type CommentAccount, type CommentItem, type CommentReplyItem, type CommentReplyStatus, type CommentRules, type CommentStatus, type CommentTemplate,
} from '../api/types'
import CommentDrawer from '../components/comments/CommentDrawer.vue'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import StatusTag from '../components/common/StatusTag.vue'
import { statusColor } from '../components/common/status'
import { actionColumn, confirmDanger, MODAL_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'
import PlatformTag from '../components/social/PlatformTag.vue'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

/** Comments & engagement (评论互动): threads, reply composer, review queue, sending / history, templates, rules. */
const { t } = useI18n()
const auth = useAuthStore()
const store = useInstancesStore()
const route = useRoute()
const router = useRouter()

type Tab = 'comments' | 'review' | 'queue' | 'history' | 'templates'
const TABS: Tab[] = ['comments', 'review', 'queue', 'history', 'templates']
const tab = computed<Tab>({
  get: () => (TABS.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'comments'),
  set: (v) => { void router.replace({ query: { ...route.query, tab: v } }) },
})
const QUEUE: CommentReplyStatus[] = ['draft', 'approved', 'scheduled', 'sending', 'awaiting_operator']
const HISTORY: CommentReplyStatus[] = ['sent', 'failed', 'rejected', 'cancelled']
const STATUSES: CommentStatus[] = ['new', 'read', 'replied', 'hidden', 'ignored']
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
const errText = (code: string | null, raw: string | null, platform?: string) => (code ? codeText(code, { platform: platform ?? '' }, raw ?? code) : raw ?? '')

const accounts = ref<CommentAccount[]>([])
const posts = ref<{ postId: string; postUrl: string | null; n: number; title: string | null }[]>([])
const templates = ref<CommentTemplate[]>([])
const rules = ref<CommentRules | null>(null)
const filters = reactive({
  accountId: (typeof route.query.account === 'string' ? route.query.account : undefined) as string | undefined,
  postId: undefined as string | undefined, status: (typeof route.query.status === 'string' ? route.query.status : undefined) as CommentStatus | undefined, source: undefined as 'api' | 'manual' | undefined, q: '',
})
const account = computed(() => accounts.value.find((a) => a.id === filters.accountId) ?? null)

async function loadAccounts() {
  try { accounts.value = (await api<{ accounts: CommentAccount[] }>('GET', '/api/comments/accounts')).accounts } catch (e) { message.error(errorText(e)) }
}
async function loadPosts() {
  posts.value = []
  if (!filters.accountId) return
  try { posts.value = (await api<{ posts: typeof posts.value }>('GET', `/api/comments/posts?accountId=${filters.accountId}`)).posts } catch (e) { message.error(errorText(e)) }
}
async function loadTemplates() {
  try { templates.value = (await api<{ templates: CommentTemplate[] }>('GET', '/api/comment-templates')).templates } catch (e) { message.error(errorText(e)) }
}
async function loadRules() {
  try { rules.value = (await api<{ rules: CommentRules }>('GET', '/api/comments/settings')).rules } catch (e) { message.error(errorText(e)) }
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
    if (filters.postId) p.set('postId', filters.postId)
    if (filters.status) p.set('status', filters.status)
    if (filters.source) p.set('source', filters.source)
    if (filters.q.trim()) p.set('q', filters.q.trim())
    p.set('limit', String(page.pageSize)); p.set('offset', String((page.current - 1) * page.pageSize))
    const r = await api<{ items: CommentItem[]; total: number; byStatus: Record<CommentStatus, number> }>('GET', `/api/comments?${p}`)
    items.value = r.items; total.value = r.total; byStatus.value = r.byStatus
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
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

// ---------------------------------------------------------------- sync
const syncing = ref(false)
async function syncNow() {
  if (!account.value) return
  syncing.value = true
  try {
    await api('POST', `/api/comments/accounts/${account.value.id}/sync`)
    message.success(t('comments.syncStarted'))
    await loadAccounts()
  } catch (e) { message.error(errorText(e)) } finally { syncing.value = false }
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

// ---------------------------------------------------------------- replies (review / queue / history)
const replies = ref<CommentReplyItem[]>([])
const rTotal = ref(0)
const rByStatus = ref<Partial<Record<CommentReplyStatus, number>>>({})
const rLoading = ref(false)
const rPage = reactive({ current: 1, pageSize: 20 })
const reviewCount = ref(0)
const selected = ref<string[]>([])
async function loadReplies() {
  rLoading.value = true
  try {
    const p = new URLSearchParams()
    if (filters.accountId) p.set('accountId', filters.accountId)
    if (filters.q.trim()) p.set('q', filters.q.trim())
    if (tab.value === 'review') p.set('reviewable', 'true')
    else p.set('status', (tab.value === 'queue' ? QUEUE : HISTORY).join(','))
    p.set('limit', String(rPage.pageSize)); p.set('offset', String((rPage.current - 1) * rPage.pageSize))
    const r = await api<{ items: CommentReplyItem[]; total: number; byStatus: Record<CommentReplyStatus, number> }>('GET', `/api/comment-replies?${p}`)
    replies.value = r.items; rTotal.value = r.total; rByStatus.value = r.byStatus
    if (tab.value === 'review') reviewCount.value = r.total
    selected.value = selected.value.filter((id) => r.items.some((x) => x.id === id))
  } catch (e) { message.error(errorText(e)) } finally { rLoading.value = false }
}
async function loadReviewCount() {
  try { reviewCount.value = (await api<{ total: number }>('GET', '/api/comment-replies?reviewable=true&limit=1')).total } catch { /* badge only */ }
}
const rowSelection = computed(() => ({
  selectedRowKeys: selected.value,
  onChange: (keys: (string | number)[]) => { selected.value = keys.map(String) },
  getCheckboxProps: (r: CommentReplyItem) => ({ disabled: !r.canReview }),
}))
async function approveSelected() {
  try {
    const r = await api<{ results: { id: string; ok: boolean; code?: string; error?: string }[] }>('POST', '/api/comment-replies/approve', { ids: selected.value })
    const fail = r.results.filter((x) => !x.ok)
    if (fail.length) message.warning(`${t('comments.batchResult', { ok: r.results.length - fail.length, fail: fail.length })}: ${fail.map((x) => errText(x.code ?? null, x.error ?? null)).join('; ')}`)
    else message.success(t('comments.batchResult', { ok: r.results.length, fail: 0 }))
    selected.value = []
    await loadReplies()
  } catch (e) { message.error(errorText(e)) }
}
const replyColumns = computed(() => [
  { title: t('comments.colAccount'), key: 'account', width: 180 },
  { title: t('comments.colComment'), key: 'comment', width: 280 },
  { title: t('comments.colReply'), key: 'reply', width: 280 },
  { title: t('comments.colStatus'), key: 'status', width: 150 },
  { title: t('comments.colPeople'), key: 'people', width: 180 },
  { title: t('comments.colTime'), key: 'time', width: 160 },
  ...(auth.isAdmin ? [{ title: t('content.colOwner'), key: 'owner', width: 100 }] : []),
])

// ---------------------------------------------------------------- templates
const tplOpen = ref(false)
const tpl = reactive({ id: null as string | null, name: '', text: '', shared: false })
const tplColumns = computed(() => [
  { title: t('comments.templateName'), dataIndex: 'name', key: 'name', width: 200 },
  { title: t('comments.templateText'), dataIndex: 'text', key: 'text', width: 420 },
  { title: t('scripts.visibility'), key: 'shared', width: 140 },
  actionColumn(120),
])
function openTpl(x?: CommentTemplate) {
  Object.assign(tpl, x ? { id: x.id, name: x.name, text: x.text, shared: x.shared } : { id: null, name: '', text: '', shared: false })
  tplOpen.value = true
}
async function saveTpl() {
  if (!tpl.name.trim() || !tpl.text.trim()) { message.warning(t('common.required')); return }
  try {
    if (tpl.id) await api('PUT', `/api/comment-templates/${tpl.id}`, { name: tpl.name, text: tpl.text })
    else await api('POST', '/api/comment-templates', { name: tpl.name, text: tpl.text, shared: tpl.shared })
    message.success(t('common.saved')); tplOpen.value = false; await loadTemplates()
  } catch (e) { message.error(errorText(e)) }
}
function removeTpl(x: CommentTemplate) {
  confirmDanger({
    title: t('comments.deleteTemplateConfirm'),
    onOk: async () => { try { await api('DELETE', `/api/comment-templates/${x.id}`); await loadTemplates() } catch (e) { message.error(errorText(e)) } },
  })
}

// ---------------------------------------------------------------- rules (admin)
const rulesOpen = ref(false)
const rulesForm = reactive<CommentRules>({ requireApproval: true, duplicateMax: 3, duplicateWindowHours: 24, sendsPerHour: 20 })
function openRules() { if (rules.value) Object.assign(rulesForm, rules.value); rulesOpen.value = true }
async function saveRules() {
  try { rules.value = (await api<{ rules: CommentRules }>('PUT', '/api/comments/settings', { ...rulesForm })).rules; message.success(t('common.saved')); rulesOpen.value = false } catch (e) { message.error(errorText(e)) }
}

// ---------------------------------------------------------------- loading / live updates
function load() {
  if (tab.value === 'comments') return loadComments()
  if (tab.value === 'templates') return loadTemplates()
  return loadReplies()
}
const search = () => { page.current = 1; rPage.current = 1; void load() }
function onRepliesChange(p: { current?: number; pageSize?: number }) {
  rPage.current = p.current ?? 1; rPage.pageSize = p.pageSize ?? rPage.pageSize
  void loadReplies()
}
function reset() {
  Object.assign(filters, { accountId: undefined, postId: undefined, status: undefined, source: undefined, q: '' })
  search()
}
watch(() => filters.accountId, (id) => {
  filters.postId = undefined
  void router.replace({ query: { ...route.query, account: id } })
  void loadPosts()
  search()
})
watch(tab, () => { selected.value = []; void load() })

const drawerOpen = ref(false)
const drawerId = ref<string | null>(null)
const drawer = ref<InstanceType<typeof CommentDrawer>>()
function openComment(id: string) { drawerId.value = id; drawerOpen.value = true }
function changed() { void load(); void loadReviewCount(); void loadAccounts() }

let timer: ReturnType<typeof setTimeout> | null = null
const off = store.onTaskEvent((ev) => {
  if (ev.type !== 'task.updated' || !['comment-sync', 'comment-reply'].includes(ev.task.type)) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    void load(); void loadAccounts(); void loadReviewCount()
    if (drawerOpen.value) void drawer.value?.reload()
  }, 400)
})
onBeforeUnmount(() => { off(); if (timer) clearTimeout(timer) })
onMounted(() => {
  void load(); void loadAccounts(); void loadTemplates(); void loadRules(); void loadReviewCount()
  if (filters.accountId) void loadPosts()
})
const reason = (code: string | null, platform: string) => (code ? codeText(code, { platform }, code) : '')
</script>

<template>
  <PageContainer :title="t('comments.title')">
    <template v-if="auth.isAdmin" #extra>
      <a-button @click="openRules">{{ t('comments.rules') }}</a-button>
    </template>

    <a-card :bordered="false" class="tabs-card">
      <a-tabs v-model:active-key="tab">
        <a-tab-pane key="comments" :tab="t('comments.tabs.comments')" />
        <a-tab-pane v-for="k in (['review', 'queue', 'history'] as const)" :key="k">
          <template #tab>
            {{ t(`comments.tabs.${k}`) }}<a-badge v-if="k === 'review' && reviewCount" :count="reviewCount" :offset="[6, -2]" />
          </template>
        </a-tab-pane>
        <a-tab-pane key="templates" :tab="t('comments.tabs.templates')" />
      </a-tabs>

      <SearchBar @reset="reset">
        <a-select v-model:value="filters.accountId" :placeholder="t('comments.allAccounts')" allow-clear show-search option-filter-prop="label" style="width: 240px"
          :options="accounts.map((a) => ({ value: a.id, label: `${a.platform} @${a.handle}${a.newCount ? ` (${a.newCount})` : ''}` }))" />
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
        <a-input-search v-if="tab !== 'templates'" v-model:value="filters.q" :placeholder="t('comments.searchPlaceholder')" allow-clear style="width: 220px" @search="search" />
        <template v-if="tab === 'review' || tab === 'templates'" #actions>
          <a-button v-if="tab === 'review'" type="primary" :disabled="!selected.length" @click="approveSelected">{{ t('comments.approveSelected', { n: selected.length }) }}</a-button>
          <template v-else>
            <a-button @click="$router.push({ path: '/scripts', query: { kind: 'comment' } })">{{ t('scripts.manage') }}</a-button>
            <a-button type="primary" @click="openTpl()"><template #icon><PlusOutlined /></template>{{ t('comments.newTemplate') }}</a-button>
          </template>
        </template>
      </SearchBar>

      <div v-if="account" class="acc-bar">
        <PlatformTag :platform="account.platform" /> <b>@{{ account.handle }}</b>
        <a-tooltip :title="reason(account.readReason, account.platform) || undefined">
          <a-tag :color="account.readMode === 'api' ? 'blue' : 'orange'">{{ account.readMode === 'api' ? t('comments.modeApi') : t('comments.modeManual') }}</a-tag>
        </a-tooltip>
        <a-tooltip :title="reason(account.replyReason, account.platform) || undefined">
          <a-tag :color="account.replyMode === 'api' ? 'blue' : 'orange'">{{ account.replyMode === 'api' ? t('comments.replyApi') : t('comments.replyManual') }}</a-tag>
        </a-tooltip>
        <span v-if="account.readMode === 'manual' && account.readReason" class="muted small">{{ reason(account.readReason, account.platform) }}</span>
        <span v-if="account.sync?.lastSyncedAt" class="muted small">{{ t('comments.lastSync', { time: fmt(account.sync.lastSyncedAt), fetched: account.sync.lastFetched ?? 0, new: account.sync.lastNew ?? 0 }) }}</span>
        <span v-else-if="account.commentsRead" class="muted small">{{ t('comments.neverSynced') }}</span>
        <template v-if="account.sync?.task">
          <a-tag :color="statusColor('task', account.sync.task.status)" style="cursor: pointer" @click="router.push(`/tasks?task=${account.sync.task.id}`)">
            {{ t('comments.syncTask', { status: taskStatusText(account.sync.task.status) }) }}
          </a-tag>
          <span v-if="account.sync.task.status === 'failed' && account.sync.lastErrorCode" class="err">{{ errText(account.sync.lastErrorCode, account.sync.lastError, account.platform) }}</span>
        </template>
        <a-space class="acc-actions" :size="8">
          <a-button size="small" @click="openManual()">{{ t('comments.addManual') }}</a-button>
          <a-button v-if="account.commentsRead" size="small" type="primary" :loading="syncing" :disabled="account.readMode !== 'api'" @click="syncNow">{{ t('comments.syncNow') }}</a-button>
        </a-space>
      </div>

      <!-- comments -->
      <a-spin v-if="tab === 'comments'" :spinning="loading">
        <a-empty v-if="!items.length && !loading" :description="filters.accountId ? t('comments.empty') : `${t('comments.empty')} · ${t('comments.selectAccount')}`" />
        <div v-for="c in items" :key="c.id" class="thread">
          <div v-for="m in [c, ...(c.children ?? [])]" :key="m.id" class="msg" :class="{ child: m.id !== c.id, hidden: m.status === 'hidden' || m.status === 'ignored' }">
            <div class="meta">
              <PlatformTag v-if="m.id === c.id" :platform="m.platform" />
              <span v-if="m.id === c.id && !filters.accountId" class="muted">@{{ m.account?.handle }}</span>
              <b>{{ m.authorName ?? '—' }}</b>
              <span v-if="m.authorHandle" class="muted">{{ m.authorHandle }}</span>
              <span class="muted">{{ fmt(m.publishedAt ?? m.createdAt) }}</span>
              <StatusTag kind="comment" :status="m.status" />
              <a-tag v-if="m.source === 'manual'">{{ t('comments.sourceManual') }}</a-tag>
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
          </div>
        </div>
        <a-pagination v-model:current="page.current" v-model:page-size="page.pageSize" v-bind="pagination({ total, hideOnSinglePage: true })" class="pager" @change="loadComments" />
      </a-spin>

      <!-- review / queue / history -->
      <a-table v-else-if="tab !== 'templates'" :data-source="replies" :columns="replyColumns" row-key="id" :size="TABLE_SIZE" :loading="rLoading" :scroll="{ x: 1230 }"
        :row-selection="tab === 'review' ? rowSelection : undefined"
        :pagination="pagination({ current: rPage.current, pageSize: rPage.pageSize, total: rTotal })"
        @change="onRepliesChange">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'account'"><PlatformTag :platform="record.platform" /> @{{ record.account?.handle ?? '—' }}</template>
          <template v-else-if="column.key === 'comment'">
            <div class="muted small">{{ record.comment?.authorName }}</div>
            <div class="ellipsis2">{{ record.comment?.text }}</div>
          </template>
          <template v-else-if="column.key === 'reply'"><a class="ellipsis2" @click="openComment(record.commentId)">{{ record.text }}</a></template>
          <template v-else-if="column.key === 'status'">
            <StatusTag kind="commentReply" :status="record.status" />
            <div v-if="record.method" class="muted small">{{ t(`comments.method.${record.method}`) }}</div>
            <div v-if="record.status === 'failed' && record.errorCode" class="err">{{ errText(record.errorCode, record.error, record.platform) }}<template v-if="record.errorCode === 'comment.operator_failed' && record.error">: {{ record.error }}</template></div>
            <div v-if="record.status === 'rejected' && record.reviewNote" class="err">{{ record.reviewNote }}</div>
          </template>
          <template v-else-if="column.key === 'people'">
            <div>{{ record.authorName ?? '—' }}</div>
            <div class="muted small">{{ record.reviewerName ?? '—' }} / {{ record.status === 'sent' ? (record.senderName ?? t('comments.method.api')) : '—' }}</div>
          </template>
          <template v-else-if="column.key === 'time'">{{ fmt(record.sentAt ?? record.scheduledAt ?? record.updatedAt) }}</template>
          <template v-else-if="column.key === 'owner'">{{ record.ownerName ?? '—' }}</template>
        </template>
      </a-table>

      <!-- templates -->
      <a-table v-else :data-source="templates" :columns="tplColumns" row-key="id" :size="TABLE_SIZE" :scroll="{ x: 880 }" :pagination="pagination({ defaultPageSize: 50, hideOnSinglePage: true })">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'text'"><span class="pre">{{ record.text }}</span></template>
          <template v-else-if="column.key === 'shared'">
            <a-tag v-if="record.shared" color="blue">{{ t('scripts.public') }}</a-tag>
            <span v-else>{{ t('scripts.personal') }}<span v-if="auth.isAdmin && record.ownerName" class="muted"> · {{ record.ownerName }}</span></span>
          </template>
          <template v-else-if="column.key === 'ops'">
            <a-space v-if="record.writable" :size="0">
              <a-button size="small" type="link" @click="openTpl(record as CommentTemplate)">{{ t('common.edit') }}</a-button>
              <a-button size="small" type="link" danger @click="removeTpl(record as CommentTemplate)">{{ t('common.delete') }}</a-button>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-card>
  </PageContainer>

  <CommentDrawer ref="drawer" v-model:open="drawerOpen" :comment-id="drawerId" :templates="templates" :rules="rules" @changed="changed" />

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

  <a-modal v-model:open="tplOpen" :title="tpl.id ? t('comments.editTemplate') : t('comments.newTemplate')" :width="MODAL_WIDTH.md" @ok="saveTpl">
    <a-form layout="vertical">
      <a-form-item :label="t('comments.templateName')" required><a-input v-model:value="tpl.name" :maxlength="100" /></a-form-item>
      <a-form-item :label="t('comments.templateText')" required><a-textarea v-model:value="tpl.text" :auto-size="{ minRows: 3, maxRows: 8 }" :maxlength="5000" /></a-form-item>
      <a-form-item v-if="auth.isAdmin && !tpl.id" :label="t('scripts.visibility')" :extra="tpl.shared ? t('scripts.publicHint') : undefined">
        <a-radio-group v-model:value="tpl.shared">
          <a-radio :value="true">{{ t('scripts.tabs.public') }}</a-radio>
          <a-radio :value="false">{{ t('scripts.tabs.mine') }}</a-radio>
        </a-radio-group>
      </a-form-item>
    </a-form>
  </a-modal>

  <a-modal v-model:open="rulesOpen" :title="t('comments.rules')" :width="MODAL_WIDTH.sm" @ok="saveRules">
    <a-form layout="vertical">
      <a-form-item><a-checkbox v-model:checked="rulesForm.requireApproval">{{ t('comments.requireApproval') }}</a-checkbox></a-form-item>
      <a-form-item :label="t('comments.duplicateMax')"><a-input-number v-model:value="rulesForm.duplicateMax" :min="1" :max="100" style="width: 100%" /></a-form-item>
      <a-form-item :label="t('comments.duplicateWindowHours')"><a-input-number v-model:value="rulesForm.duplicateWindowHours" :min="1" :max="720" style="width: 100%" /></a-form-item>
      <a-form-item :label="t('comments.sendsPerHour')"><a-input-number v-model:value="rulesForm.sendsPerHour" :min="1" :max="500" style="width: 100%" /></a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.tabs-card :deep(.ant-card-body) { padding-top: 4px; }
.tabs-card :deep(.ant-tabs-nav) { margin-bottom: var(--cp-gap); }
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
