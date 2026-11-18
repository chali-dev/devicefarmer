<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import type { CommentReplyItem } from '../../api/types'
import { dateLocale } from '../../i18n'
import StatusTag from '../common/StatusTag.vue'
import { pagination } from '../common/ui'

/**
 * 回复记录 of one account feed (state, time, result, test-mode runs, screenshot), shared by both detail drawers:
 * social accounts (`filter` accountId=…: everything the account sent) and tracked accounts (`trackedAccountId=…`: the
 * viewer's own accounts' comments / replies on that tracked account's posts, with the sending account).
 */
const props = defineProps<{ filter: string | null; showAccount?: boolean }>()
const emit = defineEmits<{ total: [number]; evidence: [string] }>()
const { t } = useI18n()

const rows = ref<CommentReplyItem[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
async function load(p = page.value) {
  if (!props.filter) return
  page.value = p
  loading.value = true
  try {
    const r = await api<{ items: CommentReplyItem[]; total: number }>('GET', `/api/comment-replies?${props.filter}&limit=20&offset=${(p - 1) * 20}`)
    rows.value = r.items; total.value = r.total
    emit('total', r.total)
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
watch(() => props.filter, () => { rows.value = []; total.value = 0; void load(1) }, { immediate: true })
defineExpose({ reload: () => load() })

const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
const columns = computed(() => [
  { title: t('comments.colComment'), key: 'target' },
  ...(props.showAccount ? [{ title: t('feed.replyAccount'), key: 'account', width: 150 }] : []),
  { title: t('comments.colReply'), key: 'text' },
  { title: t('comments.colStatus'), key: 'status', width: 170 },
  { title: t('comments.colTime'), key: 'time', width: 170 },
])
</script>

<template>
  <a-table :data-source="rows" :columns="columns" row-key="id" size="small" :loading="loading" :scroll="{ x: 640 }"
    :pagination="pagination({ current: page, pageSize: 20, total, showSizeChanger: false, hideOnSinglePage: true, onChange: (n: number) => load(n) })">
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
        <template v-else-if="record.trackedCommentId">
          <div class="muted small">{{ t('feed.onTrackedComment', { handle: record.trackedPost?.handle ?? '?', author: record.trackedComment?.authorHandle ?? '?' }) }}</div>
          <div class="ellipsis2">{{ record.trackedComment?.text ?? t('errors.comment.comment_gone') }}</div>
        </template>
        <template v-else-if="record.trackedPostId || record.trackedPost">
          <div class="muted small">{{ t('feed.onTrackedPost', { handle: record.trackedPost?.handle ?? '?' }) }}</div>
          <div class="ellipsis2">{{ record.trackedPost ? (record.trackedPost.caption ?? record.trackedPost.permalink) : t('errors.comment.post_gone') }}</div>
        </template>
      </template>
      <template v-else-if="column.key === 'account'">
        <div>@{{ record.account?.handle ?? '?' }}</div>
        <div v-if="record.instance" class="muted small">{{ record.instance.name }}</div>
      </template>
      <template v-else-if="column.key === 'text'"><div class="ellipsis2">{{ record.text }}</div></template>
      <template v-else-if="column.key === 'status'">
        <StatusTag kind="commentReply" :status="record.status" />
        <div v-if="record.method" class="muted small">{{ t(`comments.method.${record.method}`) }}</div>
        <div v-if="record.errorCode && !['sent', 'dry_run'].includes(record.status)" class="err">{{ codeText(record.errorCode, undefined, record.error ?? record.errorCode) }}</div>
        <a v-if="record.hasEvidence" class="small" @click="emit('evidence', record.id)">{{ t('feed.evidence') }}</a>
      </template>
      <template v-else-if="column.key === 'time'">
        <div>{{ fmt(record.sentAt ?? record.handedAt ?? record.scheduledAt ?? record.updatedAt) }}</div>
        <div v-if="record.status === 'scheduled' && record.scheduledAt" class="muted small">{{ t('feed.scheduled') }}</div>
      </template>
    </template>
  </a-table>
</template>

<style scoped>
.err { color: var(--cp-error); font-size: 12px; }
.ellipsis2 { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
</style>
