<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { codeText } from '../../api/client'
import type { PersonaDraftRun } from '../../api/types'
import { dateLocale } from '../../i18n'

/** One 人设每日草稿 generation task: time, trigger (每日/手动), status, drafts created or the error (内容设定 drawer, 人设 page). */
defineProps<{ run: PersonaDraftRun }>()
const { t, te } = useI18n()
const triggerText = (x: string | null) => (x && te(`scripts.drafts.runTrigger.${x}`) ? t(`scripts.drafts.runTrigger.${x}`) : x ?? '')
const statusText = (x: string) => (te(`tasks.status.${x}`) ? t(`tasks.status.${x}`) : x)
</script>

<template>
  <span class="run">
    <span class="muted small">{{ new Date(run.createdAt).toLocaleString(dateLocale()) }}</span>
    <a-tag>{{ triggerText(run.trigger) }}</a-tag>
    <a-tag :color="run.status === 'success' ? 'success' : run.status === 'failed' ? 'error' : 'processing'">{{ statusText(run.status) }}</a-tag>
    <span v-if="run.created !== null" class="small">{{ t('scripts.drafts.runCreated', { n: run.created }) }}</span>
    <span v-if="run.errorCode" class="small err">{{ codeText(run.errorCode, undefined, run.errorCode) }}</span>
  </span>
</template>

<style scoped>
.run { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.run :deep(.ant-tag) { margin-inline-end: 0; }
.err { color: var(--cp-error); }
</style>
