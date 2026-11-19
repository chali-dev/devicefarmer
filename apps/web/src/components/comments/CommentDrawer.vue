<script setup lang="ts">
import { dateLocale } from '../../i18n'
import { computed, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { commentActionText, logText } from '../../api/logText'
import { api, codeText, errorText } from '../../api/client'
import type { CommentItem, CommentLog, CommentReplyItem } from '../../api/types'
import PlatformTag from '../social/PlatformTag.vue'
import StatusTag from '../common/StatusTag.vue'
import { confirmDanger, DRAWER_WIDTH } from '../common/ui'
import PersonaCard from './PersonaCard.vue'
import ReplyScheduleModal from '../feed/ReplyScheduleModal.vue'

/**
 * One comment: its thread, the reply composer (always written by a person, optionally started from one of the account
 * persona's 评论范例; the persona card shows 定位, the 评论风格 and 禁用词 and flags banned words and an off-range length),
 * the current reply's workflow actions and the history + log. Draft first (owner decision 2026-11-18): the composer only
 * saves a draft; 排程 (preview: account, phone, comment, text + time) queues it, 删除 drops the draft. No approval step.
 */
const props = defineProps<{ open: boolean; commentId: string | null }>()
const emit = defineEmits<{ 'update:open': [boolean]; changed: [] }>()
const { t } = useI18n()

const comment = ref<CommentItem | null>(null)
const thread = ref<CommentItem[]>([])
const replies = ref<CommentReplyItem[]>([])
const logs = ref<CommentLog[]>([])
const loading = ref(false)
const busy = ref(false)
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
const DONE = ['failed', 'cancelled']

const form = reactive({ text: '', templateId: undefined as string | undefined })
const outcome = reactive({ result: 'sent' as 'sent' | 'failed', reason: '', externalReplyId: '' })

async function load() {
  if (!props.commentId) return
  loading.value = true
  try {
    const r = await api<{ comment: CommentItem; thread: CommentItem[]; replies: CommentReplyItem[]; logs: CommentLog[] }>(
      'GET', `/api/comments/${props.commentId}`)
    comment.value = r.comment; thread.value = r.thread; replies.value = r.replies; logs.value = r.logs
    const a = active.value
    form.text = a?.status === 'draft' ? a.text : ''
    form.templateId = a?.templateId ?? undefined
    Object.assign(outcome, { result: 'sent', reason: '', externalReplyId: '' })
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
watch(() => [props.open, props.commentId], () => { if (props.open) void load() }, { immediate: true })
defineExpose({ reload: load })

const active = computed(() => replies.value.find((r) => !DONE.includes(r.status)) ?? null)
const history = computed(() => replies.value.filter((r) => r.id !== active.value?.id))
const editing = computed(() => !active.value || active.value.status === 'draft')
const errText = (code: string | null, raw: string | null) => (code ? codeText(code, undefined, raw ?? code) : raw ?? '')

/** A 评论范例 inserted from the persona card ({name} = the comment's author); remembered as the reply's template. */
function insertExample(text: string, id: string) {
  form.text = text.replace(/\{name\}/g, comment.value?.authorName ?? '')
  form.templateId = id
}

async function act(fn: () => Promise<unknown>, ok: string) {
  busy.value = true
  try { await fn(); message.success(ok); emit('changed') } catch (e) { message.error(errorText(e)) } finally { busy.value = false; await load() }
}
function save() {
  const a = active.value
  if (!form.text.trim()) { message.warning(t('errors.comment.text_empty')); return }
  if (!a) return act(() => api('POST', `/api/comments/${props.commentId}/replies`, { text: form.text, templateId: form.templateId ?? null }), t('feed.draftSaved'))
  return act(() => api('PATCH', `/api/comment-replies/${a.id}`, { text: form.text, templateId: form.templateId ?? null }), t('common.saved'))
}
// 排程 of the saved draft (unsaved edits must be saved first, so the preview shows what will be sent)
const scheduleOpen = ref(false)
const dirty = computed(() => !!active.value && active.value.status === 'draft' && form.text !== active.value.text)
function schedule() {
  if (dirty.value) { message.warning(t('feed.saveFirst')); return }
  scheduleOpen.value = true
}
async function scheduled() { emit('changed'); await load() }
function removeDraft() {
  confirmDanger({
    title: t('feed.deleteDraftConfirm'),
    onOk: () => act(() => api('DELETE', `/api/comment-replies/${active.value!.id}`), t('common.deleted')),
  })
}
function cancel() {
  confirmDanger({
    title: t('comments.cancelConfirm'), okText: t('comments.cancel'),
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
  r.status === 'sent' ? (r.senderName ? t('comments.sentBy', { name: r.senderName }) : t('comments.sentByApi')) : null,
].filter(Boolean).join(' · ')
const LOG_COLOR: Record<string, string> = { debug: 'gray', info: 'blue', warn: 'orange', error: 'red' }
</script>

<template>
  <a-drawer :open="open" :title="t('comments.thread')" :width="DRAWER_WIDTH.lg" @close="emit('update:open', false)">
    <a-spin :spinning="loading">
      <template v-if="comment">
        <div class="thread">
          <div v-for="c in thread" :key="c.id" class="msg" :class="{ child: !!c.parentExternalId, current: c.id === comment.id }">
            <div class="meta">
              <b>{{ c.authorName ?? '—' }}</b>
              <span v-if="c.authorHandle" class="muted small">{{ c.authorHandle }}</span>
              <span class="muted small">{{ fmt(c.publishedAt ?? c.createdAt) }}</span>
              <StatusTag kind="comment" :status="c.status" />
              <a-tag v-if="c.source === 'manual'">{{ t('comments.sourceManual') }}</a-tag>
            </div>
            <div class="text">{{ c.text }}</div>
          </div>
        </div>
        <a-space wrap class="gap" style="margin-top: 8px">
          <PlatformTag :platform="comment.platform" />
          <span>@{{ comment.account?.handle }}</span>
          <a v-if="comment.postUrl" :href="comment.postUrl" target="_blank" rel="noopener noreferrer">{{ t('comments.viewPost') }}</a>
          <span v-if="comment.publishTask?.title" class="muted small">{{ t('comments.publishedContent', { title: comment.publishTask.title }) }}</span>
          <a-tag color="orange">{{ t('comments.replyManual') }}</a-tag>
        </a-space>

        <a-divider orientation="left" plain>{{ active && !editing ? t('comments.currentReply') : t('comments.composer') }}</a-divider>

        <!-- composer / draft -->
        <template v-if="editing">
          <PersonaCard :persona-id="comment.account?.personaId" kind="comment" :text="form.text" insertable
            @insert="insertExample" />
          <a-form layout="vertical">
            <a-form-item :label="t('comments.replyText')" required>
              <a-textarea v-model:value="form.text" :auto-size="{ minRows: 3, maxRows: 10 }" :maxlength="5000" show-count />
            </a-form-item>
          </a-form>
          <a-space wrap>
            <a-button type="primary" :loading="busy" @click="save">{{ t('comments.saveDraft') }}</a-button>
            <template v-if="active?.status === 'draft'">
              <a-button :disabled="busy" @click="schedule">{{ t('feed.submit') }}</a-button>
              <a-button danger :disabled="busy" @click="removeDraft">{{ t('common.delete') }}</a-button>
            </template>
            <a-button v-else-if="active" danger :disabled="busy" @click="cancel">{{ t('comments.cancel') }}</a-button>
          </a-space>
          <div class="muted small hint">{{ active?.status === 'draft' ? t('feed.draftScheduleHint') : t('feed.draftHint') }}</div>
        </template>

        <!-- current reply (not editable here) -->
        <template v-if="active && !editing">
          <a-descriptions :column="1" size="small" bordered style="margin-top: 8px">
            <a-descriptions-item :label="t('comments.colStatus')">
              <StatusTag kind="commentReply" :status="active.status" />
              <span v-if="active.method" class="muted small">{{ t(`comments.method.${active.method}`) }}</span>
              <span v-if="active.scheduledAt && active.status === 'scheduled'" class="muted small"> · {{ fmt(active.scheduledAt) }}</span>
            </a-descriptions-item>
            <a-descriptions-item v-if="!editing" :label="t('comments.replyText')"><div class="text">{{ active.text }}</div></a-descriptions-item>
            <a-descriptions-item :label="t('comments.colPeople')">{{ people(active) || '—' }}</a-descriptions-item>
            <a-descriptions-item v-if="active.errorCode && active.status !== 'cancelled'" :label="t('comments.colResult')">
              <span class="err">{{ errText(active.errorCode, active.error) }}</span>
            </a-descriptions-item>
          </a-descriptions>

          <div v-if="active.status === 'awaiting_operator'" class="box">
            <a-alert type="warning" show-icon :message="t('comments.operatorHint')" class="gap" />
            <a-space wrap style="margin-bottom: 8px">
              <a-button v-if="active.instance?.accessible" @click="$router.push(`/instances/${active.instance.id}`)">
                <a-badge :status="active.instance.online ? 'success' : 'default'" />{{ t('comments.openDevice') }} · {{ active.instance.name }}
              </a-button>
              <span v-else-if="!active.instance" class="muted small">{{ t('comments.noDevice') }}</span>
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

          <a-space v-if="!editing && ['scheduled', 'awaiting_operator'].includes(active.status)" style="margin-top: 8px">
            <a-button danger :disabled="busy" @click="cancel">{{ t('comments.cancel') }}</a-button>
          </a-space>
        </template>

        <template v-if="history.length">
          <a-divider orientation="left" plain>{{ t('comments.tabs.history') }}</a-divider>
          <div v-for="r in history" :key="r.id" class="hist">
            <StatusTag kind="commentReply" :status="r.status" />
            <span class="muted small">{{ fmt(r.updatedAt) }} · {{ people(r) }}</span>
            <div class="text">{{ r.text }}</div>
            <div v-if="r.errorCode && r.status === 'failed'" class="err">{{ errText(r.errorCode, r.error) }}<template v-if="r.errorCode === 'comment.operator_failed' && r.error">: {{ r.error }}</template></div>
          </div>
        </template>

        <a-divider orientation="left" plain>{{ t('comments.logs') }}</a-divider>
        <a-timeline>
          <a-timeline-item v-for="l in logs" :key="l.id" :color="LOG_COLOR[l.level]">
            <span class="muted small">{{ fmt(l.at) }}</span> <b>{{ commentActionText(l.action) }}</b>
            <span v-if="l.code"> · {{ errText(l.code, l.message) }}</span>
            <span v-else-if="l.message"> · {{ logText(l.message, l.data) }}</span>
            <span v-if="l.actorName" class="muted small"> · {{ l.actorName }}</span>
          </a-timeline-item>
        </a-timeline>
      </template>
    </a-spin>
  </a-drawer>
  <ReplyScheduleModal v-model:open="scheduleOpen" :reply="active" @done="scheduled" />
</template>

<style scoped>
.thread { display: flex; flex-direction: column; gap: 6px; }
.msg { border: 1px solid var(--cp-border-secondary); border-radius: var(--cp-radius); padding: 8px 12px; }
.msg.child { margin-left: 24px; }
.msg.current { border-color: var(--cp-primary); }
.meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; }
.text { white-space: pre-wrap; word-break: break-word; }
.err { color: var(--cp-error); font-size: 12px; }
.box { border: 1px solid var(--cp-border-secondary); border-radius: var(--cp-radius); background: var(--cp-fill-alter); padding: 12px; margin-top: 12px; }
.gap { margin-bottom: 12px; }
.hist { border-bottom: 1px solid var(--cp-border-secondary); padding: 6px 0; }
.hint { margin-top: 6px; }
</style>
