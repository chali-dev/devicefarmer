<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { PersonaPrompt } from '../../api/types'
import { MODAL_WIDTH } from '../common/ui'

/**
 * 提示词 (人设页 row action, managers of the persona like AI测试; owner 2026-11-19): shows exactly what AI测试 /
 * 「AI生成草稿」 send to the model (GET /api/personas/:id/prompt, no model call), optionally with a 主题 filled in.
 * 自定义: the person edits the WHOLE prompt (system + user, prefilled with the stored custom prompt or the generated one
 * with placeholders) and saves it on the persona (PUT …/prompt); 恢复自动生成 clears it. The output JSON schema, the
 * banned-word check, the rate limits and drafts-only always stay.
 */
const props = defineProps<{ open: boolean; personaId: string | null; personaName?: string }>()
const emit = defineEmits<{ 'update:open': [boolean]; saved: [] }>()
const { t } = useI18n()

const data = ref<PersonaPrompt | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const topic = ref('')
const custom = ref(false)
const system = ref('')
const user = ref('')

/** Shown in the hint (kept out of the template: mustache braces). */
const TOPIC_ALIAS = '{{主题}}'
const placeholderList = computed(() => (data.value?.placeholders ?? []).map((p) => `{{${p}}}`).join('  '))
const schemaText = computed(() => (data.value ? JSON.stringify(data.value.schema, null, 2) : ''))
const dirty = computed(() => {
  const c = data.value?.customPrompt
  return custom.value && (!c || c.system !== system.value || c.user !== user.value)
})

async function load() {
  if (!props.personaId) return
  loading.value = true
  error.value = null
  try {
    const q = topic.value.trim() ? `?topic=${encodeURIComponent(topic.value.trim())}` : ''
    data.value = await api<PersonaPrompt>('GET', `/api/personas/${props.personaId}/prompt${q}`)
  } catch (e) {
    error.value = errorText(e)
  } finally { loading.value = false }
}
function fillEditor() {
  const src = data.value?.customPrompt ?? data.value?.template
  system.value = src?.system ?? ''
  user.value = src?.user ?? ''
}
watch(() => [props.open, props.personaId] as const, async ([open]) => {
  data.value = null; topic.value = ''; custom.value = false
  if (!open) return
  await load()
  custom.value = !!(data.value as PersonaPrompt | null)?.customPrompt
  fillEditor()
}, { immediate: true })

async function put(body: PersonaPrompt['customPrompt']) {
  saving.value = true
  try {
    await api('PUT', `/api/personas/${props.personaId}/prompt`, { customPrompt: body })
    emit('saved')
    await load()
    return true
  } catch (e) { message.error(errorText(e)); return false } finally { saving.value = false }
}
async function save() {
  if (!system.value.trim() || !user.value.trim()) { message.warning(t('personas.prompt.emptyPart')); return }
  if (await put({ system: system.value, user: user.value })) message.success(t('personas.prompt.saved'))
}
/** Switch: on = edit (nothing saved yet); off = back to the generated prompt (a saved custom prompt is cleared). */
async function toggle(on: boolean) {
  if (on) { custom.value = true; fillEditor(); return }
  if (!data.value?.customPrompt) { custom.value = false; return }
  if (await put(null)) { custom.value = false; message.success(t('personas.prompt.resetDone')) }
}
function useGenerated() {
  system.value = data.value?.template.system ?? ''
  user.value = data.value?.template.user ?? ''
}
</script>

<template>
  <a-modal :open="open" :title="t('personas.prompt.title', { name: personaName ?? '' })" :width="MODAL_WIDTH.lg" :mask-closable="false" @cancel="emit('update:open', false)">
    <a-spin :spinning="loading">
      <div class="body">
        <a-alert v-if="error" type="error" show-icon :message="error" />
        <template v-if="data">
          <div class="bar">
            <a-space wrap>
              <a-tag :color="data.prompt.custom ? 'purple' : 'default'">{{ data.prompt.custom ? t('personas.prompt.customTag') : t('personas.prompt.generatedTag') }}</a-tag>
              <span class="muted small">{{ t('personas.prompt.meta', { model: data.model, examples: data.prompt.examples, recent: data.prompt.recent }) }}</span>
            </a-space>
            <a-space>
              <span>{{ t('personas.prompt.custom') }}</span>
              <a-popconfirm v-if="custom && data.customPrompt" :title="t('personas.prompt.resetConfirm')" :ok-text="t('common.ok')" :cancel-text="t('common.cancel')" @confirm="toggle(false)">
                <a-switch :checked="custom" :loading="saving" />
              </a-popconfirm>
              <a-switch v-else :checked="custom" :loading="saving" @change="(v: unknown) => toggle(!!v)" />
            </a-space>
          </div>

          <template v-if="!custom">
            <div class="muted small">{{ t('personas.prompt.hint') }}</div>
            <div class="topic">
              <a-input v-model:value="topic" :maxlength="200" allow-clear :placeholder="t('personas.prompt.topicPlaceholder')" style="max-width: 320px" @press-enter="load" />
              <a-button @click="load">{{ t('personas.prompt.refresh') }}</a-button>
            </div>
            <div class="label">{{ t('personas.prompt.system') }}</div>
            <pre class="text">{{ data.prompt.system }}</pre>
            <div class="label">{{ t('personas.prompt.user') }}</div>
            <pre class="text">{{ data.prompt.user }}</pre>
          </template>

          <template v-else>
            <a-alert type="warning" show-icon :message="t('personas.prompt.warning')" />
            <div class="muted small">{{ t('personas.prompt.placeholders', { list: placeholderList, alias: TOPIC_ALIAS }) }}</div>
            <div class="label">{{ t('personas.prompt.system') }}</div>
            <a-textarea v-model:value="system" :auto-size="{ minRows: 6, maxRows: 16 }" :maxlength="data.maxLength" class="mono" />
            <div class="label">{{ t('personas.prompt.user') }}</div>
            <a-textarea v-model:value="user" :auto-size="{ minRows: 8, maxRows: 20 }" :maxlength="data.maxLength" class="mono" />
            <div><a-button type="link" size="small" class="p0" @click="useGenerated">{{ t('personas.prompt.useGenerated') }}</a-button></div>
            <a-collapse v-if="data.customPrompt" ghost>
              <a-collapse-panel key="r" :header="t('personas.prompt.rendered')">
                <pre class="text">{{ data.prompt.system }}</pre>
                <pre class="text">{{ data.prompt.user }}</pre>
              </a-collapse-panel>
            </a-collapse>
          </template>

          <a-collapse ghost>
            <a-collapse-panel key="s" :header="t('personas.prompt.schema')">
              <div class="muted small">{{ t('personas.prompt.schemaHint') }}</div>
              <pre class="text">{{ schemaText }}</pre>
            </a-collapse-panel>
          </a-collapse>
        </template>
      </div>
    </a-spin>
    <template #footer>
      <a-button @click="emit('update:open', false)">{{ t('personas.preview.close') }}</a-button>
      <a-button v-if="custom" type="primary" :loading="saving" :disabled="!dirty" @click="save">{{ t('common.save') }}</a-button>
    </template>
  </a-modal>
</template>

<style scoped>
.body { display: flex; flex-direction: column; gap: 10px; min-height: 160px; }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.topic { display: flex; gap: 8px; }
.label { font-weight: 500; margin-top: 4px; }
.text {
  white-space: pre-wrap; word-break: break-word; margin: 0; padding: 8px 10px; max-height: 320px; overflow: auto;
  background: var(--cp-fill-alter); border-radius: 6px; font-size: 12px;
}
.mono :deep(textarea), .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.p0 { padding: 0; }
</style>
