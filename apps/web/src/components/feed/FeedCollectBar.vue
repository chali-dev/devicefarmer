<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { codeText } from '../../api/client'
import type { FeedCollectState } from '../../api/types'
import { dateLocale } from '../../i18n'

/** Collection state of an account feed (schedule, last run, queued) + 立即采集; the halted notice. */
const props = defineProps<{ state: FeedCollectState; collecting: boolean }>()
const emit = defineEmits<{ collect: [] }>()
const { t } = useI18n()
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
const last = computed(() => props.state.last)
const lastText = computed(() => {
  const l = last.value
  if (!l) return t('feed.neverCollected')
  const r = (l.result ?? {}) as Record<string, number | string | null>
  if (l.status === 'failed') return t('feed.activity.collectFailed', { msg: codeText(l.errorCode, undefined, l.errorCode ?? '') })
  if (r.outcome === 'skipped') return t('logMsg.text.feedSkipped', { msg: codeText(String(r.code ?? ''), undefined, String(r.code ?? '')) })
  return t('feed.activity.collect', { posts: r.posts ?? 0, newPosts: r.newPosts ?? 0, comments: r.comments ?? 0, newComments: r.newComments ?? 0 })
})
</script>

<template>
  <div class="bar">
    <div class="info">
      <div class="small">
        <span class="muted">{{ t('feed.lastCollect') }}：</span>
        <span v-if="last" class="muted">{{ fmt(last.at) }} · </span>
        <span :class="{ err: last?.status === 'failed' }">{{ lastText }}</span>
      </div>
      <div class="muted small">
        {{ state.settings.hours ? t('feed.schedule', { h: state.settings.hours, posts: state.settings.posts, comments: state.settings.commentsPerPost }) : t('feed.scheduleOff') }}
      </div>
    </div>
    <a-tag v-if="state.pending" color="processing">{{ t('feed.pending') }}</a-tag>
    <a-button :disabled="!!state.unsupported || state.halted || !!state.pending" :loading="collecting" @click="emit('collect')">{{ t('feed.collectNow') }}</a-button>
  </div>
  <a-alert v-if="state.unsupported" type="info" show-icon class="note" :message="codeText(state.unsupported, undefined, t('feed.noDevice'))" />
  <a-alert v-if="state.halted" type="warning" show-icon class="note" :message="t('feed.halted')" />
</template>

<style scoped>
.bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px; margin-bottom: 8px; background: var(--cp-fill-alter); border-radius: var(--cp-radius); }
.info { flex: 1; min-width: 200px; }
.err { color: var(--cp-error); }
.note { margin-bottom: 8px; }
</style>
