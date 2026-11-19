<script setup lang="ts">
import { message } from 'ant-design-vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { compactNumber, type AnalyticsPosts } from '../../api/types'
import { dateLocale, fmtDateTime } from '../../i18n'
import { pagination } from '../common/ui'

/**
 * 帖子 tab of the analytics drawer: the account's own posts with per-post likes/comments as stored earlier
 * (history; the automatic account check reads only the profile counters). Links go to the post's permalink.
 */
const props = defineProps<{ accountId: string }>()
const { t, te } = useI18n()
const SORTS = ['published', 'likes', 'comments'] as const
const sort = ref<typeof SORTS[number]>('published')
const page = ref(1)
const pageSize = ref(20)
const data = ref<AnalyticsPosts | null>(null)
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const q = new URLSearchParams({ sort: sort.value, limit: String(pageSize.value), offset: String((page.value - 1) * pageSize.value) })
    data.value = await api<AnalyticsPosts>('GET', `/api/analytics/accounts/${props.accountId}/posts?${q}`)
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
watch(() => props.accountId, () => { page.value = 1; void load() }, { immediate: true })
watch(sort, () => { page.value = 1; void load() })
function onChange(p: { current?: number; pageSize?: number }) {
  if (p.pageSize && p.pageSize !== pageSize.value) { pageSize.value = p.pageSize; page.value = 1 } else page.value = p.current ?? 1
  void load()
}

const typeText = (v: string | null) => (v ? (te(`analytics.posts.types.${v}`) ? t(`analytics.posts.types.${v}`) : v) : null)
const columns = computed(() => [
  { title: t('analytics.posts.colPost'), key: 'post', ellipsis: true },
  { title: t('analytics.posts.colType'), key: 'type', width: 110 },
  { title: t('analytics.posts.colTime'), key: 'time', width: 170 },
  { title: t('analytics.metrics.likes'), key: 'likes', width: 90, align: 'right' as const },
  { title: t('analytics.metrics.comments'), key: 'comments', width: 90, align: 'right' as const },
])
</script>

<template>
  <div class="bar">
    <a-radio-group v-model:value="sort" size="small" button-style="solid">
      <a-radio-button v-for="s in SORTS" :key="s" :value="s">{{ t(`analytics.posts.sort.${s}`) }}</a-radio-button>
    </a-radio-group>
    <span v-if="data && data.total" class="muted">
      {{ t('analytics.posts.summary', { n: data.total, likes: compactNumber(data.likes), comments: compactNumber(data.comments) }) }}
      <template v-if="data.lastFetchedAt"> · {{ t('analytics.posts.lastFetched', { time: fmtDateTime(data.lastFetchedAt) }) }}</template>
    </span>
  </div>
  <a-table :data-source="data?.posts ?? []" :columns="columns" row-key="id" size="small" :loading="loading" :scroll="{ x: 640 }"
    :pagination="pagination({ current: page, pageSize, total: data?.total ?? 0, hideOnSinglePage: true })" :locale="{ emptyText: t('analytics.posts.empty') }" @change="onChange">
    <template #bodyCell="{ column, record }">
      <template v-if="column.key === 'post'">
        <a v-if="record.permalink" :href="record.permalink" target="_blank" rel="noopener noreferrer" :title="record.caption ?? undefined">{{ record.caption || t('analytics.posts.noCaption') }}</a>
        <span v-else :title="record.caption ?? undefined">{{ record.caption || t('analytics.posts.noCaption') }}</span>
        <div v-if="record.publish" class="muted small">{{ t('analytics.posts.colPublish') }}: {{ record.publish.title || record.publish.taskId.slice(0, 8) }}</div>
      </template>
      <template v-else-if="column.key === 'type'">
        <a-tag v-if="typeText(record.productType)">{{ typeText(record.productType) }}</a-tag>
        <span v-if="record.mediaType" class="muted small">{{ typeText(record.mediaType) }}</span>
      </template>
      <template v-else-if="column.key === 'time'">{{ fmtDateTime(record.publishedAt) }}</template>
      <template v-else-if="column.key === 'likes'"><span class="num">{{ record.likes === null ? '—' : record.likes.toLocaleString(dateLocale()) }}</span></template>
      <template v-else-if="column.key === 'comments'"><span class="num">{{ record.comments === null ? '—' : record.comments.toLocaleString(dateLocale()) }}</span></template>
    </template>
  </a-table>
</template>

<style scoped>
.bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
.muted { color: var(--cp-text-tertiary); }
.small { font-size: 12px; }
.num { font-variant-numeric: tabular-nums; }
</style>
