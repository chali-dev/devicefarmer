<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { dateLocale } from '../../i18n'

/**
 * 系统配置 → 发布任务 (admin): the timeout of a publish round's single attempt (GET/PUT /api/settings/publish-retry,
 * key `publish.timeout`; env PUBLISH_TIMEOUT_MS is the default). There are no automatic retries: a failed publish is
 * edited in the content editor and published again. A saved value applies to every round created from then on.
 */
interface Timeout { timeoutSec: number; timeoutMs: number; updatedAt: string | null }
const { t } = useI18n()
const state = ref<{ retry: Timeout; defaults: Timeout } | null>(null)
const form = reactive({ timeoutSec: 600 })
const saving = ref(false)

function fill(r: { retry: Timeout; defaults: Timeout }) {
  state.value = r
  form.timeoutSec = Math.min(3600, Math.max(60, r.retry.timeoutSec))
}
onMounted(async () => { try { fill(await api('GET', '/api/settings/publish-retry')) } catch (e) { message.error(errorText(e)) } })

async function save() {
  saving.value = true
  try {
    fill(await api('PUT', '/api/settings/publish-retry', { timeoutSec: form.timeoutSec }))
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="!state">
      <a-typography-title :level="5">{{ t('settings.publishRetry.title') }}</a-typography-title>
      <a-typography-paragraph type="secondary">{{ t('settings.publishRetry.hint') }}</a-typography-paragraph>
      <a-form layout="vertical">
        <a-row :gutter="12">
          <a-col :xs="24" :sm="12">
            <a-form-item :label="t('settings.publish.timeout')" :extra="state ? t('settings.envDefault', { v: `${state.defaults.timeoutSec} s`, env: 'PUBLISH_TIMEOUT_MS' }) : undefined">
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
</style>
