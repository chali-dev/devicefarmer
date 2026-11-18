<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { codeText } from '../../api/client'
import type { FeedActivity } from '../../api/types'
import { dateLocale } from '../../i18n'
import StatusTag from '../common/StatusTag.vue'

/** 动态: counter changes (automatic check / collector), new posts seen, collection runs, replies, newest first. */
defineProps<{ items: FeedActivity[] }>()
const { t } = useI18n()
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
const n = (v: number | null) => (v === null ? '—' : v.toLocaleString(dateLocale()))
const d = (v: number | null) => (v === null || v === 0 ? '' : ` (${v > 0 ? '+' : ''}${v.toLocaleString(dateLocale())})`)
const color = (a: FeedActivity) => (a.type === 'collect' && a.status === 'failed' ? 'red' : a.type === 'post' ? 'green' : a.type === 'reply' ? 'blue' : 'gray')
</script>

<template>
  <a-empty v-if="!items.length" :description="t('feed.noActivity')" />
  <a-timeline v-else class="timeline">
    <a-timeline-item v-for="(a, i) in items" :key="`${a.type}-${a.at}-${i}`" :color="color(a)">
      <div class="muted small">{{ fmt(a.at) }}</div>
      <template v-if="a.type === 'stats'">
        <span>{{ t('feed.activity.stats', { followers: n(a.followers) + d(a.delta.followers), following: n(a.following) + d(a.delta.following), posts: n(a.posts) + d(a.delta.posts) }) }}</span>
        <span v-if="a.approx.length" class="muted small"> · {{ t('feed.approx') }}</span>
      </template>
      <template v-else-if="a.type === 'post'">
        <span>{{ t('feed.activity.post') }}</span>
        <a v-if="a.permalink" :href="a.permalink" target="_blank" rel="noopener noreferrer" class="small"> {{ t('feed.openPost') }}</a>
        <div v-if="a.caption" class="ellipsis muted">{{ a.caption }}</div>
      </template>
      <template v-else-if="a.type === 'collect'">
        <span v-if="a.status === 'failed'" class="err">{{ t('feed.activity.collectFailed', { msg: codeText(a.errorCode, undefined, a.errorCode ?? '') }) }}</span>
        <span v-else-if="a.outcome === 'skipped'" class="muted">{{ t('logMsg.text.feedSkipped', { msg: codeText(a.errorCode, undefined, '') }) }}</span>
        <span v-else>{{ t('feed.activity.collect', { posts: a.posts ?? 0, newPosts: a.newPosts ?? 0, comments: a.comments ?? 0, newComments: a.newComments ?? 0 }) }}</span>
      </template>
      <template v-else-if="a.type === 'reply'">
        <span>{{ t('feed.activity.reply') }} </span><StatusTag kind="commentReply" :status="a.status" />
        <div class="ellipsis muted">{{ a.text }}</div>
      </template>
    </a-timeline-item>
  </a-timeline>
</template>

<style scoped>
.timeline { padding-top: 8px; }
.err { color: var(--cp-error); }
</style>
