<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'

/**
 * 系统配置 → 日志: every log / history retention in one form, one row each, one 保存 (PUT /api/system/settings, which
 * also writes the task retention `tasks.retention` and the notification retention `alerts.rules`). 立即清理 runs every purge.
 */
type Field = 'logRetentionDays' | 'historyRetentionDays' | 'auditRetentionDays' | 'taskRetentionDays' | 'riskEventsRetentionDays' | 'notificationRetentionDays'
interface View { settings: Record<Field, number | null>; max: Record<Field, number> }
const FIELDS: Field[] = ['logRetentionDays', 'historyRetentionDays', 'auditRetentionDays', 'taskRetentionDays', 'riskEventsRetentionDays', 'notificationRetentionDays']

const { t } = useI18n()
const values = reactive<Record<Field, number | null>>({
  logRetentionDays: 14, historyRetentionDays: 7, auditRetentionDays: 180, taskRetentionDays: 90, riskEventsRetentionDays: 90, notificationRetentionDays: 30,
})
const max = ref<Partial<Record<Field, number>>>({})
/** 任务日志 永久保留 (stored as null); the input keeps its last number. */
const keepTasks = ref(false)
const loaded = ref(false)
const saving = ref(false)

onMounted(async () => {
  try {
    const v = await api<View>('GET', '/api/system/settings')
    for (const f of FIELDS) values[f] = v.settings[f]
    keepTasks.value = v.settings.taskRetentionDays === null
    if (keepTasks.value) values.taskRetentionDays = 90
    max.value = v.max
    loaded.value = true
  } catch (e) { message.error(errorText(e)) }
})

async function save() {
  saving.value = true
  try {
    const body: Record<string, number | null> = {}
    for (const f of FIELDS) body[f] = values[f] ?? 1
    body.taskRetentionDays = keepTasks.value ? null : (values.taskRetentionDays ?? 1)
    await api('PUT', '/api/system/settings', body)
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}

/** 立即清理 = every retention purge now (POST /api/system/maintenance). */
interface PurgeResult { logFilesDeleted: string[]; historyDeleted: number; auditDeleted: number; tasksDeleted: number; riskEventsDeleted: number; notificationsDeleted: number }
const cleaning = ref(false)
async function cleanNow() {
  cleaning.value = true
  try {
    const { result: r } = await api<{ result: PurgeResult }>('POST', '/api/system/maintenance')
    message.success(t('sysadmin.logs.cleaned', {
      files: r.logFilesDeleted.length, history: r.historyDeleted, audit: r.auditDeleted, tasks: r.tasksDeleted, risk: r.riskEventsDeleted, notes: r.notificationsDeleted,
    }))
  } catch (e) { message.error(errorText(e)) }
  finally { cleaning.value = false }
}
</script>

<template>
  <a-form layout="vertical" class="retention">
    <a-form-item v-for="f in FIELDS" :key="f" :label="t(`sysadmin.logs.fields.${f}`)">
      <a-space>
        <a-input-number
          v-model:value="values[f]" :min="1" :max="max[f] ?? 3650" :precision="0" :addon-after="t('sysadmin.dayUnit')"
          :disabled="f === 'taskRetentionDays' && keepTasks" style="width: 200px"
        />
        <a-checkbox v-if="f === 'taskRetentionDays'" v-model:checked="keepTasks">{{ t('sysadmin.logs.keepForever') }}</a-checkbox>
      </a-space>
    </a-form-item>
    <a-space wrap>
      <a-button type="primary" :loading="saving" :disabled="!loaded" @click="save">{{ t('common.save') }}</a-button>
      <a-button :loading="cleaning" @click="cleanNow">{{ t('sysadmin.logs.cleanNow') }}</a-button>
    </a-space>
  </a-form>
</template>

<style scoped>
.retention { row-gap: 8px; }
</style>
