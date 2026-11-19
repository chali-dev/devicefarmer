<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { PersonaPrompt } from '../../api/types'

/**
 * 提示词 tab of the persona form (owner 2026-11-19: 「提示词功能移到编辑里，算是自定义页签」). Shows exactly what
 * AI测试 / 「AI生成草稿」 send (GET /api/personas/:id/prompt, no model call), optionally with a test 主题 filled in.
 * The generated text is built from the SAVED persona: while the 基本 tab has unsaved changes (`stale`) a one-line note
 * says 「保存后更新」. Switch 使用自定义提示词: the two boxes become editable (prefilled with the stored custom prompt or
 * the generated one with placeholders). Nothing is saved here: the drawer's one 保存 reads `pending()` and PUTs it
 * (off with a stored custom prompt = clear it, after the switch's confirmation). The output JSON schema, the banned-word
 * check, the rate limits and drafts-only always stay.
 */
const props = defineProps<{ personaId: string; stale: boolean }>()
const { t } = useI18n()

const data = ref<PersonaPrompt | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const topic = ref('')
const custom = ref(false)
const system = ref('')
const user = ref('')

/** Shown in the hint (kept out of the template: mustache braces). */
const TOPIC_ALIAS = '{{主题}}'
const placeholderList = computed(() => (data.value?.placeholders ?? []).map((p) => `{{${p}}}`).join('  '))
const schemaText = computed(() => (data.value ? JSON.stringify(data.value.schema, null, 2) : ''))

async function load() {
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
/** Fresh state from the server (on open and after the drawer saved). */
async function reset() {
  data.value = null; custom.value = false
  await load()
  custom.value = !!(data.value as PersonaPrompt | null)?.customPrompt
  fillEditor()
}
watch(() => props.personaId, () => { topic.value = ''; void reset() }, { immediate: true })

function setCustom(on: boolean) {
  custom.value = on
  if (on) fillEditor()
}
function useGenerated() {
  system.value = data.value?.template.system ?? ''
  user.value = data.value?.template.user ?? ''
}

/**
 * For the drawer's 保存: `undefined` = nothing to change, `null` = clear the stored custom prompt, an object = save it,
 * `'empty'` = a box is blank (the drawer warns and doesn't save).
 */
function pending(): PersonaPrompt['customPrompt'] | undefined | 'empty' {
  if (!data.value) return undefined
  const stored = data.value.customPrompt
  if (!custom.value) return stored ? null : undefined
  if (!system.value.trim() || !user.value.trim()) return 'empty'
  if (stored && stored.system === system.value && stored.user === user.value) return undefined
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
          <a-space>
            <a-popconfirm v-if="custom && data.customPrompt" :title="t('personas.prompt.resetConfirm')" :ok-text="t('common.ok')" :cancel-text="t('common.cancel')" @confirm="setCustom(false)">
              <a-switch :checked="custom" />
            </a-popconfirm>
            <a-switch v-else :checked="custom" @change="(v: unknown) => setCustom(!!v)" />
            <span>{{ t('personas.prompt.custom') }}</span>
          </a-space>
          <span class="muted small">{{ t('personas.prompt.meta', { model: data.model, examples: data.prompt.examples, recent: data.prompt.recent }) }}</span>
        </div>

        <template v-if="!custom">
          <div class="muted small">{{ t('personas.prompt.hint') }}</div>
          <a-alert v-if="stale" type="info" show-icon :message="t('personas.prompt.stale')" />
          <div class="topic">
            <a-input v-model:value="topic" :maxlength="200" allow-clear :placeholder="t('personas.prompt.topicPlaceholder')" @press-enter="load" />
            <a-button @click="load">{{ t('personas.prompt.refresh') }}</a-button>
          </div>
          <div class="label">{{ t('personas.prompt.system') }} <span class="muted small">{{ t('personas.prompt.systemHint') }}</span></div>
          <pre class="text">{{ data.prompt.system }}</pre>
          <div class="label">{{ t('personas.prompt.user') }} <span class="muted small">{{ t('personas.prompt.userHint') }}</span></div>
          <pre class="text">{{ data.prompt.user }}</pre>
        </template>

        <template v-else>
          <a-alert type="warning" show-icon :message="t('personas.prompt.warning')" />
          <div class="muted small">{{ t('personas.prompt.placeholders', { list: placeholderList, alias: TOPIC_ALIAS }) }}</div>
          <div class="label">{{ t('personas.prompt.system') }} <span class="muted small">{{ t('personas.prompt.systemHint') }}</span></div>
          <a-textarea v-model:value="system" :auto-size="{ minRows: 6, maxRows: 16 }" :maxlength="data.maxLength" class="mono" />
          <div class="label">{{ t('personas.prompt.user') }} <span class="muted small">{{ t('personas.prompt.userHint') }}</span></div>
          <a-textarea v-model:value="user" :auto-size="{ minRows: 8, maxRows: 20 }" :maxlength="data.maxLength" class="mono" />
          <div><a-button type="link" size="small" class="p0" @click="useGenerated">{{ t('personas.prompt.useGenerated') }}</a-button></div>
          <div class="muted small">{{ t('personas.prompt.saveHint') }}</div>
          <a-collapse v-if="data.customPrompt" ghost>
            <a-collapse-panel key="r" :header="t('personas.prompt.rendered')">
              <div class="topic">
                <a-input v-model:value="topic" :maxlength="200" allow-clear :placeholder="t('personas.prompt.topicPlaceholder')" @press-enter="load" />
                <a-button @click="load">{{ t('personas.prompt.refresh') }}</a-button>
              </div>
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
</template>

<style scoped>
.body { display: flex; flex-direction: column; gap: 10px; min-height: 160px; }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.topic { display: flex; gap: 8px; margin-bottom: 6px; }
.label { font-weight: 500; margin-top: 4px; }
.text {
  white-space: pre-wrap; word-break: break-word; margin: 0 0 6px; padding: 8px 10px; max-height: 360px; overflow: auto;
  background: var(--cp-fill-alter); border-radius: 6px; font-size: 12px;
}
.mono :deep(textarea), .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.p0 { padding: 0; }
</style>
