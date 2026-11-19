<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { CommentReplyItem } from '../../api/types'

/** What a reply / comment send answers: the comment (author + text), the own post, or a tracked account's post / comment. */
defineProps<{ reply: CommentReplyItem }>()
const { t } = useI18n()
</script>

<template>
  <template v-if="reply.comment">
    <div class="muted small">@{{ reply.comment.authorHandle ?? reply.comment.authorName }}</div>
    <div class="ellipsis2">{{ reply.comment.text }}</div>
  </template>
  <template v-else-if="reply.post">
    <div class="muted small">{{ t('feed.onPost') }}</div>
    <div class="ellipsis2">{{ reply.post.caption ?? reply.post.permalink }}</div>
  </template>
  <template v-else-if="reply.trackedCommentId">
    <div class="muted small">{{ t('feed.onTrackedComment', { handle: reply.trackedPost?.handle ?? '?', author: reply.trackedComment?.authorHandle ?? '?' }) }}</div>
    <div class="ellipsis2">{{ reply.trackedComment?.text ?? t('errors.comment.comment_gone') }}</div>
  </template>
  <template v-else-if="reply.trackedPostId || reply.trackedPost">
    <div class="muted small">{{ t('feed.onTrackedPost', { handle: reply.trackedPost?.handle ?? '?' }) }}</div>
    <div class="ellipsis2">{{ reply.trackedPost ? (reply.trackedPost.caption ?? reply.trackedPost.permalink) : t('errors.comment.post_gone') }}</div>
  </template>
</template>

<style scoped>
.ellipsis2 { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
</style>
