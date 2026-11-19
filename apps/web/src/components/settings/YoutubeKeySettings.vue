<script setup lang="ts">
import { fmtDateTime } from '../../i18n'
import { onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'

/** 趋势热点 → YouTube API 密钥 (admin): YouTube Data API key (trending + YouTube tracked accounts). Write-only: the API only says whether it is set. */
const { t } = useI18n()
type KeyState = { apiKeySet: boolean; updatedAt: string | null }
const keySaving = ref(false)
const keyState = ref<KeyState | null>(null)
const keyInput = ref('')
onMounted(async () => {
  try { keyState.value = (await api<{ youtube: KeyState }>('GET', '/api/settings/youtube')).youtube } catch (e) { message.error(errorText(e)) }
})
async function saveKey(clear = false) {
  if (!clear && !keyInput.value.trim()) return
  keySaving.value = true
  try {
    keyState.value = (await api<{ youtube: KeyState }>('PUT', '/api/settings/youtube', { apiKey: clear ? null : keyInput.value.trim() })).youtube
    keyInput.value = ''
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { keySaving.value = false }
}
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="!keyState">
      <a-typography-paragraph type="secondary">{{ t('tracked.youtubeKeyHint') }}</a-typography-paragraph>
      <a-form layout="vertical">
        <a-form-item :label="t('tracked.youtubeKeyState')">
          <a-space wrap>
            <a-tag :color="keyState?.apiKeySet ? 'success' : 'default'">{{ keyState?.apiKeySet ? t('tracked.keySet') : t('tracked.keyNotSet') }}</a-tag>
            <span v-if="keyState?.updatedAt" class="muted small">{{ t('settings.updatedAt', { at: fmtDateTime(keyState.updatedAt) }) }}</span>
          </a-space>
        </a-form-item>
        <a-form-item label="API Key">
          <a-input-password v-model:value="keyInput" :placeholder="keyState?.apiKeySet ? t('tracked.keyReplace') : 'AIza…'" autocomplete="off" :maxlength="200" />
        </a-form-item>
        <a-space wrap>
          <a-button type="primary" :loading="keySaving" :disabled="!keyInput.trim()" @click="saveKey(false)">{{ t('common.save') }}</a-button>
          <a-button v-if="keyState?.apiKeySet" danger :loading="keySaving" @click="saveKey(true)">{{ t('tracked.keyClear') }}</a-button>
        </a-space>
      </a-form>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 640px; }
</style>
