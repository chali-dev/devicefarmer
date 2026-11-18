<script setup lang="ts">
import { dateLocale } from '../../i18n'
import { onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { AiSettingsState } from '../../api/types'

/**
 * Settings → AI (admin): Anthropic API key (write-only: the API only says whether it is set), model, daily hour
 * and the on/off switch for 人设每日草稿.
 */
const { t, te } = useI18n()
type Res = { ai: AiSettingsState; models: string[] }
const state = ref<AiSettingsState | null>(null)
const models = ref<string[]>([])
const saving = ref(false)
const keyInput = ref('')
const form = ref({ enabled: true, model: '', hour: 6, workspaceId: '' })

function apply(r: Res) {
  state.value = r.ai
  models.value = r.models
  form.value = { enabled: r.ai.enabled, model: r.ai.model, hour: r.ai.hour, workspaceId: r.ai.workspaceId ?? '' }
}
onMounted(async () => { try { apply(await api<Res>('GET', '/api/settings/ai')) } catch (e) { message.error(errorText(e)) } })

async function save(body: Record<string, unknown>) {
  saving.value = true
  try {
    apply(await api<Res>('PUT', '/api/settings/ai', body))
    keyInput.value = ''
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) } finally { saving.value = false }
}
const saveAll = () => save({ ...form.value, workspaceId: form.value.workspaceId.trim() || null, ...(keyInput.value.trim() ? { apiKey: keyInput.value.trim() } : {}) })
const modelLabel = (m: string) => (te(`settings.ai.models.${m}`) ? t(`settings.ai.models.${m}`) : m)
const hours = Array.from({ length: 24 }, (_, h) => ({ value: h, label: `${String(h).padStart(2, '0')}:00` }))
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="!state">
      <a-typography-title :level="5">{{ t('settings.ai.title') }}</a-typography-title>
      <a-alert type="info" show-icon :message="t('settings.ai.hint')" class="block-gap" />
      <a-form layout="vertical">
        <a-form-item :label="t('settings.ai.enabled')">
          <a-switch v-model:checked="form.enabled" />
        </a-form-item>
        <a-form-item :label="t('settings.ai.keyState')">
          <a-space wrap>
            <a-tag :color="state?.keySet ? 'success' : 'default'">{{ state?.keySet ? t('settings.ai.keySet') : t('settings.ai.keyNotSet') }}</a-tag>
            <span v-if="state?.updatedAt" class="muted small">{{ t('settings.updatedAt', { at: new Date(state.updatedAt).toLocaleString(dateLocale()) }) }}</span>
          </a-space>
        </a-form-item>
        <a-form-item :label="t('settings.ai.key')">
          <a-input-password v-model:value="keyInput" :placeholder="state?.keySet ? t('settings.ai.keyReplace') : 'sk-ant-…'" autocomplete="off" :maxlength="300" />
        </a-form-item>
        <a-form-item :label="t('settings.ai.workspace')" :extra="t('settings.ai.workspaceHint')">
          <a-input v-model:value="form.workspaceId" placeholder="wrkspc_…" allow-clear autocomplete="off" :maxlength="80" />
        </a-form-item>
        <a-form-item :label="t('settings.ai.model')">
          <a-select v-model:value="form.model" :options="models.map((m) => ({ value: m, label: modelLabel(m) }))" />
        </a-form-item>
        <a-form-item :label="t('settings.ai.hour')" :extra="t('settings.ai.hourHint', { h: form.hour })">
          <a-select v-model:value="form.hour" :options="hours" style="width: 120px" />
        </a-form-item>
        <a-space wrap>
          <a-button type="primary" :loading="saving" @click="saveAll">{{ t('common.save') }}</a-button>
          <a-button v-if="state?.keySet" danger :loading="saving" @click="save({ apiKey: null })">{{ t('settings.ai.keyClear') }}</a-button>
        </a-space>
      </a-form>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 640px; }
.block-gap { margin-bottom: 16px; }
</style>
