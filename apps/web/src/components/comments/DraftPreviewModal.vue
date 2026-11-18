<script setup lang="ts">
import { ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { DraftPreview } from '../../api/types'
import { MODAL_WIDTH } from '../common/ui'

/**
 * AI测试 (人设页 row action and the persona form): one draft in the persona's saved 发文风格, generated synchronously by
 * POST /api/personas/:id/drafts/preview (usually seconds, ≤ 90 s; spinner meanwhile) and NOT stored. 重新生成 asks again
 * (rate-limited per persona, ai.rate_limited); 保存为草稿 sends only the preview's token, the API writes the draft it
 * kept (owner = the current user); 关闭 drops it (the token expires after 10 minutes).
 */
const props = defineProps<{ open: boolean; personaId: string | null; personaName?: string }>()
const emit = defineEmits<{ 'update:open': [boolean]; saved: [contentId: string] }>()
const { t } = useI18n()

const data = ref<DraftPreview | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)
const saving = ref(false)
const savedId = ref<string | null>(null)

async function generate() {
  if (!props.personaId) return
  loading.value = true
  error.value = null
  savedId.value = null
  try {
    data.value = await api<DraftPreview>('POST', `/api/personas/${props.personaId}/drafts/preview`)
  } catch (e) {
    error.value = errorText(e)
  } finally { loading.value = false }
}
watch(() => [props.open, props.personaId] as const, ([open]) => {
  data.value = null; error.value = null; savedId.value = null
  if (open) void generate()
}, { immediate: true })

async function save() {
  if (!props.personaId || !data.value) return
  saving.value = true
  try {
    const r = await api<{ contentId: string }>('POST', `/api/personas/${props.personaId}/drafts/save`, { token: data.value.token })
    savedId.value = r.contentId
    message.success(t('personas.preview.saved'))
    emit('saved', r.contentId)
  } catch (e) { message.error(errorText(e)) } finally { saving.value = false }
}
</script>

<template>
  <a-modal :open="open" :title="t('personas.preview.title', { name: personaName ?? '' })" :width="MODAL_WIDTH.md" :mask-closable="false" @cancel="emit('update:open', false)">
    <a-spin :spinning="loading" :tip="t('personas.preview.loading')">
      <div class="body">
        <a-alert v-if="error" type="error" show-icon :message="error" />
        <template v-else-if="data">
          <a-alert v-if="data.preview.banned.length" type="error" show-icon :message="t('personas.preview.bannedHit', { words: data.preview.banned.join('、') })" />
          <a-alert v-else type="success" show-icon :message="t('personas.preview.bannedOk')" />
          <a-descriptions :column="1" size="small" bordered class="desc">
            <a-descriptions-item :label="t('personas.preview.titleLabel')">{{ data.preview.title }}</a-descriptions-item>
            <a-descriptions-item :label="t('personas.preview.text')">
              <div class="text">{{ data.preview.text }}</div>
              <div v-if="data.preview.opening || data.preview.closing" class="muted small">{{ t('personas.preview.fixedLines') }}</div>
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
          <div class="muted small">{{ savedId ? t('personas.preview.savedHint') : t('personas.preview.hint', { limit: data.limit }) }}</div>
        </template>
        <div v-else class="placeholder" />
      </div>
    </a-spin>
    <template #footer>
      <a-button @click="emit('update:open', false)">{{ t('personas.preview.close') }}</a-button>
      <a-button :loading="loading" :disabled="saving" @click="generate">{{ t('personas.preview.again') }}</a-button>
      <a-button type="primary" :loading="saving" :disabled="loading || !data || !!savedId || data.preview.banned.length > 0" @click="save">
        {{ savedId ? t('personas.preview.savedButton') : t('personas.preview.save') }}
      </a-button>
    </template>
  </a-modal>
</template>

<style scoped>
.body { display: flex; flex-direction: column; gap: 10px; min-height: 120px; }
.desc :deep(.ant-descriptions-item-label) { width: 110px; white-space: nowrap; }
.text { white-space: pre-wrap; word-break: break-word; }
.placeholder { height: 120px; }
</style>
