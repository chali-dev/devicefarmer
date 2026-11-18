<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { Dayjs } from 'dayjs'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { MODAL_WIDTH } from '../common/ui'

/**
 * Write a reply to a comment, or a comment directly under the account's post, and schedule it (default now).
 * No approval: it is sent by the account's cloud phone at that time (test mode: only filled in + screenshot).
 * The text is always typed by the person here; nothing is generated.
 */
export type ReplyTarget =
  | { kind: 'comment'; commentId: string; author: string | null; text: string }
  | { kind: 'post'; accountId: string; postId: string; caption: string | null }
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ target: ReplyTarget | null; halted: boolean; testMode: boolean | null }>()
const emit = defineEmits<{ done: [] }>()
const { t } = useI18n()

const text = ref('')
const mode = ref<'now' | 'at'>('now')
const at = ref<Dayjs | null>(null)
const busy = ref(false)
watch(open, (o) => { if (o) { text.value = ''; mode.value = 'now'; at.value = null } })
const title = computed(() => (props.target?.kind === 'comment' ? t('feed.replyTitle', { author: props.target.author ?? '?' }) : t('feed.commentTitle')))
const quoted = computed(() => (props.target?.kind === 'comment' ? props.target.text : props.target?.caption ?? ''))

async function submit() {
  if (!props.target || !text.value.trim()) { message.warning(t('common.required')); return }
  if (mode.value === 'at' && !at.value) { message.warning(t('common.required')); return }
  const scheduledAt = mode.value === 'at' && at.value ? at.value.toISOString() : null
  busy.value = true
  try {
    if (props.target.kind === 'comment') await api('POST', `/api/comments/${props.target.commentId}/replies`, { text: text.value, submit: true, scheduledAt })
    else await api('POST', `/api/social/accounts/${props.target.accountId}/posts/${props.target.postId}/comments`, { text: text.value, scheduledAt })
    message.success(t('feed.scheduled'))
    open.value = false
    emit('done')
  } catch (e) { message.error(errorText(e)) } finally { busy.value = false }
}
</script>

<template>
  <a-modal v-model:open="open" :title="title" :width="MODAL_WIDTH.sm" :confirm-loading="busy" :ok-text="t('feed.submit')" destroy-on-close @ok="submit">
    <a-alert v-if="halted" type="warning" show-icon class="block" :message="t('feed.halted')" />
    <a-alert v-if="testMode === true" type="info" show-icon class="block" :message="t('feed.testMode')" />
    <a-alert v-else-if="testMode === false" type="warning" show-icon class="block" :message="t('feed.liveMode')" />
    <div v-if="quoted" class="quote">{{ quoted }}</div>
    <a-form layout="vertical">
      <a-form-item :label="t('feed.text')" :extra="t('feed.textHint')" required>
        <a-textarea v-model:value="text" :rows="4" :maxlength="2200" show-count />
      </a-form-item>
      <a-form-item :label="t('feed.when')">
        <a-radio-group v-model:value="mode">
          <a-radio value="now">{{ t('feed.now') }}</a-radio>
          <a-radio value="at">{{ t('feed.at') }}</a-radio>
        </a-radio-group>
        <a-date-picker v-if="mode === 'at'" v-model:value="at" show-time style="width: 100%; margin-top: 8px" />
      </a-form-item>
    </a-form>
    <div class="muted small">{{ t('feed.deviceOnlyReply') }}</div>
  </a-modal>
</template>

<style scoped>
.block { margin-bottom: 12px; }
.quote {
  margin-bottom: 12px; padding: 6px 10px; border-left: 3px solid var(--cp-border-secondary); color: var(--cp-text-secondary);
  white-space: pre-wrap; word-break: break-word; max-height: 6em; overflow: auto; font-size: 13px;
}
</style>
