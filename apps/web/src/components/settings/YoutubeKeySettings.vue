<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'

/** Settings → Tracked accounts (admin): YouTube Data API key. Write-only: the API only says whether it is set. */
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
      <h4>{{ t('tracked.youtubeKey') }}</h4>
      <p class="muted">{{ t('tracked.youtubeKeyHint') }}</p>
      <p>
        {{ t('tracked.youtubeKeyState') }}:
        <a-tag :color="keyState?.apiKeySet ? 'success' : 'default'">{{ keyState?.apiKeySet ? t('tracked.keySet') : t('tracked.keyNotSet') }}</a-tag>
        <span v-if="keyState?.updatedAt" class="muted small">{{ t('settings.updatedAt', { at: new Date(keyState.updatedAt).toLocaleString() }) }}</span>
      </p>
      <a-input-password v-model:value="keyInput" :placeholder="keyState?.apiKeySet ? t('tracked.keyReplace') : 'AIza…'" autocomplete="off" :maxlength="200" />
      <a-space style="margin-top: 12px">
        <a-button type="primary" :loading="keySaving" :disabled="!keyInput.trim()" @click="saveKey(false)">{{ t('common.save') }}</a-button>
        <a-button v-if="keyState?.apiKeySet" danger :loading="keySaving" @click="saveKey(true)">{{ t('tracked.keyClear') }}</a-button>
      </a-space>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 640px; }
.muted { color: var(--cp-text-tertiary); }
.small { font-size: 12px; margin-left: 8px; }
</style>
