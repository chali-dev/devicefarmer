<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'

/** 系统配置 → 日志: how long the API's log files and the device status history (设备日志 / 连线监控) are kept. */
interface SystemSettings { logRetentionDays: number; historyRetentionDays: number }
const { t } = useI18n()
/** AUDIT_RETENTION_DAYS (env, read-only), shown under the log retention (系统配置 → 日志). */
defineProps<{ auditRetentionDays?: number | null }>()
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

/** 立即清理 = the hourly maintenance now (POST /api/system/maintenance): old log files and history rows are deleted. */
const cleaning = ref(false)
async function cleanNow() {
  cleaning.value = true
  try {
    const r = await api<{ logFilesDeleted: number; historyDeleted: number }>('POST', '/api/system/maintenance')
    message.success(t('sysadmin.logs.cleaned', { files: r.logFilesDeleted, rows: r.historyDeleted }))
  } catch (e) { message.error(errorText(e)) }
  finally { cleaning.value = false }
}
</script>

<template>
  <div>
    <a-typography-title :level="5">{{ t('sysadmin.logs.retention') }}</a-typography-title>
    <a-form layout="vertical" class="retention">
      <a-form-item :label="t('sysadmin.logs.logRetention')">
        <a-input-number v-model:value="retention.logRetentionDays" :min="1" :max="365" :precision="0" :addon-after="t('sysadmin.dayUnit')" style="width: 200px" />
      </a-form-item>
      <a-form-item :label="t('sysadmin.logs.historyRetention')">
        <a-input-number v-model:value="retention.historyRetentionDays" :min="1" :max="90" :precision="0" :addon-after="t('sysadmin.dayUnit')" style="width: 200px" />
      </a-form-item>
      <a-space wrap>
        <a-button type="primary" :loading="saving" :disabled="!loaded" @click="save">{{ t('common.save') }}</a-button>
        <a-button :loading="cleaning" @click="cleanNow">{{ t('sysadmin.logs.cleanNow') }}</a-button>
      </a-space>
    </a-form>
    <template v-if="auditRetentionDays !== undefined">
      <a-divider />
      <a-typography-title :level="5">{{ t('settings.retention.auditTitle') }}</a-typography-title>
      <a-descriptions size="small" :column="1" bordered>
        <a-descriptions-item :label="t('settings.retention.days')">
          {{ auditRetentionDays ?? '—' }}
          <a-tooltip :title="t('settings.readOnlyEnv', { name: 'AUDIT_RETENTION_DAYS' })"><a-tag class="env mono">AUDIT_RETENTION_DAYS</a-tag></a-tooltip>
        </a-descriptions-item>
      </a-descriptions>
    </template>
  </div>
</template>

<style scoped>
.retention { row-gap: 8px; }
</style>
