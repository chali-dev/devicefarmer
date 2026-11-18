<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { Dayjs } from 'dayjs'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { ReplyAccountOption } from '../../api/types'
import { MODAL_WIDTH } from '../common/ui'

/**
 * Write a reply to a comment, or a comment directly under the account's post, and schedule it (default now).
 * No approval: it is sent by the account's cloud phone at that time (test mode: only filled in + screenshot).
 * The text is always typed by the person here; nothing is generated.
 * On a tracked account's post (`tracked-*`) the person also picks which own account (and so which cloud phone) sends it.
 */
export type ReplyTarget =
  | { kind: 'comment'; commentId: string; author: string | null; text: string }
  | { kind: 'post'; accountId: string; postId: string; caption: string | null }
  | { kind: 'tracked-post'; trackedAccountId: string; postId: string; caption: string | null }
  | { kind: 'tracked-comment'; trackedAccountId: string; postId: string; commentId: string; author: string | null; text: string }
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ target: ReplyTarget | null; halted: boolean; testMode: boolean | null }>()
const emit = defineEmits<{ done: [] }>()
const { t } = useI18n()

const text = ref('')
const mode = ref<'now' | 'at'>('now')
const at = ref<Dayjs | null>(null)
const busy = ref(false)
// ---- 评论追踪账号的帖子: which own account sends it (own accounts on a cloud phone, same platform; admins: anyone's)
const tracked = computed(() => props.target?.kind === 'tracked-post' || props.target?.kind === 'tracked-comment')
const accounts = ref<ReplyAccountOption[]>([])
const accountId = ref<string | null>(null)
const accountsLoading = ref(false)
async function loadAccounts() {
  const tg = props.target
  if (!tg || (tg.kind !== 'tracked-post' && tg.kind !== 'tracked-comment')) return
  accountsLoading.value = true
  try {
    accounts.value = (await api<{ items: ReplyAccountOption[] }>('GET', `/api/tracked-accounts/${tg.trackedAccountId}/reply-accounts`)).items
    if (accounts.value.length === 1) accountId.value = accounts.value[0]!.id
  } catch (e) { message.error(errorText(e)) } finally { accountsLoading.value = false }
}
const chosen = computed(() => accounts.value.find((a) => a.id === accountId.value) ?? null)
const accountLabel = (a: ReplyAccountOption) => `@${a.handle} · ${a.instance.name}${a.own ? '' : ` · ${t('feed.accountOwner', { name: a.ownerName ?? '?' })}`}`
const isHalted = computed(() => (tracked.value ? !!chosen.value?.instance.halted : props.halted))

watch(open, (o) => { if (o) { text.value = ''; mode.value = 'now'; at.value = null; accountId.value = null; accounts.value = []; void loadAccounts() } })
const title = computed(() => {
  const tg = props.target
  return tg?.kind === 'comment' || tg?.kind === 'tracked-comment' ? t('feed.replyTitle', { author: tg.author ?? '?' }) : t('feed.commentTitle')
})
const quoted = computed(() => {
  const tg = props.target
  return tg?.kind === 'comment' || tg?.kind === 'tracked-comment' ? tg.text : tg?.caption ?? ''
})

async function submit() {
  if (!props.target || !text.value.trim()) { message.warning(t('common.required')); return }
  if (mode.value === 'at' && !at.value) { message.warning(t('common.required')); return }
  if (tracked.value && !accountId.value) { message.warning(t('feed.pickAccount')); return }
  const scheduledAt = mode.value === 'at' && at.value ? at.value.toISOString() : null
  busy.value = true
  try {
    const tg = props.target
    if (tg.kind === 'comment') await api('POST', `/api/comments/${tg.commentId}/replies`, { text: text.value, submit: true, scheduledAt })
    else if (tg.kind === 'post') await api('POST', `/api/social/accounts/${tg.accountId}/posts/${tg.postId}/comments`, { text: text.value, scheduledAt })
    else if (tg.kind === 'tracked-post') await api('POST', `/api/tracked-accounts/${tg.trackedAccountId}/posts/${tg.postId}/comments`, { accountId: accountId.value, text: text.value, scheduledAt })
    else await api('POST', `/api/tracked-accounts/${tg.trackedAccountId}/posts/${tg.postId}/comments/${tg.commentId}/replies`, { accountId: accountId.value, text: text.value, scheduledAt })
    message.success(t('feed.scheduled'))
    open.value = false
    emit('done')
  } catch (e) { message.error(errorText(e)) } finally { busy.value = false }
}
</script>

<template>
  <a-modal v-model:open="open" :title="title" :width="MODAL_WIDTH.sm" :confirm-loading="busy" :ok-text="t('feed.submit')" destroy-on-close @ok="submit">
    <a-alert v-if="isHalted" type="warning" show-icon class="block" :message="t('feed.halted')" />
    <a-alert v-if="testMode === true" type="info" show-icon class="block" :message="t('feed.testMode')" />
    <a-alert v-else-if="testMode === false" type="warning" show-icon class="block" :message="t('feed.liveMode')" />
    <div v-if="quoted" class="quote">{{ quoted }}</div>
    <a-form layout="vertical">
      <a-form-item v-if="tracked" :label="t('feed.replyAccount')" :extra="t('feed.replyAccountHint')" required>
        <a-select v-model:value="accountId" :loading="accountsLoading" :placeholder="t('feed.pickAccount')" :not-found-content="t('feed.noReplyAccounts')"
          show-search :filter-option="(input: string, opt: any) => String(opt.label ?? '').toLowerCase().includes(input.toLowerCase())"
          :options="accounts.map((a) => ({ value: a.id, label: accountLabel(a) }))" />
        <div v-if="chosen && !chosen.instance.online" class="muted small">{{ t('feed.accountOffline') }}</div>
      </a-form-item>
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
    <div class="muted small">{{ tracked ? t('feed.trackedReplyHint') : t('feed.deviceOnlyReply') }}</div>
  </a-modal>
</template>

<style scoped>
.block { margin-bottom: 12px; }
.quote {
  margin-bottom: 12px; padding: 6px 10px; border-left: 3px solid var(--cp-border-secondary); color: var(--cp-text-secondary);
  white-space: pre-wrap; word-break: break-word; max-height: 6em; overflow: auto; font-size: 13px;
}
</style>
