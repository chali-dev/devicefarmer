<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { codeText } from '../../api/client'
import type { PublishTaskItem } from '../../api/types'
import { dateLocale } from '../../i18n'
import { useAuthStore } from '../../stores/auth'
import StatusTag from '../common/StatusTag.vue'
import { actionColumn, pagination, TABLE_SIZE } from '../common/ui'
import PlatformTag from '../social/PlatformTag.vue'
import PostTypeTag from './PostTypeTag.vue'

/**
 * Publish task list (GET /api/publish/tasks rows), shared by 排程发布 (今日 / 待发布 / 发布记录) and 媒体管理 → 发文日志.
 * `mode`: `queue` shows the device column, `result` the post link / error. Opening a row is the caller's drawer.
 */
const props = defineProps<{
  items: PublishTaskItem[]; total: number; loading: boolean; current: number; pageSize: number
  mode: 'queue' | 'result'; emptyText?: string
}>()
const emit = defineEmits<{ change: [{ current?: number; pageSize?: number }]; open: [id: string] }>()
const { t } = useI18n()
const auth = useAuthStore()

const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
const errText = (x: PublishTaskItem) => (x.errorCode ? codeText(x.errorCode, undefined, x.error ?? x.errorCode) : '')
const columns = computed(() => [
  { title: t('publish.colTime'), key: 'time', width: 170 },
  { title: t('publish.colAccount'), key: 'account', width: 220 },
  { title: t('publish.postType'), key: 'postType', width: 90 },
  { title: t('publish.colContent'), key: 'content', width: 240 },
  { title: t('common.status'), key: 'status', width: 150 },
  ...(props.mode === 'queue' ? [{ title: t('common.device'), key: 'device', width: 160 }] : [{ title: t('publish.result'), key: 'result', width: 220 }]),
  ...(auth.isAdmin ? [{ title: t('content.colOwner'), key: 'owner', width: 110 }] : []),
  actionColumn(90),
])
const scrollX = computed(() => columns.value.reduce((n, c) => n + c.width, 0))
</script>

<template>
  <a-table :data-source="items" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :scroll="{ x: scrollX }"
    :locale="emptyText ? { emptyText } : undefined"
    :pagination="pagination({ current, pageSize, total })" @change="(p: any) => emit('change', p)">
    <template #bodyCell="{ column, record }">
      <template v-if="column.key === 'time'">{{ fmt(record.status === 'published' ? record.publishedAt : record.scheduledAt) }}</template>
      <template v-else-if="column.key === 'account'"><PlatformTag :platform="record.platform" /> @{{ record.account?.handle ?? '—' }}</template>
      <template v-else-if="column.key === 'postType'"><PostTypeTag :type="record.postType" /></template>
      <template v-else-if="column.key === 'content'">
        <a-typography-text :content="record.content?.title ?? '—'" :ellipsis="{ tooltip: record.content?.title }" />
      </template>
      <template v-else-if="column.key === 'status'">
        <StatusTag kind="publish" :status="record.status" />
        <div v-if="record.status === 'pending' && record.errorCode"><a-typography-text type="danger" class="small">{{ errText(record as PublishTaskItem) }}</a-typography-text></div>
      </template>
      <template v-else-if="column.key === 'device'">
        <template v-if="record.instance"><a-badge :status="record.instance.online ? 'success' : 'default'" :text="record.instance.name" /></template>
        <span v-else class="muted">—</span>
      </template>
      <template v-else-if="column.key === 'result'">
        <a v-if="record.url" :href="record.url" target="_blank" rel="noopener noreferrer">{{ t('publish.viewPost') }}</a>
        <span v-else-if="record.externalId">{{ record.externalId }}</span>
        <a-typography-text v-else-if="record.errorCode" type="danger" class="small">{{ errText(record as PublishTaskItem) }}<template v-if="record.errorCode === 'publish.operator_failed' && record.error">: {{ record.error }}</template></a-typography-text>
        <span v-else class="muted">—</span>
      </template>
      <template v-else-if="column.key === 'owner'">{{ record.ownerName ?? '—' }}</template>
      <template v-else-if="column.key === 'ops'">
        <a-button type="link" size="small" @click="emit('open', record.id)">{{ record.status === 'awaiting_operator' ? t('publish.handle') : t('common.view') }}</a-button>
      </template>
    </template>
  </a-table>
</template>
