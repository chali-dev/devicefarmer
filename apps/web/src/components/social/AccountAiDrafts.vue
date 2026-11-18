<script setup lang="ts">
import { ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { AccountAiDrafts } from '../../api/types'
import DraftRunInfo from '../comments/DraftRunInfo.vue'
import AccountAiGenerateModal from './AccountAiGenerateModal.vue'

/**
 * 社交号 → AI 草稿 (owner decision 2026-11-18: the persona defines the style, the account how many drafts a day).
 * Self-contained (GET/PUT /api/social/accounts/:id/ai-drafts), saved on change, independent of the account form's 保存.
 * Needs the account's SAVED persona (ai.account_no_persona otherwise); shows the last run (daily or 立即生成).
 * 「AI生成草稿」 opens AccountAiGenerateModal (optional 主题 + 篇数, drafts now; works with the daily switch off).
 */
const props = defineProps<{ accountId: string; handle?: string }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()

const state = ref<AccountAiDrafts | null>(null)
const saving = ref(false)
const genOpen = ref(false)

async function load() {
  try { state.value = await api<AccountAiDrafts>('GET', `/api/social/accounts/${props.accountId}/ai-drafts`) } catch (e) { message.error(errorText(e)) }
}
watch(() => props.accountId, () => { state.value = null; void load() }, { immediate: true })

async function put(body: { enabled?: boolean; perDay?: number }) {
  if (!state.value) return
  saving.value = true
  try {
    const r = await api<{ enabled: boolean; perDay: number }>('PUT', `/api/social/accounts/${props.accountId}/ai-drafts`, body)
    Object.assign(state.value, r)
    message.success(t('common.saved'))
    emit('changed')
  } catch (e) { message.error(errorText(e)); await load() } finally { saving.value = false }
}
</script>

<template>
  <div v-if="state" class="ai-drafts">
    <div class="row">
      <a-switch :checked="state.enabled" :loading="saving" :disabled="!state.personaId && !state.enabled" @change="(v: unknown) => put({ enabled: !!v })" />
      <span>{{ t('social.aiDrafts.perDay') }}</span>
      <a-input-number :value="state.perDay" :min="1" :max="10" :precision="0" size="small" style="width: 70px" :disabled="saving"
        @change="(v: unknown) => { if (typeof v === 'number' && v !== state!.perDay) void put({ perDay: v }) }" />
      <a-button size="small" :disabled="!state.personaId || !state.ai.keySet" @click="genOpen = true">{{ t('social.aiDrafts.generateNow') }}</a-button>
    </div>
    <div class="muted small">
      <template v-if="!state.personaId">{{ t('social.aiDrafts.noPersona') }}</template>
      <template v-else>{{ t('social.aiDrafts.hint', { hour: state.ai.hour }) }}</template>
      <template v-if="!state.ai.keySet"> {{ t('social.aiDrafts.aiOff') }}</template>
    </div>
    <DraftRunInfo v-if="state.runs[0]" :run="state.runs[0]" />
    <AccountAiGenerateModal v-model:open="genOpen" :account="{ id: accountId, handle: handle ?? '', personaId: state.personaId }" @done="load" />
  </div>
</template>

<style scoped>
.ai-drafts { display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
</style>
