<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { DevicePublishRules } from '../../api/types'

/**
 * 风控 → 云手机发帖 (settings key publish.device, GET/PUT /api/publish/device-settings): on/off, posts per account per
 * day, minimum gap, and its own test mode switch (default ON: the phone stops before 分享, takes a screenshot and
 * discards the draft). Turning test mode off asks for confirmation. Over the limits a run is deferred, never dropped.
 */
const { t } = useI18n()
const form = reactive<DevicePublishRules>({ enabled: true, postsPerDay: 3, minGapMin: 60, testMode: true })
const saved = ref<boolean | null>(null)
const loading = ref(true)
const saving = ref(false)
const fill = (r: DevicePublishRules) => { Object.assign(form, r); saved.value = r.testMode }
onMounted(async () => {
  try { fill((await api<{ rules: DevicePublishRules }>('GET', '/api/publish/device-settings')).rules) } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
})
async function doSave() {
  saving.value = true
  try {
    fill((await api<{ rules: DevicePublishRules }>('PUT', '/api/publish/device-settings', { ...form })).rules)
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
function save() {
  if (saved.value === true && !form.testMode) {
    Modal.confirm({ title: t('risk.devicePublish.confirmOff'), okType: 'danger', onOk: doSave })
    return
  }
  void doSave()
}
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="loading">
      <a-typography-title :level="5">{{ t('risk.devicePublish.title') }}</a-typography-title>
      <a-typography-paragraph type="secondary">{{ t('risk.devicePublish.hint') }}</a-typography-paragraph>
      <a-alert v-if="saved !== null" :type="saved ? 'info' : 'warning'" show-icon class="block"
        :message="saved ? t('risk.devicePublish.testOn') : t('risk.devicePublish.testOff')" />
      <a-form layout="vertical">
        <a-row :gutter="12">
          <a-col :xs="24" :sm="12">
            <a-form-item :label="t('risk.devicePublish.enabled')" :extra="t('risk.devicePublish.enabledHint')">
              <a-switch v-model:checked="form.enabled" />
            </a-form-item>
          </a-col>
          <a-col :xs="24" :sm="12">
            <a-form-item :label="t('risk.devicePublish.testMode')">
              <a-switch v-model:checked="form.testMode" />
            </a-form-item>
          </a-col>
        </a-row>
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
.block { margin-bottom: 16px; }
</style>
