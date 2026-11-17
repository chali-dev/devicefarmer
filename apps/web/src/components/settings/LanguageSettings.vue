<script setup lang="ts">
import { dateLocale } from '../../i18n'
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { canonicalLang, langName } from '../../api/lang'
import type { LanguageSettings } from '../../api/types'

/** Settings → 多语言 (admin): languages offered in the content editor and the default original language. */
const { t } = useI18n()
type State = LanguageSettings & { updatedAt: string | null }
const state = ref<State | null>(null)
const languages = ref<string[]>([])
const defaultSource = ref<string | undefined>()
const saving = ref(false)

function fill(s: State) { state.value = s; languages.value = [...s.languages]; defaultSource.value = s.defaultSource ?? undefined }
onMounted(async () => {
  try { fill((await api<{ languages: State }>('GET', '/api/settings/languages')).languages) } catch (e) { message.error(errorText(e)) }
})
/** Tags mode: keep canonical codes only, reject invalid ones. */
function onLanguages(v: string[]) {
  const out: string[] = []
  for (const raw of v) {
    const c = canonicalLang(raw)
    if (!c) { message.warning(t('settings.languages.invalid', { code: raw })); continue }
    if (!out.includes(c)) out.push(c)
  }
  languages.value = out
  if (defaultSource.value && !out.includes(defaultSource.value)) defaultSource.value = undefined
}
const options = computed(() => languages.value.map((l) => ({ value: l, label: `${langName(l)} (${l})` })))
async function save() {
  saving.value = true
  try {
    fill((await api<{ languages: State }>('PUT', '/api/settings/languages', { languages: languages.value, defaultSource: defaultSource.value ?? null })).languages)
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) } finally { saving.value = false }
}
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="!state">
      <a-typography-title :level="5">{{ t('settings.languages.title') }}</a-typography-title>
      <a-form layout="vertical">
        <a-form-item :label="t('settings.languages.list')">
          <a-select :value="languages" mode="tags" :options="options" :token-separators="[',', ' ']" :placeholder="t('settings.languages.listPlaceholder')" @change="(v: any) => onLanguages(v as string[])" />
        </a-form-item>
        <a-form-item :label="t('settings.languages.defaultSource')">
          <a-select v-model:value="defaultSource" :options="options" allow-clear style="width: 240px" />
        </a-form-item>
        <a-space wrap>
          <a-button type="primary" :loading="saving" :disabled="!languages.length" @click="save">{{ t('common.save') }}</a-button>
          <span v-if="state?.updatedAt" class="muted small">{{ t('settings.updatedAt', { at: new Date(state.updatedAt).toLocaleString(dateLocale()) }) }}</span>
        </a-space>
      </a-form>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 640px; }
</style>
