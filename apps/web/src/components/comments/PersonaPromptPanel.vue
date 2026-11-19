<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { PersonaPrompt } from '../../api/types'

/**
 * 提示词 tab of the persona form (owner 2026-11-19: 「提示词功能移到编辑里」, then 「不用『使用自定义提示词』开关，用户
 * 编辑改就改，不用保存就能先看」). The two boxes 系统提示词 / 人设提示词 are always editable, prefilled with the saved
 * custom prompt, else the generated template (with placeholders). 实际发送 below renders the CURRENT boxes client-side
 * with the placeholder values GET /api/personas/:id/prompt returns once (`prompt.vars`: 范例, recent posts, date, count;
 * {{主题}} from the test-topic input), the same single-pass replacement as the API's renderPrompt; the generated message
 * is the template filled the same way, so an unedited template previews exactly what is sent. No model call.
 * Nothing is saved here: the drawer's one 保存 reads `pending()` (boxes equal to the template = null = generated).
 * 恢复自动生成 refills both boxes with the template (nothing lost until 保存). The generated text follows the SAVED
 * persona: with unsaved 基本 changes (`stale`) a note says 「保存后更新」.
 */
const props = defineProps<{ personaId: string; stale: boolean }>()
const { t } = useI18n()

const data = ref<PersonaPrompt | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const topic = ref('')
const system = ref('')
const user = ref('')

/** Shown in the hint (kept out of the template: mustache braces). */
const TOPIC_ALIAS = '{{主题}}'
const placeholderList = computed(() => (data.value?.placeholders ?? []).map((p) => `{{${p}}}`).join('  '))
const schemaText = computed(() => (data.value ? JSON.stringify(data.value.schema, null, 2) : ''))
const isTemplate = computed(() => !!data.value && system.value === data.value.template.system && user.value === data.value.template.user)

/** Same rule as the API's renderPrompt: `{{ name }}`, alias 主题 = topic, unknown names stay literal. */
const ALIASES: Record<string, string> = { 主题: 'topic' }
function render(text: string): string {
  const vars: Record<string, string> = { ...(data.value?.prompt.vars ?? {}), topic: topic.value.trim() }
  return text.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (all, name: string) => {
    const key = ALIASES[name] ?? name
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : all
  })
}
const sentSystem = computed(() => render(system.value))
const sentUser = computed(() => render(user.value))

/** Fresh state from the server (on open and after the drawer saved). */
async function reset() {
  loading.value = true
  error.value = null
  try {
    const d = await api<PersonaPrompt>('GET', `/api/personas/${props.personaId}/prompt`)
    data.value = d
    const src = d.customPrompt ?? d.template
    system.value = src.system
    user.value = src.user
  } catch (e) {
    error.value = errorText(e)
  } finally { loading.value = false }
}
watch(() => props.personaId, () => { topic.value = ''; void reset() }, { immediate: true })

function useGenerated() {
  system.value = data.value?.template.system ?? ''
  user.value = data.value?.template.user ?? ''
}

/**
 * For the drawer's 保存: `undefined` = nothing to change, `null` = generated (clears a saved custom prompt), an object =
 * save it as the custom prompt, `'empty'` = a box is blank (the drawer warns and doesn't save).
 */
function pending(): PersonaPrompt['customPrompt'] | undefined | 'empty' {
  const d = data.value
  if (!d) return undefined
  if (!system.value.trim() || !user.value.trim()) return 'empty'
  if (isTemplate.value) return d.customPrompt ? null : undefined
  if (d.customPrompt && d.customPrompt.system === system.value && d.customPrompt.user === user.value) return undefined
  return { system: system.value, user: user.value }
}
defineExpose({ pending, reset })
</script>

<template>
  <a-spin :spinning="loading">
    <div class="body">
      <a-alert v-if="error" type="error" show-icon :message="error" />
      <template v-if="data">
        <div class="bar">
          <a-tag :color="isTemplate ? 'default' : 'purple'">{{ isTemplate ? t('personas.prompt.generatedTag') : t('personas.prompt.customTag') }}</a-tag>
          <span class="muted small">{{ t('personas.prompt.meta', { model: data.model, examples: data.prompt.examples, recent: data.prompt.recent }) }}</span>
        </div>
        <div class="muted small">{{ t('personas.prompt.hint') }}</div>
        <a-alert v-if="stale && isTemplate" type="info" show-icon :message="t('personas.prompt.stale')" />
        <a-alert v-if="!isTemplate" type="warning" show-icon :message="t('personas.prompt.warning')" />
        <div class="muted small">{{ t('personas.prompt.placeholders', { list: placeholderList, alias: TOPIC_ALIAS }) }}</div>

        <div class="label">{{ t('personas.prompt.system') }} <span class="muted small">{{ t('personas.prompt.systemHint') }}</span></div>
        <a-textarea v-model:value="system" :auto-size="{ minRows: 6, maxRows: 16 }" :maxlength="data.maxLength" class="mono" />
        <div class="label">{{ t('personas.prompt.user') }} <span class="muted small">{{ t('personas.prompt.userHint') }}</span></div>
        <a-textarea v-model:value="user" :auto-size="{ minRows: 8, maxRows: 20 }" :maxlength="data.maxLength" class="mono" />
        <div class="actions">
          <a-button size="small" :disabled="isTemplate" @click="useGenerated">{{ t('personas.prompt.useGenerated') }}</a-button>
          <span class="muted small">{{ t('personas.prompt.saveHint') }}</span>
        </div>

        <a-divider orientation="left" plain>{{ t('personas.prompt.rendered') }}</a-divider>
        <a-input v-model:value="topic" :maxlength="200" allow-clear :placeholder="t('personas.prompt.topicPlaceholder')" />
        <pre class="text">{{ sentSystem }}</pre>
        <pre class="text">{{ sentUser }}</pre>

        <a-collapse ghost>
          <a-collapse-panel key="s" :header="t('personas.prompt.schema')">
            <div class="muted small">{{ t('personas.prompt.schemaHint') }}</div>
            <pre class="text">{{ schemaText }}</pre>
          </a-collapse-panel>
        </a-collapse>
      </template>
    </div>
  </a-spin>
</template>

<style scoped>
.body { display: flex; flex-direction: column; gap: 10px; min-height: 160px; }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.label { font-weight: 500; margin-top: 4px; }
.text {
  white-space: pre-wrap; word-break: break-word; margin: 0; padding: 8px 10px; max-height: 360px; overflow: auto;
  background: var(--cp-fill-alter); border-radius: 6px; font-size: 12px;
}
.mono :deep(textarea), .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
</style>
