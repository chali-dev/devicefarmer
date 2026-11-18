<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import type { CommentReplyItem, FeedComment, FeedPost } from '../../api/types'
import { dateLocale } from '../../i18n'
import StatusTag from '../common/StatusTag.vue'
import { DRAWER_WIDTH, pagination } from '../common/ui'
import PlatformTag from '../social/PlatformTag.vue'
import EvidenceModal from './EvidenceModal.vue'
import FeedActivity from './FeedActivity.vue'
import FeedCollectBar from './FeedCollectBar.vue'
import FeedPosts from './FeedPosts.vue'
import FeedReplyModal, { type ReplyTarget } from './FeedReplyModal.vue'
import { useAccountFeed } from './useAccountFeed'

/**
 * 社交号详情 (drawer, opened by clicking an account row): 动态 / 帖子 (comments folded under each post, 「评论」 /
 * 「回复」 → schedule → sent by the account's cloud phone) / 回复记录 (state, time, result, test-mode runs).
 */
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ account: { id: string; platform: string; handle: string; displayName?: string | null } | null }>()
const { t } = useI18n()
const tab = ref<'activity' | 'posts' | 'replies'>('posts')
const { feed, page, pageSize, loading, collecting, load, collectNow, reset } = useAccountFeed('social')

const replies = ref<CommentReplyItem[]>([])
const rTotal = ref(0)
const rPage = ref(1)
const rLoading = ref(false)
async function loadReplies(p = rPage.value) {
  if (!props.account) return
  rPage.value = p
  rLoading.value = true
  try {
    const r = await api<{ items: CommentReplyItem[]; total: number }>('GET', `/api/comment-replies?accountId=${props.account.id}&limit=20&offset=${(p - 1) * 20}`)
    replies.value = r.items; rTotal.value = r.total
  } catch (e) { message.error(errorText(e)) } finally { rLoading.value = false }
}
watch(() => [open.value, props.account?.id] as const, ([o, id]) => {
  if (!o || !id) return
  reset(); tab.value = 'posts'; rPage.value = 1
  void load(id, 1); void loadReplies(1)
}, { immediate: true })
const reload = () => { if (props.account) { void load(props.account.id); void loadReplies() } }

// ---- compose
const composeOpen = ref(false)
const target = ref<ReplyTarget | null>(null)
function replyTo(c: FeedComment) { target.value = { kind: 'comment', commentId: c.id, author: c.authorHandle ?? c.authorName ?? null, text: c.text }; composeOpen.value = true }
function commentOn(p: FeedPost) { if (props.account) { target.value = { kind: 'post', accountId: props.account.id, postId: p.id, caption: p.caption }; composeOpen.value = true } }
const evidenceOpen = ref(false)
const evidenceId = ref<string | null>(null)
function showEvidence(id: string) { evidenceId.value = id; evidenceOpen.value = true }

const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
const replyColumns = computed(() => [
  { title: t('comments.colComment'), key: 'target' },
  { title: t('comments.colReply'), key: 'text' },
  { title: t('comments.colStatus'), key: 'status', width: 170 },
  { title: t('comments.colTime'), key: 'time', width: 170 },
])
</script>

<template>
  <a-drawer v-model:open="open" :width="DRAWER_WIDTH.lg" destroy-on-close>
    <template #title>
      <a-space v-if="account" :size="6"><PlatformTag :platform="account.platform" /><span>@{{ account.handle }}</span></a-space>
    </template>
    <template v-if="account && feed">
      <FeedCollectBar :state="feed.collect" :collecting="collecting" :test-mode="feed.send?.testMode ?? null" @collect="collectNow(account.id)" />
      <a-tabs v-model:active-key="tab">
        <a-tab-pane key="activity" :tab="t('feed.tabs.activity')"><FeedActivity :items="feed.activity" /></a-tab-pane>
        <a-tab-pane key="posts" :tab="`${t('feed.tabs.posts')} (${feed.posts.total})`">
          <FeedPosts kind="social" :account-id="account.id" :posts="feed.posts.items" :total="feed.posts.total" :page="page" :page-size="pageSize" :loading="loading"
            :readonly="!!feed.collect.unsupported" @page="(n) => load(account!.id, n)" @reply="replyTo" @comment="commentOn" @evidence="showEvidence" />
        </a-tab-pane>
        <a-tab-pane key="replies" :tab="`${t('feed.tabs.replies')} (${rTotal})`">
          <a-table :data-source="replies" :columns="replyColumns" row-key="id" size="small" :loading="rLoading" :scroll="{ x: 640 }"
            :pagination="pagination({ current: rPage, pageSize: 20, total: rTotal, showSizeChanger: false, hideOnSinglePage: true, onChange: (n: number) => loadReplies(n) })">
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'target'">
                <template v-if="record.comment">
                  <div class="muted small">@{{ record.comment.authorHandle ?? record.comment.authorName }}</div>
                  <div class="ellipsis2">{{ record.comment.text }}</div>
                </template>
                <template v-else-if="record.post">
                  <div class="muted small">{{ t('feed.onPost') }}</div>
                  <div class="ellipsis2">{{ record.post.caption ?? record.post.permalink }}</div>
                </template>
              </template>
              <template v-else-if="column.key === 'text'"><div class="ellipsis2">{{ record.text }}</div></template>
              <template v-else-if="column.key === 'status'">
                <StatusTag kind="commentReply" :status="record.status" />
                <div v-if="record.method" class="muted small">{{ t(`comments.method.${record.method}`) }}</div>
                <div v-if="record.errorCode && !['sent', 'dry_run'].includes(record.status)" class="err">{{ codeText(record.errorCode, undefined, record.error ?? record.errorCode) }}</div>
                <a v-if="record.hasEvidence" class="small" @click="showEvidence(record.id)">{{ t('feed.evidence') }}</a>
              </template>
              <template v-else-if="column.key === 'time'">
                <div>{{ fmt(record.sentAt ?? record.handedAt ?? record.scheduledAt ?? record.updatedAt) }}</div>
                <div v-if="record.status === 'scheduled' && record.scheduledAt" class="muted small">{{ t('feed.scheduled') }}</div>
              </template>
            </template>
          </a-table>
        </a-tab-pane>
      </a-tabs>
    </template>
    <a-skeleton v-else active />
  </a-drawer>
  <FeedReplyModal v-model:open="composeOpen" :target="target" :halted="!!feed?.collect.halted" :test-mode="feed?.send?.testMode ?? null" @done="reload" />
  <EvidenceModal v-model:open="evidenceOpen" :reply-id="evidenceId" />
</template>

<style scoped>
.err { color: var(--cp-error); font-size: 12px; }
.ellipsis2 { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
</style>
