<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import type { CommentReplyItem } from '../../api/types'
import { dateLocale } from '../../i18n'
import StatusTag from '../common/StatusTag.vue'
import { confirmDanger, pagination } from '../common/ui'
import FeedReplyModal from './FeedReplyModal.vue'
import ReplyScheduleModal from './ReplyScheduleModal.vue'
import ReplyTarget from './ReplyTarget.vue'

/**
 * 回复记录 of one account feed, shared by both detail drawers: social accounts (`filter` accountId=…: everything the
 * account sent or will send) and tracked accounts (`trackedAccountId=…`: the viewer's own accounts' comments / replies
 * on that tracked account's posts, with the sending account). Draft first (2026-11-18): drafts are listed here with
 * 编辑 / 排程 (preview + time, ReplyScheduleModal) / 删除; filter by 草稿 / 已排程 / 已发送 / 失败.
 */
const props = defineProps<{ filter: string | null; showAccount?: boolean }>()
const emit = defineEmits<{ total: [number]; evidence: [string]; changed: [] }>()
const { t } = useI18n()

const STATUS_GROUPS: Record<string, string> = { draft: 'draft', scheduled: 'scheduled,sending', sent: 'sent', failed: 'failed' }
const status = ref<string>('')
const rows = ref<CommentReplyItem[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
async function load(p = page.value) {
  if (!props.filter) return
  page.value = p
  loading.value = true
  try {
    const s = STATUS_GROUPS[status.value]
    const r = await api<{ items: CommentReplyItem[]; total: number }>('GET', `/api/comment-replies?${props.filter}${s ? `&status=${s}` : ''}&limit=20&offset=${(p - 1) * 20}`)
    rows.value = r.items; total.value = r.total
    if (!s) emit('total', r.total)
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
watch(() => props.filter, () => { rows.value = []; total.value = 0; void load(1) }, { immediate: true })
watch(status, () => load(1))
const reload = () => load()
defineExpose({ reload })

// ---- draft actions
const editOpen = ref(false)
const scheduleOpen = ref(false)
const current = ref<CommentReplyItem | null>(null)
function edit(r: CommentReplyItem) { current.value = r; editOpen.value = true }
function schedule(r: CommentReplyItem) { current.value = r; scheduleOpen.value = true }
function remove(r: CommentReplyItem) {
  confirmDanger({
    title: t('feed.deleteDraftConfirm'), okText: t('common.delete'),
    onOk: async () => {
      try { await api('DELETE', `/api/comment-replies/${r.id}`); message.success(t('common.deleted')); await load(); emit('changed') } catch (e) { message.error(errorText(e)) }
    },
  })
}
const changed = () => { void load(); emit('changed') }

const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
const columns = computed(() => [
  { title: t('comments.colComment'), key: 'target' },
  ...(props.showAccount ? [{ title: t('feed.replyAccount'), key: 'account', width: 150 }] : []),
  { title: t('comments.colReply'), key: 'text' },
  { title: t('comments.colStatus'), key: 'status', width: 170 },
  { title: t('comments.colTime'), key: 'time', width: 170 },
  { title: t('common.action'), key: 'actions', width: 150 },
])
</script>

<template>
  <a-radio-group v-model:value="status" button-style="solid" size="small" class="filter">
    <a-radio-button value="">{{ t('feed.replyFilter.all') }}</a-radio-button>
    <a-radio-button value="draft">{{ t('feed.replyFilter.draft') }}</a-radio-button>
    <a-radio-button value="scheduled">{{ t('feed.replyFilter.scheduled') }}</a-radio-button>
    <a-radio-button value="sent">{{ t('feed.replyFilter.sent') }}</a-radio-button>
    <a-radio-button value="failed">{{ t('feed.replyFilter.failed') }}</a-radio-button>
  </a-radio-group>
  <a-table :data-source="rows" :columns="columns" row-key="id" size="small" :loading="loading" :scroll="{ x: 760 }"
    :pagination="pagination({ current: page, pageSize: 20, total, showSizeChanger: false, hideOnSinglePage: true, onChange: (n: number) => load(n) })">
    <template #bodyCell="{ column, record }">
      <template v-if="column.key === 'target'"><ReplyTarget :reply="record as CommentReplyItem" /></template>
      <template v-else-if="column.key === 'account'">
        <div>@{{ record.account?.handle ?? '?' }}</div>
        <div v-if="record.instance" class="muted small">{{ record.instance.name }}</div>
      </template>
      <template v-else-if="column.key === 'text'"><div class="ellipsis2">{{ record.text }}</div></template>
      <template v-else-if="column.key === 'status'">
        <StatusTag kind="commentReply" :status="record.status" />
        <div v-if="record.method" class="muted small">{{ t(`comments.method.${record.method}`) }}</div>
        <div v-if="record.errorCode && record.status !== 'sent'" class="err">{{ codeText(record.errorCode, undefined, record.error ?? record.errorCode) }}</div>
        <a v-if="record.hasEvidence" class="small" @click="emit('evidence', record.id)">{{ t('feed.evidence') }}</a>
      </template>
      <template v-else-if="column.key === 'time'">
        <div>{{ fmt(record.sentAt ?? record.handedAt ?? record.scheduledAt ?? record.updatedAt) }}</div>
        <div v-if="record.status === 'scheduled' && record.scheduledAt" class="muted small">{{ t('feed.scheduled') }}</div>
      </template>
      <template v-else-if="column.key === 'actions'">
        <a-space v-if="record.status === 'draft'" :size="4" wrap>
          <a-button size="small" type="link" @click="edit(record as CommentReplyItem)">{{ t('common.edit') }}</a-button>
          <a-button size="small" type="link" @click="schedule(record as CommentReplyItem)">{{ t('feed.submit') }}</a-button>
          <a-button size="small" type="link" danger @click="remove(record as CommentReplyItem)">{{ t('common.delete') }}</a-button>
        </a-space>
      </template>
    </template>
  </a-table>
  <FeedReplyModal v-model:open="editOpen" :draft="current" @done="changed" />
  <ReplyScheduleModal v-model:open="scheduleOpen" :reply="current" @done="changed" />
</template>

<style scoped>
.filter { margin-bottom: 8px; }
.err { color: var(--cp-error); font-size: 12px; }
.ellipsis2 { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
</style>
