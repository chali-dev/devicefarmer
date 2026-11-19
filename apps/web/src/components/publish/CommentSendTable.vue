<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { codeText } from '../../api/client'
import type { CommentReplyItem } from '../../api/types'
import { dateLocale } from '../../i18n'
import { useAuthStore } from '../../stores/auth'
import StatusTag from '../common/StatusTag.vue'
import { actionColumn, pagination, TABLE_SIZE } from '../common/ui'
import ReplyTarget from '../feed/ReplyTarget.vue'
import { replyKind, replyParked, replyTime } from '../feed/replyKind'
import PlatformTag from '../social/PlatformTag.vue'

/**
 * 排程发布 → scheduled comment sends (GET /api/comment-replies rows, never drafts) under the publish tasks of
 * 今日发布 / 待发布队列 / 发布记录. Opening a row is the caller's (the comment drawer / the account's 回复记录).
 */
defineProps<{ items: CommentReplyItem[]; total: number; loading: boolean; current: number; pageSize: number }>()
const emit = defineEmits<{ change: [{ current?: number; pageSize?: number }]; open: [r: CommentReplyItem] }>()
const { t } = useI18n()
const auth = useAuthStore()

const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
const columns = computed(() => [
  { title: t('publish.colTime'), key: 'time', width: 170 },
  { title: t('publish.colAccount'), key: 'account', width: 200 },
  { title: t('publish.postType'), key: 'kind', width: 80 },
  { title: t('publish.sendTarget'), key: 'target', width: 240 },
  { title: t('feed.text'), key: 'text', width: 240 },
  { title: t('common.status'), key: 'status', width: 200 },
  ...(auth.isAdmin ? [{ title: t('content.colOwner'), key: 'owner', width: 110 }] : []),
  actionColumn(90),
])
const scrollX = computed(() => columns.value.reduce((n, c) => n + c.width, 0))
</script>

<template>
  <a-table :data-source="items" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :scroll="{ x: scrollX }"
    :pagination="pagination({ current, pageSize, total, hideOnSinglePage: true })" @change="(p: any) => emit('change', p)">
    <template #bodyCell="{ column, record }">
      <template v-if="column.key === 'time'">{{ fmt(replyTime(record as CommentReplyItem)) }}</template>
      <template v-else-if="column.key === 'account'"><PlatformTag :platform="record.platform" /> @{{ record.account?.handle ?? '—' }}</template>
      <template v-else-if="column.key === 'kind'"><a-tag color="cyan" class="kind">{{ t(`publish.sendType.${replyKind(record as CommentReplyItem)}`) }}</a-tag></template>
      <template v-else-if="column.key === 'target'"><ReplyTarget :reply="record as CommentReplyItem" /></template>
      <template v-else-if="column.key === 'text'"><a-typography-text :content="record.text" :ellipsis="{ tooltip: record.text }" /></template>
      <template v-else-if="column.key === 'status'">
        <StatusTag kind="commentReply" :status="record.status" />
        <div v-if="record.errorCode && (record.status === 'failed' || replyParked(record as CommentReplyItem) || record.status === 'awaiting_operator')">
          <a-typography-text :type="record.status === 'failed' ? 'danger' : 'warning'" class="small">{{ codeText(record.errorCode, undefined, record.error ?? record.errorCode) }}</a-typography-text>
        </div>
      </template>
      <template v-else-if="column.key === 'owner'">{{ record.ownerName ?? '—' }}</template>
      <template v-else-if="column.key === 'ops'">
        <a-button type="link" size="small" @click="emit('open', record as CommentReplyItem)">{{ t('common.view') }}</a-button>
      </template>
    </template>
  </a-table>
</template>

<style scoped>
.kind { margin-inline-end: 0; }
</style>
