<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { CommentRules } from '../../api/types'

/**
 * 风控 → 云手机发评论 (settings key comments.rules, same API as 评论回复规则): sends per account per hour / day,
 * minimum gap, and the test mode switch (default ON: the phone fills the field and takes a screenshot, never taps
 * 发布). Turning test mode off asks for confirmation. Over the limits a send is deferred, never dropped.
 */
const { t } = useI18n()
const form = reactive({ sendsPerHour: 20, sendsPerDay: 50, minGapSec: 60, testMode: true })
const saved = ref<boolean | null>(null)
const loading = ref(true)
const saving = ref(false)
const fill = (r: CommentRules) => { Object.assign(form, { sendsPerHour: r.sendsPerHour, sendsPerDay: r.sendsPerDay, minGapSec: r.minGapSec, testMode: r.testMode }); saved.value = r.testMode }
onMounted(async () => {
  try { fill((await api<{ rules: CommentRules }>('GET', '/api/comments/settings')).rules) } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
})
async function doSave() {
  saving.value = true
  try {
    fill((await api<{ rules: CommentRules }>('PUT', '/api/comments/settings', { ...form })).rules)
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
function save() {
  if (saved.value === true && !form.testMode) {
    Modal.confirm({ title: t('risk.deviceComments.confirmOff'), okType: 'danger', onOk: doSave })
    return
  }
  void doSave()
}
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="loading">
      <a-typography-title :level="5">{{ t('risk.deviceComments.title') }}</a-typography-title>
      <a-typography-paragraph type="secondary">{{ t('risk.deviceComments.hint') }}</a-typography-paragraph>
      <a-alert v-if="saved !== null" :type="saved ? 'info' : 'warning'" show-icon class="block"
        :message="saved ? t('risk.deviceComments.testOn') : t('risk.deviceComments.testOff')" />
      <a-form layout="vertical">
        <a-form-item :label="t('risk.deviceComments.testMode')">
          <a-switch v-model:checked="form.testMode" />
        </a-form-item>
        <a-row :gutter="12">
          <a-col :xs="24" :sm="8">
            <a-form-item :label="t('risk.deviceComments.sendsPerHour')"><a-input-number v-model:value="form.sendsPerHour" :min="1" :max="500" :precision="0" style="width: 100%" /></a-form-item>
          </a-col>
          <a-col :xs="24" :sm="8">
            <a-form-item :label="t('risk.deviceComments.sendsPerDay')"><a-input-number v-model:value="form.sendsPerDay" :min="1" :max="2000" :precision="0" style="width: 100%" /></a-form-item>
          </a-col>
          <a-col :xs="24" :sm="8">
            <a-form-item :label="t('risk.deviceComments.minGap')"><a-input-number v-model:value="form.minGapSec" :min="0" :max="86400" :precision="0" addon-after="s" style="width: 100%" /></a-form-item>
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
