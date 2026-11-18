<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { codeText } from '../../api/client'
import type { PersonaDraftRun } from '../../api/types'
import { dateLocale } from '../../i18n'

/** One daily AI draft task: time, trigger, status, drafts created, the skip reason or the error (社交号 → AI 草稿). */
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
    <span v-if="run.skipped" class="small muted">{{ t('scripts.drafts.runSkipped', { reason: codeText(run.skipped, undefined, run.skipped) }) }}</span>
    <span v-if="run.errorCode" class="small err">{{ codeText(run.errorCode, undefined, run.errorCode) }}</span>
  </span>
</template>

<style scoped>
.run { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.run :deep(.ant-tag) { margin-inline-end: 0; }
.err { color: var(--cp-error); }
</style>
