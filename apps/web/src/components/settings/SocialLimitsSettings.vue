<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { SocialPlatform } from '../../api/types'

/** Settings → Social accounts (admin): max accounts per (device, platform). */
const { t } = useI18n()
const platforms = ref<SocialPlatform[]>([])
const limits = reactive<Record<string, number>>({})
const loading = ref(false)
const saving = ref(false)
function fill(list: SocialPlatform[]) {
  platforms.value = list
  for (const p of list) limits[p.id] = p.limit
}
onMounted(async () => {
  loading.value = true
  try { fill((await api<{ platforms: SocialPlatform[] }>('GET', '/api/social/settings')).platforms) } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
})
async function save() {
  saving.value = true
  try {
    fill((await api<{ platforms: SocialPlatform[] }>('PUT', '/api/social/settings', { limits: { ...limits } })).platforms)
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="loading">
      <h4>{{ t('social.limits') }}</h4>
      <p class="muted">{{ t('social.limitsHint') }}</p>
      <a-form layout="horizontal" :label-col="{ span: 8 }">
        <a-form-item v-for="p in platforms" :key="p.id" :label="p.name">
          <a-input-number v-model:value="limits[p.id]" :min="1" :max="100" :precision="0" />
          <span class="muted small">{{ t('social.limitDefault', { n: p.defaultLimit }) }}</span>
        </a-form-item>
        <a-form-item :wrapper-col="{ offset: 8 }">
          <a-button type="primary" :loading="saving" :disabled="!platforms.length" @click="save">{{ t('common.save') }}</a-button>
        </a-form-item>
      </a-form>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 560px; }
.muted { color: var(--cp-text-tertiary); }
.small { font-size: 12px; margin-left: 8px; }
</style>
