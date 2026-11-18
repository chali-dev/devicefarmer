<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { DevicePublishRules } from '../../api/types'

/**
 * 风控 → 云手机发帖 (settings key publish.device, GET/PUT /api/publish/device-settings): on/off, posts per account per
 * day, minimum gap. No test mode (removed 2026-11-18): a post is a draft until a person distributes / schedules it, and
 * then the phone really shares it. Over the limits a run is deferred, never dropped.
 */
const { t } = useI18n()
const form = reactive<DevicePublishRules>({ enabled: true, postsPerDay: 3, minGapMin: 60 })
const loading = ref(true)
const saving = ref(false)
const fill = (r: DevicePublishRules) => { Object.assign(form, { enabled: r.enabled, postsPerDay: r.postsPerDay, minGapMin: r.minGapMin }) }
onMounted(async () => {
  try { fill((await api<{ rules: DevicePublishRules }>('GET', '/api/publish/device-settings')).rules) } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
})
async function save() {
  saving.value = true
  try {
    fill((await api<{ rules: DevicePublishRules }>('PUT', '/api/publish/device-settings', { ...form })).rules)
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="loading">
      <a-typography-title :level="5">{{ t('risk.devicePublish.title') }}</a-typography-title>
      <a-typography-paragraph type="secondary">{{ t('risk.devicePublish.hint') }}</a-typography-paragraph>
      <a-form layout="vertical">
        <a-form-item :label="t('risk.devicePublish.enabled')" :extra="t('risk.devicePublish.enabledHint')">
          <a-switch v-model:checked="form.enabled" />
        </a-form-item>
        <a-row :gutter="12">
          <a-col :xs="24" :sm="12">
            <a-form-item :label="t('risk.devicePublish.postsPerDay')"><a-input-number v-model:value="form.postsPerDay" :min="1" :max="50" :precision="0" style="width: 100%" /></a-form-item>
          </a-col>
          <a-col :xs="24" :sm="12">
            <a-form-item :label="t('risk.devicePublish.minGap')">
              <a-input-number v-model:value="form.minGapMin" :min="0" :max="1440" :precision="0" :addon-after="t('risk.devicePublish.minutes')" style="width: 100%" />
            </a-form-item>
          </a-col>
        </a-row>
        <a-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</a-button>
      </a-form>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 720px; }
</style>
