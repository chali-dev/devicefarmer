<script setup lang="ts">
import { dateLocale } from '../../i18n'
import { computed, reactive, ref, watch } from 'vue'
import { message, Modal } from 'ant-design-vue'
import type { Dayjs } from 'dayjs'
import { useI18n } from 'vue-i18n'
import { commentActionText, logText } from '../../api/logText'
import { api, codeText, errorText } from '../../api/client'
import {
  COMMENT_REPLY_STATUS_COLOR, COMMENT_STATUS_COLOR, type CommentItem, type CommentLog, type CommentReplyItem, type CommentRules, type CommentTemplate,
} from '../../api/types'
import { useAuthStore } from '../../stores/auth'
import PlatformTag from '../social/PlatformTag.vue'

/**
 * One comment: its thread, the reply composer (always written by a person, optionally from a template),
 * the current reply's workflow actions (submit, review, cancel, manual outcome) and the history + log.
 */
const props = defineProps<{ open: boolean; commentId: string | null; templates: CommentTemplate[]; rules: CommentRules | null }>()
const emit = defineEmits<{ 'update:open': [boolean]; changed: [] }>()
const { t } = useI18n()
const auth = useAuthStore()

const comment = ref<CommentItem | null>(null)
const thread = ref<CommentItem[]>([])
const replies = ref<CommentReplyItem[]>([])
const logs = ref<CommentLog[]>([])
const mode = ref<{ mode: 'api' | 'manual'; reason: string | null } | null>(null)
const loading = ref(false)
const busy = ref(false)
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
const DONE = ['failed', 'rejected', 'cancelled']

const form = reactive({ text: '', templateId: undefined as string | undefined, at: null as Dayjs | null })
const review = reactive({ note: '', reason: '' })
const outcome = reactive({ result: 'sent' as 'sent' | 'failed', reason: '', externalReplyId: '' })

async function load() {
  if (!props.commentId) return
  loading.value = true
  try {
    const r = await api<{ comment: CommentItem; thread: CommentItem[]; replies: CommentReplyItem[]; logs: CommentLog[]; replyMode: { mode: 'api' | 'manual'; reason: string | null } }>(
      'GET', `/api/comments/${props.commentId}`)
    comment.value = r.comment; thread.value = r.thread; replies.value = r.replies; logs.value = r.logs; mode.value = r.replyMode
    const a = active.value
    form.text = a?.status === 'draft' || (a?.status === 'pending_review' && a.canEdit) ? a.text : ''
    form.templateId = a?.templateId ?? undefined
    form.at = null
    Object.assign(review, { note: '', reason: '' })
    Object.assign(outcome, { result: 'sent', reason: '', externalReplyId: '' })
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
watch(() => [props.open, props.commentId], () => { if (props.open) void load() }, { immediate: true })
defineExpose({ reload: load })

const active = computed(() => replies.value.find((r) => !DONE.includes(r.status)) ?? null)
const history = computed(() => replies.value.filter((r) => r.id !== active.value?.id))
const editing = computed(() => !active.value || active.value.status === 'draft' || (active.value.status === 'pending_review' && active.value.canEdit))
const needsReview = computed(() => !!props.rules?.requireApproval && !auth.isAdmin)
const errText = (code: string | null, raw: string | null) => (code ? codeText(code, undefined, raw ?? code) : raw ?? '')
const modeReason = computed(() => (mode.value?.reason ? codeText(mode.value.reason, { platform: comment.value?.platform ?? '' }, mode.value.reason) : ''))

function pickTemplate(id: string | undefined) {
  const tpl = props.templates.find((x) => x.id === id)
  if (tpl) form.text = tpl.text.replace(/\{name\}/g, comment.value?.authorName ?? '')
}

async function act(fn: () => Promise<unknown>, ok: string) {
  busy.value = true
  try { await fn(); message.success(ok); emit('changed') } catch (e) { message.error(errorText(e)) } finally { busy.value = false; await load() }
}
const at = () => (form.at ? form.at.toISOString() : null)
function save(submit: boolean) {
  const a = active.value
  if (!form.text.trim()) { message.warning(t('errors.comment.text_empty')); return }
  if (!a) {
    return act(() => api('POST', `/api/comments/${props.commentId}/replies`, { text: form.text, templateId: form.templateId ?? null, submit, scheduledAt: at() }),
      submit ? t('comments.submitted') : t('common.saved'))
  }
  return act(async () => {
    await api('PATCH', `/api/comment-replies/${a.id}`, { text: form.text, templateId: form.templateId ?? null, scheduledAt: at() })
    if (submit && a.status === 'draft') await api('POST', `/api/comment-replies/${a.id}/submit`, {})
  }, submit ? t('comments.submitted') : t('common.saved'))
}
const approve = () => act(() => api('POST', `/api/comment-replies/${active.value!.id}/approve`, { note: review.note || null }), t('comments.approved'))
function reject() {
  if (!review.reason.trim()) { message.warning(t('comments.rejectReason')); return }
  void act(() => api('POST', `/api/comment-replies/${active.value!.id}/reject`, { reason: review.reason }), t('comments.rejected'))
}
function cancel() {
  Modal.confirm({
    title: t('comments.cancelConfirm'), okText: t('comments.cancel'), cancelText: t('common.cancel'), okType: 'danger',
    onOk: () => act(() => api('POST', `/api/comment-replies/${active.value!.id}/cancel`), t('comments.cancelled')),
  })
}
function record() {
  if (outcome.result === 'failed' && !outcome.reason.trim()) { message.warning(t('errors.comment.outcome_needs_reason')); return }
  void act(() => api('POST', `/api/comment-replies/${active.value!.id}/outcome`, {
    result: outcome.result, reason: outcome.result === 'failed' ? outcome.reason : null, externalReplyId: outcome.externalReplyId || null,
  }), t('comments.recorded'))
}
async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); message.success(t('comments.copied')) } catch (e) { message.error(errorText(e)) }
}
const people = (r: CommentReplyItem) => [
  r.authorName ? t('comments.writtenBy', { name: r.authorName }) : null,
  r.reviewerName ? t('comments.reviewedBy', { name: r.reviewerName }) : null,
  r.status === 'sent' ? (r.senderName ? t('comments.sentBy', { name: r.senderName }) : t('comments.sentByApi')) : null,
].filter(Boolean).join(' · ')
const LOG_COLOR: Record<string, string> = { debug: 'gray', info: 'blue', warn: 'orange', error: 'red' }
</script>

<template>
  <a-drawer :open="open" :title="t('comments.thread')" width="min(720px, 100vw)" @close="emit('update:open', false)">
    <a-spin :spinning="loading">
      <template v-if="comment">
        <div class="thread">
          <div v-for="c in thread" :key="c.id" class="msg" :class="{ child: !!c.parentExternalId, current: c.id === comment.id }">
            <div class="meta">
              <b>{{ c.authorName ?? '—' }}</b>
              <span v-if="c.authorHandle" class="muted">{{ c.authorHandle }}</span>
              <span class="muted">{{ fmt(c.publishedAt ?? c.createdAt) }}</span>
              <a-tag :color="COMMENT_STATUS_COLOR[c.status]">{{ t(`comments.status.${c.status}`) }}</a-tag>
              <a-tag v-if="c.source === 'manual'">{{ t('comments.sourceManual') }}</a-tag>
            </div>
            <div class="text">{{ c.text }}</div>
          </div>
        </div>
        <a-space wrap style="margin: 8px 0">
          <PlatformTag :platform="comment.platform" />
          <span>@{{ comment.account?.handle }}</span>
          <a v-if="comment.postUrl" :href="comment.postUrl" target="_blank" rel="noopener noreferrer">{{ t('comments.viewPost') }}</a>
          <span v-if="comment.publishTask?.title" class="muted">{{ t('comments.publishedContent', { title: comment.publishTask.title }) }}</span>
          <a-tag v-if="mode" :color="mode.mode === 'api' ? 'blue' : 'orange'" :title="modeReason">{{ mode.mode === 'api' ? t('comments.replyApi') : t('comments.replyManual') }}</a-tag>
        </a-space>

        <a-divider orientation="left">{{ active && !editing ? t('comments.currentReply') : t('comments.composer') }}</a-divider>

        <!-- composer / draft -->
        <template v-if="editing">
          <a-alert type="info" show-icon :message="t('comments.composerHint')" style="margin-bottom: 8px" />
          <a-form layout="vertical">
            <a-form-item :label="t('comments.template')">
              <a-select v-model:value="form.templateId" allow-clear :placeholder="t('comments.noTemplate')" @change="(v: any) => pickTemplate(v as string | undefined)">
                <a-select-option v-for="x in templates" :key="x.id" :value="x.id">{{ x.name }}<span v-if="x.shared" class="muted"> · {{ t('comments.shared') }}</span></a-select-option>
              </a-select>
            </a-form-item>
            <a-form-item :label="t('comments.replyText')" required>
              <a-textarea v-model:value="form.text" :auto-size="{ minRows: 3, maxRows: 10 }" :maxlength="5000" show-count />
            </a-form-item>
            <a-form-item v-if="!active || active.status === 'draft'" :label="t('comments.sendAt')">
              <a-date-picker v-model:value="form.at" show-time style="width: 100%" />
            </a-form-item>
          </a-form>
          <a-space wrap>
            <a-button :loading="busy" @click="save(false)">{{ active?.status === 'pending_review' ? t('common.save') : t('comments.saveDraft') }}</a-button>
            <a-button v-if="!active || active.status === 'draft'" type="primary" :loading="busy" @click="save(true)">{{ t('comments.submit') }}</a-button>
            <span v-if="!active || active.status === 'draft'" class="muted">{{ needsReview ? t('comments.needsReview') : t('comments.noReviewNeeded') }}</span>
            <a-button v-if="active" danger :disabled="busy" @click="cancel">{{ t('comments.cancel') }}</a-button>
          </a-space>
        </template>

        <!-- current reply (not editable here) -->
        <template v-if="active && (!editing || active.status === 'pending_review')">
          <a-descriptions :column="1" size="small" bordered style="margin-top: 8px">
            <a-descriptions-item :label="t('comments.colStatus')">
              <a-tag :color="COMMENT_REPLY_STATUS_COLOR[active.status]">{{ t(`comments.replyStatus.${active.status}`) }}</a-tag>
              <span v-if="active.method" class="muted">{{ t(`comments.method.${active.method}`) }}</span>
              <span v-if="active.scheduledAt && active.status === 'scheduled'" class="muted"> · {{ fmt(active.scheduledAt) }}</span>
            </a-descriptions-item>
            <a-descriptions-item v-if="!editing" :label="t('comments.replyText')"><div class="text">{{ active.text }}</div></a-descriptions-item>
            <a-descriptions-item :label="t('comments.colPeople')">{{ people(active) || '—' }}</a-descriptions-item>
            <a-descriptions-item v-if="active.errorCode && active.status !== 'cancelled'" :label="t('comments.colResult')">
              <span class="err">{{ errText(active.errorCode, active.error) }}</span>
            </a-descriptions-item>
          </a-descriptions>

          <div v-if="active.canReview" class="box">
            <a-input v-model:value="review.note" :placeholder="t('comments.reviewNote')" :maxlength="500" style="margin-bottom: 6px" />
            <a-space wrap>
              <a-button type="primary" :loading="busy" @click="approve">{{ t('comments.approve') }}</a-button>
              <a-input v-model:value="review.reason" :placeholder="t('comments.rejectReason')" :maxlength="1000" style="width: 240px" />
              <a-button danger :loading="busy" @click="reject">{{ t('comments.reject') }}</a-button>
            </a-space>
          </div>

          <div v-if="active.status === 'awaiting_operator'" class="box">
            <a-alert type="warning" show-icon :message="t('comments.operatorHint')" style="margin-bottom: 8px" />
            <a-space wrap style="margin-bottom: 8px">
              <a-button v-if="active.instance?.accessible" @click="$router.push(`/instances/${active.instance.id}`)">
                <a-badge :status="active.instance.online ? 'success' : 'default'" />{{ t('comments.openDevice') }} · {{ active.instance.name }}
              </a-button>
              <span v-else-if="!active.instance" class="muted">{{ t('comments.noDevice') }}</span>
              <a-button @click="copy(active.text)">{{ t('comments.copyText') }}</a-button>
            </a-space>
            <a-form layout="vertical">
              <a-form-item :label="t('comments.outcome')">
                <a-radio-group v-model:value="outcome.result">
                  <a-radio value="sent">{{ t('comments.outcomeSent') }}</a-radio>
                  <a-radio value="failed">{{ t('comments.outcomeFailed') }}</a-radio>
                </a-radio-group>
              </a-form-item>
              <a-form-item v-if="outcome.result === 'failed'" :label="t('comments.outcomeReason')" required>
                <a-input v-model:value="outcome.reason" :maxlength="1000" />
              </a-form-item>
              <a-form-item v-else :label="t('comments.externalReplyId')">
                <a-input v-model:value="outcome.externalReplyId" :maxlength="200" />
              </a-form-item>
              <a-button type="primary" :loading="busy" @click="record">{{ t('comments.outcome') }}</a-button>
            </a-form>
          </div>

          <a-space v-if="!editing && ['approved', 'scheduled', 'awaiting_operator', 'pending_review'].includes(active.status)" style="margin-top: 8px">
            <a-button danger :disabled="busy" @click="cancel">{{ t('comments.cancel') }}</a-button>
          </a-space>
        </template>

        <template v-if="history.length">
          <a-divider orientation="left">{{ t('comments.tabs.history') }}</a-divider>
          <div v-for="r in history" :key="r.id" class="hist">
            <a-tag :color="COMMENT_REPLY_STATUS_COLOR[r.status]">{{ t(`comments.replyStatus.${r.status}`) }}</a-tag>
            <span class="muted">{{ fmt(r.updatedAt) }} · {{ people(r) }}</span>
            <div class="text">{{ r.text }}</div>
            <div v-if="r.reviewNote && r.status === 'rejected'" class="err">{{ t('comments.rejectReason') }}: {{ r.reviewNote }}</div>
            <div v-else-if="r.errorCode && r.status === 'failed'" class="err">{{ errText(r.errorCode, r.error) }}<template v-if="r.errorCode === 'comment.operator_failed' && r.error">: {{ r.error }}</template></div>
          </div>
        </template>

        <a-divider orientation="left">{{ t('comments.logs') }}</a-divider>
        <a-timeline>
          <a-timeline-item v-for="l in logs" :key="l.id" :color="LOG_COLOR[l.level]">
            <span class="muted">{{ fmt(l.at) }}</span> <b>{{ commentActionText(l.action) }}</b>
            <span v-if="l.code"> · {{ errText(l.code, l.message) }}</span>
            <span v-else-if="l.message"> · {{ logText(l.message, l.data) }}</span>
            <span v-if="l.actorName" class="muted"> · {{ l.actorName }}</span>
          </a-timeline-item>
        </a-timeline>
      </template>
    </a-spin>
  </a-drawer>
</template>

<style scoped>
.thread { display: flex; flex-direction: column; gap: 6px; }
.msg { border: 1px solid var(--cp-border-secondary); border-radius: 6px; padding: 6px 8px; }
.msg.child { margin-left: 24px; }
.msg.current { border-color: var(--cp-primary); }
.meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; }
.text { white-space: pre-wrap; word-break: break-word; }
.muted { color: var(--cp-text-tertiary); font-size: 12px; }
.err { color: var(--cp-error); font-size: 12px; }
.box { border: 1px dashed var(--cp-border-secondary); border-radius: 6px; padding: 8px; margin-top: 8px; }
.hist { border-bottom: 1px solid var(--cp-border-secondary); padding: 6px 0; }
</style>
