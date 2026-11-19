<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'

/**
 * 系统配置 → 日志 (owner 2026-11-19 「每一行都能独立配置和清理」): every log / history retention, one row each with its
 * own 保存 (PUT /api/system/settings with that field only; tasks / notifications are stored in `tasks.retention` /
 * `alerts.rules`) and 立即清理 (POST /api/system/purge/:kind, that kind only, with the stored retention).
 */
type Field = 'logRetentionDays' | 'historyRetentionDays' | 'auditRetentionDays' | 'taskRetentionDays' | 'riskEventsRetentionDays' | 'notificationRetentionDays'
interface View { settings: Record<Field, number | null>; max: Record<Field, number> }
const KIND: Record<Field, string> = {
  logRetentionDays: 'logs', historyRetentionDays: 'history', auditRetentionDays: 'audit',
  taskRetentionDays: 'tasks', riskEventsRetentionDays: 'risk', notificationRetentionDays: 'notifications',
}
const FIELDS = Object.keys(KIND) as Field[]

const { t } = useI18n()
const values = reactive<Record<Field, number | null>>({
  logRetentionDays: 14, historyRetentionDays: 7, auditRetentionDays: 180, taskRetentionDays: 90, riskEventsRetentionDays: 90, notificationRetentionDays: 30,
})
const max = ref<Partial<Record<Field, number>>>({})
const loaded = ref(false)
const busy = reactive<Record<string, boolean>>({})

onMounted(async () => {
  try {
    const v = await api<View>('GET', '/api/system/settings')
    for (const f of FIELDS) values[f] = v.settings[f]
    if (values.taskRetentionDays === null) values.taskRetentionDays = 90 // an older 永久保留 (null) shows the default
    max.value = v.max
    loaded.value = true
  } catch (e) { message.error(errorText(e)) }
})

async function save(f: Field) {
  busy[`save:${f}`] = true
  try {
    const value = values[f] ?? 1
    await api('PUT', '/api/system/settings', { [f]: value })
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { busy[`save:${f}`] = false }
}

async function clean(f: Field) {
  busy[`clean:${f}`] = true
  try {
    const { result: r } = await api<{ result: { deleted: number; logs?: number } }>('POST', `/api/system/purge/${KIND[f]}`)
    // Only entries older than the saved retention are deleted; say so, so 0 doesn't look like a failure.
    const days = values[f] ?? 0
    message.success(f === 'taskRetentionDays' ? t('sysadmin.logs.cleanedTasks', { n: r.deleted, logs: r.logs ?? 0, days })
      : f === 'logRetentionDays' ? t('sysadmin.logs.cleanedFiles', { n: r.deleted, days }) : t('sysadmin.logs.cleanedRows', { n: r.deleted, days }))
  } catch (e) { message.error(errorText(e)) }
  finally { busy[`clean:${f}`] = false }
}
</script>

<template>
  <div class="retention">
    <div v-for="f in FIELDS" :key="f" class="row">
      <span class="label">{{ t(`sysadmin.logs.fields.${f}`) }}</span>
      <a-input-number
        v-model:value="values[f]" :min="1" :max="max[f] ?? 3650" :precision="0" :addon-after="t('sysadmin.dayUnit')" style="width: 160px"
      />
      <span class="actions">
        <a-button type="primary" size="small" :loading="busy[`save:${f}`]" :disabled="!loaded" @click="save(f)">{{ t('common.save') }}</a-button>
        <a-button size="small" :loading="busy[`clean:${f}`]" :disabled="!loaded" @click="clean(f)">{{ t('sysadmin.logs.cleanNow') }}</a-button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.retention { display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.label { width: 80px; flex: none; color: var(--cp-text); }
.actions { display: inline-flex; gap: 8px; }
</style>
