<script setup lang="ts">
/**
 * 「AI生成草稿」 on a social account (row action in 我的媒体号 and the account form's AI 草稿 block): optional 主题
 * (empty = the model picks topics from the persona) and 篇数, then POST /api/social/accounts/:id/ai-drafts/generate
 * queues the account-drafts task (drafts of the account owner targeting this account, like the daily run). The task is
 * followed through the task events; the result comes from GET /api/tasks/:id. Nothing is published.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import type { Task } from '../../api/types'
import { useInstancesStore } from '../../stores/instances'
import { MODAL_WIDTH } from '../common/ui'

const props = defineProps<{ open: boolean; account: { id: string; handle: string; personaId: string | null } | null }>()
const emit = defineEmits<{ 'update:open': [boolean]; done: [] }>()
const { t } = useI18n()
const store = useInstancesStore()

const topic = ref('')
const count = ref(1)
const busy = ref(false)
const taskId = ref<string | null>(null)
const state = ref<{ phase: 'idle' | 'queued' | 'running' | 'done' | 'skipped' | 'failed'; n?: number; error?: string }>({ phase: 'idle' })
const waiting = computed(() => state.value.phase === 'queued' || state.value.phase === 'running')

watch(() => props.open, (o) => {
  if (!o) return
  topic.value = ''
  count.value = 1
  taskId.value = null
  state.value = { phase: 'idle' }
})

async function start() {
  if (!props.account) return
  busy.value = true
  try {
    const body = { count: count.value, ...(topic.value.trim() ? { topic: topic.value.trim() } : {}) }
    const r = await api<{ task: { id: string } }>('POST', `/api/social/accounts/${props.account.id}/ai-drafts/generate`, body)
    taskId.value = r.task.id
    state.value = { phase: 'queued' }
    emit('done')
  } catch (e) { state.value = { phase: 'failed', error: errorText(e) } }
  finally { busy.value = false }
}

async function finished(id: string) {
  try {
    const { task } = await api<{ task: Task & { result: { contentIds?: string[]; skipped?: string } | null } }>('GET', `/api/tasks/${id}`)
    if (task.status !== 'success') state.value = { phase: 'failed', error: codeText(task.errorCode ?? undefined, {}, task.error ?? task.status) }
    else if (task.result?.skipped) state.value = { phase: 'skipped', error: codeText(task.result.skipped, {}, task.result.skipped) }
    else state.value = { phase: 'done', n: task.result?.contentIds?.length ?? 0 }
  } catch (e) { state.value = { phase: 'failed', error: errorText(e) } }
  emit('done')
}

const off = store.onTaskEvent((ev) => {
  if (ev.type !== 'task.updated' || ev.task.id !== taskId.value) return
  if (ev.task.status === 'running') state.value = { phase: 'running' }
  else if (ev.task.status === 'pending' && state.value.phase === 'running') state.value = { phase: 'queued' } // retry backoff
  else if (['success', 'failed', 'cancelled'].includes(ev.task.status)) void finished(ev.task.id)
})
onBeforeUnmount(off)
const close = () => emit('update:open', false)
</script>

<template>
  <a-modal :open="open" :title="t('social.aiDrafts.generateTitle', { handle: account?.handle ?? '' })" :width="MODAL_WIDTH.sm" :mask-closable="false" @cancel="close">
    <p class="muted small">{{ t('social.aiDrafts.generateIntro') }}</p>
    <a-alert v-if="account && !account.personaId" type="warning" show-icon :message="t('social.aiDrafts.noPersonaGenerate')" />
    <a-form v-else layout="vertical">
      <a-form-item :label="t('social.aiDrafts.topic')" :extra="t('social.aiDrafts.topicHint')">
        <a-input v-model:value="topic" :maxlength="200" allow-clear :placeholder="t('social.aiDrafts.topicPlaceholder')" :disabled="waiting" @press-enter="start" />
      </a-form-item>
      <a-form-item :label="t('social.aiDrafts.count')">
        <a-input-number v-model:value="count" :min="1" :max="10" :precision="0" :disabled="waiting" />
      </a-form-item>
    </a-form>
    <a-alert v-if="waiting" type="info" show-icon :message="t(`social.aiDrafts.${state.phase}`)">
      <template #icon><a-spin size="small" /></template>
    </a-alert>
    <a-alert v-else-if="state.phase === 'done'" :type="state.n ? 'success' : 'warning'" show-icon :message="t('social.aiDrafts.generated', { n: state.n })">
      <template #description>
        <router-link to="/content?status=draft" @click="close">{{ t('social.aiDrafts.openDrafts') }}</router-link>
        <div class="muted small">{{ t('social.aiDrafts.reviewHint') }}</div>
      </template>
    </a-alert>
    <a-alert v-else-if="state.phase === 'skipped'" type="info" show-icon :message="t('social.aiDrafts.skippedRun', { msg: state.error })" />
    <a-alert v-else-if="state.phase === 'failed'" type="error" show-icon :message="t('social.aiDrafts.failed', { msg: state.error })" />
    <template #footer>
      <a-button @click="close">{{ t('social.aiDrafts.close') }}</a-button>
      <a-button type="primary" :loading="busy || waiting" :disabled="!account?.personaId" @click="start">{{ t('social.aiDrafts.generate') }}</a-button>
    </template>
  </a-modal>
</template>
