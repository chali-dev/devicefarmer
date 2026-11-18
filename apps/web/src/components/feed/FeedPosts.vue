<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import { compactNumber, type CommentReplyStatus, type FeedComment, type FeedPost, type FeedReply } from '../../api/types'
import { dateLocale } from '../../i18n'
import FoldToggle from '../comments/FoldToggle.vue'
import StatusTag from '../common/StatusTag.vue'
import { pagination } from '../common/ui'

/**
 * Post cards of the account feed: caption, time, likes / comments, and the comments read on the phone folded
 * under each post with the same V toggle as the 评论互动 threads. Unless `readonly`: 「评论」 on a post, 「回复」 on a
 * top-level comment (both open the reply composer; on a tracked account's post with one of the viewer's own accounts),
 * the replies' state + screenshot.
 */
const props = defineProps<{
  kind: 'social' | 'tracked'; accountId: string; posts: FeedPost[]; total: number; page: number; pageSize: number; loading: boolean; readonly: boolean
  /** Show a delete button per post (tracked accounts keep their per-post delete). */
  deletable?: boolean
}>()
const emit = defineEmits<{ page: [number]; reply: [FeedComment, FeedPost]; comment: [FeedPost]; evidence: [string]; remove: [FeedPost] }>()
const { t, te } = useI18n()
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
const num = (n: number | null, approx: boolean) => (n === null ? '—' : `${approx ? `${t('feed.approx')} ` : ''}${approx ? compactNumber(n) : n.toLocaleString(dateLocale())}`)
const mediaType = (m: string | null) => (m ? (te(`feed.mediaTypes.${m}`) ? t(`feed.mediaTypes.${m}`) : m) : null)

const expanded = ref(new Set<string>())
function toggle(id: string) { const s = new Set(expanded.value); if (!s.delete(id)) s.add(id); expanded.value = s }
/** Comments beyond the first page, loaded per post. */
const more = reactive<Record<string, FeedComment[]>>({})
const loadingMore = ref<string | null>(null)
watch(() => props.posts, () => { for (const k of Object.keys(more)) delete more[k] })
const shown = (p: FeedPost) => [...p.commentRows, ...(more[p.id] ?? [])]
async function loadMore(p: FeedPost) {
  loadingMore.value = p.id
  try {
    const path = props.kind === 'social' ? `/api/social/accounts/${props.accountId}/posts/${p.id}/comments` : `/api/tracked-accounts/${props.accountId}/posts/${p.id}/comments`
    const r = await api<{ items: FeedComment[]; total: number }>('GET', `${path}?limit=30&offset=${shown(p).length}`)
    more[p.id] = [...(more[p.id] ?? []), ...r.items]
  } catch (e) { message.error(errorText(e)) } finally { loadingMore.value = null }
}
const ACTIVE: CommentReplyStatus[] = ['draft', 'pending_review', 'approved', 'scheduled', 'sending', 'awaiting_operator', 'sent']
const canReply = (c: FeedComment) => !props.readonly && (!c.reply || !ACTIVE.includes(c.reply.status))
const replyTime = (r: FeedReply) => fmt(r.sentAt ?? r.handedAt ?? r.scheduledAt ?? r.updatedAt)
const replyError = (r: FeedReply) => (r.errorCode && r.status !== 'sent' && r.status !== 'dry_run' ? codeText(r.errorCode, undefined, r.error ?? r.errorCode) : null)
</script>

<template>
  <a-spin :spinning="loading">
    <a-empty v-if="!posts.length && !loading" :description="t('feed.noPosts')" />
    <div v-for="p in posts" :key="p.id" class="post">
      <div class="meta">
        <a-tag v-if="mediaType(p.mediaType)" class="tag">{{ mediaType(p.mediaType) }}</a-tag>
        <span class="muted">{{ fmt(p.publishedAt ?? p.firstSeenAt) }}</span>
        <a v-if="p.permalink" :href="p.permalink" target="_blank" rel="noopener noreferrer">{{ t('feed.openPost') }}</a>
        <span class="grow" />
        <a-button v-if="!readonly" size="small" @click="emit('comment', p)">{{ t('feed.comment') }}</a-button>
        <a-button v-if="deletable" size="small" type="link" danger @click="emit('remove', p)">{{ t('common.delete') }}</a-button>
      </div>
      <div v-if="p.caption" class="caption">{{ p.caption }}</div>
      <div class="counts">
        <span>{{ t('feed.likes', { n: num(p.likes, p.approx.includes('likes')) }) }}</span>
        <span>{{ t('feed.commentsCount', { n: num(p.comments, p.approx.includes('comments')) }) }}</span>
        <span v-if="p.commentsFetchedAt" class="muted">{{ t('feed.commentsRead', { n: p.commentsTotal }) }} · {{ fmt(p.commentsFetchedAt) }}</span>
      </div>
      <div v-if="p.postComments?.length" class="mine">
        <div class="muted small">{{ t('feed.postComments') }}</div>
        <div v-for="r in p.postComments.filter((x): x is FeedReply => !!x)" :key="r.id" class="reply-line">
          <StatusTag kind="commentReply" :status="r.status" />
          <span class="ellipsis">{{ r.text }}</span>
          <span class="muted small">{{ replyTime(r) }}</span>
          <span v-if="replyError(r)" class="err">{{ replyError(r) }}</span>
          <a v-if="r.hasEvidence" class="small" @click="emit('evidence', r.id)">{{ t('feed.evidence') }}</a>
        </div>
      </div>
      <FoldToggle v-if="p.commentsTotal" :open="expanded.has(p.id)"
        :label="expanded.has(p.id) ? t('feed.collapseComments') : t('feed.expandComments', { n: p.commentsTotal })" @toggle="toggle(p.id)" />
      <div v-if="expanded.has(p.id)" class="comments">
        <div v-for="c in shown(p)" :key="c.id">
          <div v-for="m in [c, ...(c.children ?? [])]" :key="m.id" class="msg" :class="{ child: m.id !== c.id }">
            <div class="meta">
              <b>{{ m.authorHandle ?? m.authorName ?? '—' }}</b>
              <span class="muted">{{ fmt(m.publishedAt) }}</span>
              <span v-if="m.likeCount" class="muted">{{ t('feed.likes', { n: m.likeCount }) }}</span>
              <span v-if="m.replyCount" class="muted">{{ t('comments.expandReplies', { n: m.replyCount }) }}</span>
            </div>
            <div class="text">{{ m.text }}</div>
            <div v-if="m.reply" class="reply-line">
              <StatusTag kind="commentReply" :status="m.reply.status" />
              <span class="ellipsis">{{ m.reply.text }}</span>
              <span class="muted small">{{ replyTime(m.reply) }}</span>
              <span v-if="replyError(m.reply)" class="err">{{ replyError(m.reply) }}</span>
              <a v-if="m.reply.hasEvidence" class="small" @click="emit('evidence', m.reply.id)">{{ t('feed.evidence') }}</a>
            </div>
            <a-button v-if="!readonly && m.id === c.id && canReply(m)" size="small" type="link" class="act" @click="emit('reply', m, p)">{{ t('feed.reply') }}</a-button>
          </div>
        </div>
        <a-button v-if="shown(p).length < p.commentsTotal" size="small" type="link" :loading="loadingMore === p.id" @click="loadMore(p)">{{ t('feed.moreComments') }}</a-button>
      </div>
    </div>
    <a-pagination :current="page" :page-size="pageSize" v-bind="pagination({ total, hideOnSinglePage: true, showSizeChanger: false })" class="pager" @change="(n: number) => emit('page', n)" />
  </a-spin>
</template>

<style scoped>
.post { border: 1px solid var(--cp-border-secondary); border-radius: var(--cp-radius); padding: 10px 12px; margin-bottom: 10px; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; }
.tag { margin: 0; }
.grow { flex: 1; }
.caption {
  margin: 6px 0; white-space: pre-wrap; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.counts { display: flex; flex-wrap: wrap; gap: 12px; font-size: 13px; }
.mine { margin-top: 6px; padding: 4px 8px; background: var(--cp-fill-alter); border-radius: var(--cp-radius); }
.comments { margin-top: 4px; border-top: 1px dashed var(--cp-border-secondary); }
.msg { padding: 4px 0 0; }
.msg.child { margin-left: 24px; border-top: 1px dashed var(--cp-border-secondary); }
.text { white-space: pre-wrap; word-break: break-word; margin: 2px 0; }
.reply-line { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; min-width: 0; }
.reply-line .ellipsis { max-width: 60%; }
.act { padding-inline-start: 0; }
.err { color: var(--cp-error); font-size: 12px; }
.pager { margin-top: 8px; text-align: right; }
</style>
