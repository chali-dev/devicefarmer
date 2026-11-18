<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FeedComment, FeedPost } from '../../api/types'
import { DRAWER_WIDTH } from '../common/ui'
import PlatformTag from '../social/PlatformTag.vue'
import EvidenceModal from './EvidenceModal.vue'
import FeedActivity from './FeedActivity.vue'
import FeedCollectBar from './FeedCollectBar.vue'
import FeedPosts from './FeedPosts.vue'
import FeedReplyModal, { type ReplyTarget } from './FeedReplyModal.vue'
import FeedReplyTable from './FeedReplyTable.vue'
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

const rTotal = ref(0)
const replyTable = ref<InstanceType<typeof FeedReplyTable> | null>(null)
const replyFilter = computed(() => (open.value && props.account ? `accountId=${props.account.id}` : null))
watch(() => [open.value, props.account?.id] as const, ([o, id]) => {
  if (!o || !id) return
  reset(); tab.value = 'posts'; rTotal.value = 0
  void load(id, 1)
}, { immediate: true })
const reload = () => { if (props.account) { void load(props.account.id); void replyTable.value?.reload() } }

// ---- compose
const composeOpen = ref(false)
const target = ref<ReplyTarget | null>(null)
function replyTo(c: FeedComment) { target.value = { kind: 'comment', commentId: c.id, author: c.authorHandle ?? c.authorName ?? null, text: c.text }; composeOpen.value = true }
function commentOn(p: FeedPost) { if (props.account) { target.value = { kind: 'post', accountId: props.account.id, postId: p.id, caption: p.caption }; composeOpen.value = true } }
const evidenceOpen = ref(false)
const evidenceId = ref<string | null>(null)
function showEvidence(id: string) { evidenceId.value = id; evidenceOpen.value = true }
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
        <a-tab-pane key="replies" force-render :tab="`${t('feed.tabs.replies')} (${rTotal})`">
          <FeedReplyTable ref="replyTable" :filter="replyFilter" @total="(n) => (rTotal = n)" @evidence="showEvidence" />
        </a-tab-pane>
      </a-tabs>
    </template>
    <a-skeleton v-else active />
  </a-drawer>
  <FeedReplyModal v-model:open="composeOpen" :target="target" :halted="!!feed?.collect.halted" :test-mode="feed?.send?.testMode ?? null" @done="reload" />
  <EvidenceModal v-model:open="evidenceOpen" :reply-id="evidenceId" />
</template>
