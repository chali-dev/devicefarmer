<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { codeText } from '../../api/client'
import type { PublishStatus } from '../../api/types'
import { dateLocale } from '../../i18n'
import StatusTag from '../common/StatusTag.vue'

/**
 * Earlier publish tasks of one content + account (编辑后重新发布 leaves the failed one + a new one), always shown
 * (no fold): status · time · reason · 查看, aligned like a small table under the newest task. Shared by the content
 * editor's 发布任务 list and the publish task table (发文日志 / 排程发布). At most `max` rows; the rest is a
 * 「还有 N 条」 link (`more`: the caller opens the newest task's drawer, whose 发布记录 lists all of them).
 */
type Attempt = { id: string; status: PublishStatus; errorCode: string | null; error: string | null; publishedAt: string | null; updatedAt: string }
const props = withDefaults(defineProps<{ attempts: Attempt[]; total?: number; max?: number }>(), { total: undefined, max: 5 })
const emit = defineEmits<{ open: [id: string]; more: [] }>()
const { t } = useI18n()

const shown = computed(() => props.attempts.slice(0, props.max))
const rest = computed(() => Math.max(0, (props.total ?? props.attempts.length) - shown.value.length))
const fmt = (d: string) => new Date(d).toLocaleString(dateLocale())
const reason = (a: Attempt) => (a.errorCode ? codeText(a.errorCode, undefined, a.error ?? a.errorCode) : '')
</script>

<template>
  <div class="attempts">
    <div v-for="a in shown" :key="a.id" class="attempt">
      <span class="st"><StatusTag kind="publish" :status="a.status" /></span>
      <span class="time muted">{{ fmt(a.publishedAt ?? a.updatedAt) }}</span>
      <a-typography-text class="reason" :type="a.errorCode ? 'danger' : 'secondary'" :content="reason(a) || '—'" :ellipsis="{ tooltip: reason(a) || undefined }" />
      <a class="act" @click="emit('open', a.id)">{{ t('common.view') }}</a>
    </div>
    <a v-if="rest" class="more" @click="emit('more')">{{ t('publish.moreAttempts', { n: rest }) }}</a>
  </div>
</template>

<style scoped>
.attempts {
  container-type: inline-size;
  border-left: 2px solid var(--cp-border);
  padding: 2px 0 2px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.attempt {
  display: grid;
  grid-template-columns: 72px 150px minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 12px;
  min-height: 24px;
}
.st :deep(.ant-tag) { margin: 0; }
.time { white-space: nowrap; font-variant-numeric: tabular-nums; }
.reason { font-size: 12px; min-width: 0; }
.act, .more { white-space: nowrap; }
.more { align-self: flex-start; }
/* Narrow (phone / narrow drawer): reason on its own line under status + time. */
@container (max-width: 420px) {
  .attempt { grid-template-columns: 72px minmax(0, 1fr) auto; row-gap: 2px; }
  .reason { grid-column: 1 / -1; grid-row: 2; }
  .act { grid-column: 3; grid-row: 1; }
}
</style>
