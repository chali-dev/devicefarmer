<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { DraftPreview } from '../../api/types'
import { MODAL_WIDTH } from '../common/ui'

/**
 * AI测试 (人设页 row action and the persona form): a pure STYLE TEST (owner decision 2026-11-18): one draft in the
 * persona's saved 风格, optionally on a 主题, generated synchronously by POST /api/personas/:id/drafts/preview
 * (usually seconds, ≤ 90 s; spinner meanwhile) and never stored; there is no way to save it. 生成 / 重新生成 asks
 * again (rate-limited per persona, ai.rate_limited); 关闭 drops it. Drafts are made on the social account (AI生成草稿).
 */
const props = defineProps<{ open: boolean; personaId: string | null; personaName?: string }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()
const { t } = useI18n()

const data = ref<DraftPreview | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)
const topic = ref('')

async function generate() {
  if (!props.personaId) return
  loading.value = true
  error.value = null
  try {
    data.value = await api<DraftPreview>('POST', `/api/personas/${props.personaId}/drafts/preview`, topic.value.trim() ? { topic: topic.value.trim() } : {})
  } catch (e) {
    data.value = null
    error.value = errorText(e)
  } finally { loading.value = false }
}
watch(() => [props.open, props.personaId] as const, () => {
  data.value = null; error.value = null; topic.value = ''
}, { immediate: true })
</script>

<template>
  <a-modal :open="open" :title="t('personas.preview.title', { name: personaName ?? '' })" :width="MODAL_WIDTH.md" :mask-closable="false" @cancel="emit('update:open', false)">
    <a-spin :spinning="loading" :tip="t('personas.preview.loading')">
      <div class="body">
        <a-alert type="info" show-icon :message="t('personas.preview.hint')" />
        <a-form layout="vertical">
          <a-form-item :label="t('personas.preview.topic')" :extra="t('personas.preview.topicHint')" class="topic">
            <a-input v-model:value="topic" :maxlength="200" allow-clear :placeholder="t('personas.preview.topicPlaceholder')" :disabled="loading" @press-enter="generate" />
          </a-form-item>
        </a-form>
        <a-alert v-if="error" type="error" show-icon :message="error" />
        <template v-else-if="data">
          <a-alert v-if="data.preview.banned.length" type="error" show-icon :message="t('personas.preview.bannedHit', { words: data.preview.banned.join('、') })" />
          <a-alert v-else type="success" show-icon :message="t('personas.preview.bannedOk')" />
          <a-descriptions :column="1" size="small" bordered class="desc">
            <a-descriptions-item v-if="data.preview.topic" :label="t('personas.preview.topic')">{{ data.preview.topic }}</a-descriptions-item>
            <a-descriptions-item :label="t('personas.preview.titleLabel')">{{ data.preview.title }}</a-descriptions-item>
            <a-descriptions-item :label="t('personas.preview.text')">
              <div class="text">{{ data.preview.text }}</div>
            </a-descriptions-item>
            <a-descriptions-item :label="t('personas.preview.mediaTags')">
              <a-tag v-for="m in data.preview.mediaTags" :key="m">{{ m }}</a-tag><span v-if="!data.preview.mediaTags.length" class="muted">—</span>
            </a-descriptions-item>
            <a-descriptions-item :label="t('personas.preview.model')">
              {{ data.preview.model }}
              <a-tag v-if="data.preview.fallback" color="orange">{{ t('personas.preview.fallback', { model: data.preview.requestedModel }) }}</a-tag>
            </a-descriptions-item>
            <a-descriptions-item :label="t('personas.preview.usage')">
              {{ t('personas.preview.usageText', { input: data.preview.usage.input, output: data.preview.usage.output, cache: data.preview.usage.cacheRead }) }}
            </a-descriptions-item>
          </a-descriptions>
          <div class="muted small">{{ t('personas.preview.limitHint', { limit: data.limit }) }}</div>
        </template>
      </div>
    </a-spin>
    <template #footer>
      <a-button @click="emit('update:open', false)">{{ t('personas.preview.close') }}</a-button>
      <a-button type="primary" :loading="loading" :disabled="!personaId" @click="generate">{{ data || error ? t('personas.preview.again') : t('personas.preview.generate') }}</a-button>
    </template>
  </a-modal>
</template>

<style scoped>
.body { display: flex; flex-direction: column; gap: 10px; min-height: 120px; }
.topic { margin-bottom: 0; }
.desc :deep(.ant-descriptions-item-label) { width: 110px; white-space: nowrap; }
.text { white-space: pre-wrap; word-break: break-word; }
</style>
