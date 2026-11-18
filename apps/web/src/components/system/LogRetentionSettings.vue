<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'

/** 系统配置 → 备份与保留: how long the API's log files and the device status history (设备日志 / 连线监控) are kept. */
interface SystemSettings { logRetentionDays: number; historyRetentionDays: number }
const { t } = useI18n()
const retention = reactive({ logRetentionDays: 14, historyRetentionDays: 7 })
const loaded = ref(false)
const saving = ref(false)

onMounted(async () => {
  try {
    Object.assign(retention, (await api<{ settings: SystemSettings }>('GET', '/api/system/settings')).settings)
    loaded.value = true
  } catch (e) { message.error(errorText(e)) }
})

async function save() {
  saving.value = true
  try {
    await api('PUT', '/api/system/settings', { logRetentionDays: retention.logRetentionDays, historyRetentionDays: retention.historyRetentionDays })
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
</script>

<template>
  <div>
    <a-typography-title :level="5">{{ t('sysadmin.logs.retention') }}</a-typography-title>
    <a-form layout="inline" class="retention">
      <a-form-item :label="t('sysadmin.logs.logRetention')">
        <a-input-number v-model:value="retention.logRetentionDays" :min="1" :max="365" :precision="0" :addon-after="t('sysadmin.dayUnit')" style="width: 150px" />
      </a-form-item>
      <a-form-item :label="t('sysadmin.logs.historyRetention')">
        <a-input-number v-model:value="retention.historyRetentionDays" :min="1" :max="90" :precision="0" :addon-after="t('sysadmin.dayUnit')" style="width: 150px" />
      </a-form-item>
      <a-form-item><a-button type="primary" :loading="saving" :disabled="!loaded" @click="save">{{ t('common.save') }}</a-button></a-form-item>
    </a-form>
  </div>
</template>

<style scoped>
.retention { row-gap: 8px; }
</style>
