<script setup lang="ts">
import { dateLocale } from '../../i18n'
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { canonicalLang, COMMON_LANGS, langName } from '../../api/lang'
import { confirmAction } from '../common/ui'
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
/** Codes typed in the last change that were not valid BCP-47 tags (shown inline, never saved). */
const invalid = ref<string[]>([])
/** Tags mode: built-in options or any typed code; keep canonical, deduped codes only. */
function onLanguages(v: string[]) {
  const out: string[] = []
  const bad: string[] = []
  for (const raw of v) {
    const c = canonicalLang(raw)
    if (!c) { bad.push(raw); continue }
    if (!out.includes(c)) out.push(c)
  }
  invalid.value = bad
  const apply = () => {
    languages.value = out
    if (defaultSource.value && !out.includes(defaultSource.value)) defaultSource.value = undefined
  }
  if (defaultSource.value && languages.value.includes(defaultSource.value) && !out.includes(defaultSource.value)) {
    confirmAction({
      title: t('settings.languages.removeDefault', { lang: label(defaultSource.value) }),
      onOk: apply,
    })
    return
  }
  apply()
}
const label = (l: string) => `${langName(l)} (${l})`
/** Configured languages first, then the built-in list. */
const allOptions = computed(() => [...new Set([...languages.value, ...COMMON_LANGS])].map((l) => ({ value: l, label: label(l) })))
const options = computed(() => languages.value.map((l) => ({ value: l, label: label(l) })))
const filterOption = (input: string, o?: { value: string; label: string }) =>
  !!o && (o.label.toLowerCase().includes(input.trim().toLowerCase()) || o.value.toLowerCase().includes(input.trim().toLowerCase()))
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
        <a-form-item
          :label="t('settings.languages.list')"
          :validate-status="invalid.length ? 'error' : undefined"
          :help="invalid.length ? t('settings.languages.invalid', { code: invalid.join(', ') }) : undefined"
        >
          <a-select
            :value="languages" mode="tags" :options="allOptions" :filter-option="filterOption" :token-separators="[',', ' ']"
            :placeholder="t('settings.languages.listPlaceholder')" @change="(v: any) => onLanguages(v as string[])"
          />
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
