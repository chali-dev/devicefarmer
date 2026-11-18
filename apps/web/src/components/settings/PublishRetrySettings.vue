<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { dateLocale } from '../../i18n'

/**
 * 系统配置 → 发布任务 (admin): attempts per publish round, the base delay of the exponential backoff and the timeout
 * of one attempt (GET/PUT /api/settings/publish-retry, keys `publish.retry` + `publish.timeout`). The env values are
 * the defaults; a saved value is used for every round created or started again from then on
 * (a running round keeps its own).
 */
interface Retry { maxAttempts: number; backoffSec: number; backoffMs: number; timeoutSec: number; timeoutMs: number; updatedAt: string | null }
const { t } = useI18n()
const state = ref<{ retry: Retry; defaults: Retry } | null>(null)
const form = reactive({ maxAttempts: 3, backoffSec: 30, timeoutSec: 600 })
const saving = ref(false)

function fill(r: { retry: Retry; defaults: Retry }) {
  state.value = r
  Object.assign(form, { maxAttempts: r.retry.maxAttempts, backoffSec: r.retry.backoffSec, timeoutSec: Math.min(3600, Math.max(60, r.retry.timeoutSec)) })
}
onMounted(async () => { try { fill(await api('GET', '/api/settings/publish-retry')) } catch (e) { message.error(errorText(e)) } })

async function save() {
  saving.value = true
  try {
    fill(await api('PUT', '/api/settings/publish-retry', { maxAttempts: form.maxAttempts, backoffSec: form.backoffSec, timeoutSec: form.timeoutSec }))
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="!state">
      <a-typography-title :level="5">{{ t('settings.publishRetry.title') }}</a-typography-title>
      <a-form layout="vertical">
        <a-row :gutter="12">
          <a-col :xs="24" :sm="12">
            <a-form-item :label="t('settings.publish.maxAttempts')">
              <a-input-number v-model:value="form.maxAttempts" :min="1" :max="10" :precision="0" style="width: 100%" />
            </a-form-item>
          </a-col>
          <a-col :xs="24" :sm="12">
            <a-form-item :label="t('settings.publish.backoff')">
              <a-input-number v-model:value="form.backoffSec" :min="1" :max="3600" :precision="0" addon-after="s" style="width: 100%" />
            </a-form-item>
          </a-col>
          <a-col :xs="24" :sm="12">
            <a-form-item :label="t('settings.publish.timeout')">
              <a-input-number v-model:value="form.timeoutSec" :min="60" :max="3600" :precision="0" addon-after="s" style="width: 100%" />
            </a-form-item>
          </a-col>
        </a-row>
        <a-space wrap>
          <a-button type="primary" :loading="saving" :disabled="!state" @click="save">{{ t('common.save') }}</a-button>
          <span v-if="state?.retry.updatedAt" class="muted small">{{ t('settings.updatedAt', { at: new Date(state.retry.updatedAt).toLocaleString(dateLocale()) }) }}</span>
        </a-space>
      </a-form>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 640px; }
.block { margin-bottom: 16px; }
</style>
