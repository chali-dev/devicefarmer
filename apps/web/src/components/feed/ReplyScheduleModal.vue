<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { Dayjs } from 'dayjs'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { CommentReplyItem } from '../../api/types'
import { MODAL_WIDTH } from '../common/ui'

/**
 * 排程 of a reply / comment draft (draft first, owner decision 2026-11-18): shows what will happen before anything
 * is queued (which account, which cloud phone, to whom / under which post, the text) and asks for the time (default
 * now). OK = POST /api/comment-replies/:id/submit; the cloud phone (or, if it can't, an operator) then really sends it.
 */
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ reply: CommentReplyItem | null }>()
const emit = defineEmits<{ done: [] }>()
const { t } = useI18n()

const mode = ref<'now' | 'at'>('now')
const at = ref<Dayjs | null>(null)
const busy = ref(false)
watch(open, (o) => { if (o) { mode.value = 'now'; at.value = null } })

const target = computed(() => {
  const r = props.reply
  if (!r) return null
  if (r.comment) return { label: t('feed.preview.replyTo', { author: r.comment.authorHandle ?? r.comment.authorName ?? '?' }), text: r.comment.text }
  if (r.post) return { label: t('feed.preview.underPost'), text: r.post.caption ?? r.post.permalink ?? '' }
  if (r.trackedCommentId) return { label: t('feed.onTrackedComment', { handle: r.trackedPost?.handle ?? '?', author: r.trackedComment?.authorHandle ?? '?' }), text: r.trackedComment?.text ?? t('errors.comment.comment_gone') }
  if (r.trackedPostId || r.trackedPost) return { label: t('feed.onTrackedPost', { handle: r.trackedPost?.handle ?? '?' }), text: r.trackedPost ? (r.trackedPost.caption ?? r.trackedPost.permalink ?? '') : t('errors.comment.post_gone') }
  return null
})

async function submit() {
  const r = props.reply
  if (!r) return
  if (mode.value === 'at' && !at.value) { message.warning(t('common.required')); return }
  busy.value = true
  try {
    await api('POST', `/api/comment-replies/${r.id}/submit`, { scheduledAt: mode.value === 'at' && at.value ? at.value.toISOString() : null })
    message.success(t('feed.scheduled'))
    open.value = false
    emit('done')
  } catch (e) { message.error(errorText(e)) } finally { busy.value = false }
}
</script>

<template>
  <a-modal v-model:open="open" :title="t('feed.scheduleTitle')" :width="MODAL_WIDTH.sm" :confirm-loading="busy" :ok-text="t('feed.submit')" destroy-on-close @ok="submit">
    <template v-if="reply">
      <a-alert type="warning" show-icon class="block" :message="t('feed.preview.live')" />
      <a-descriptions :column="1" size="small" bordered class="block">
        <a-descriptions-item :label="t('feed.preview.account')">@{{ reply.account?.handle ?? '?' }}</a-descriptions-item>
        <a-descriptions-item :label="t('feed.preview.device')">
          <template v-if="reply.instance">
            <a-badge :status="reply.instance.online ? 'success' : 'default'" :text="reply.instance.name" />
            <span v-if="!reply.instance.online" class="muted small"> · {{ t('feed.preview.offline') }}</span>
          </template>
          <span v-else class="muted">{{ t('feed.preview.noDevice') }}</span>
        </a-descriptions-item>
        <a-descriptions-item v-if="target" :label="target.label"><div class="text">{{ target.text }}</div></a-descriptions-item>
        <a-descriptions-item :label="t('feed.text')"><div class="text">{{ reply.text }}</div></a-descriptions-item>
      </a-descriptions>
      <a-form layout="vertical">
        <a-form-item :label="t('feed.when')">
          <a-radio-group v-model:value="mode">
            <a-radio value="now">{{ t('feed.now') }}</a-radio>
            <a-radio value="at">{{ t('feed.at') }}</a-radio>
          </a-radio-group>
          <a-date-picker v-if="mode === 'at'" v-model:value="at" show-time style="width: 100%; margin-top: 8px" />
        </a-form-item>
      </a-form>
    </template>
  </a-modal>
</template>

<style scoped>
.block { margin-bottom: 12px; }
.text { white-space: pre-wrap; word-break: break-word; max-height: 8em; overflow: auto; }
</style>
