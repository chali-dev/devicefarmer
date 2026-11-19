<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { confirmDanger } from '../common/ui'
import { fmtSize } from '../media/media'
import { useNotificationsStore } from '../../stores/notifications'

/**
 * 系统配置 → 日志 (owner 2026-11-19 「每一行都能独立配置和清理」): every log / history retention, one row each with its
 * own 保存 (PUT /api/system/settings with that field only; tasks / notifications are stored in `tasks.retention` /
 * `alerts.rules`; the days drive the hourly cleanup), its current size (GET /api/system/log-sizes) and 立即清除
 * (owner 2026-11-19 「清除后为 0kb」: POST /api/system/purge/:kind deletes EVERYTHING of that kind after a danger
 * confirmation; tasks: finished ones only). Sizes reload after every save / clear.
 */
type Field = 'logRetentionDays' | 'historyRetentionDays' | 'auditRetentionDays' | 'taskRetentionDays' | 'riskEventsRetentionDays' | 'notificationRetentionDays'
interface View { settings: Record<Field, number | null>; max: Record<Field, number> }
const KIND: Record<Field, string> = {
  logRetentionDays: 'logs', historyRetentionDays: 'history', auditRetentionDays: 'audit',
  taskRetentionDays: 'tasks', riskEventsRetentionDays: 'risk', notificationRetentionDays: 'notifications',
}
const FIELDS = Object.keys(KIND) as Field[]

const { t } = useI18n()
const notifications = useNotificationsStore()
const values = reactive<Record<Field, number | null>>({
  logRetentionDays: 14, historyRetentionDays: 7, auditRetentionDays: 180, taskRetentionDays: 90, riskEventsRetentionDays: 90, notificationRetentionDays: 30,
})
const max = ref<Partial<Record<Field, number>>>({})
const loaded = ref(false)
const busy = reactive<Record<string, boolean>>({})
interface KindSize { bytes: number; rows?: number; files?: number; unfinished?: number }
const sizes = ref<Record<string, KindSize>>({})

async function loadSizes() {
  try { sizes.value = (await api<{ sizes: Record<string, KindSize> }>('GET', '/api/system/log-sizes')).sizes } catch (e) { message.error(errorText(e)) }
}

function sizeText(f: Field): string {
  const s = sizes.value[KIND[f]]
  if (!s) return ''
  const size = fmtSize(s.bytes)
  if (f === 'logRetentionDays') return t('sysadmin.logs.sizeFiles', { size, n: s.files ?? 0 })
  if (f === 'taskRetentionDays') return t('sysadmin.logs.sizeTasks', { size, n: s.rows ?? 0, u: s.unfinished ?? 0 })
  return t('sysadmin.logs.sizeRows', { size, n: s.rows ?? 0 })
}
const sizeTip = (f: Field) => f === 'taskRetentionDays' ? t('sysadmin.logs.tasksSizeTip')
  : f === 'auditRetentionDays' ? t('sysadmin.logs.auditSizeTip') : f === 'logRetentionDays' ? '' : t('sysadmin.logs.dbSizeTip')

onMounted(async () => {
  try {
    const v = await api<View>('GET', '/api/system/settings')
    for (const f of FIELDS) values[f] = v.settings[f]
    if (values.taskRetentionDays === null) values.taskRetentionDays = 90 // an older 永久保留 (null) shows the default
    max.value = v.max
    loaded.value = true
  } catch (e) { message.error(errorText(e)) }
  await loadSizes()
})

async function save(f: Field) {
  busy[`save:${f}`] = true
  try {
    const value = values[f] ?? 1
    await api('PUT', '/api/system/settings', { [f]: value })
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { busy[`save:${f}`] = false }
  void loadSizes()
}

function clean(f: Field) {
  confirmDanger({
    title: t('sysadmin.logs.clearConfirm', { kind: t(`sysadmin.logs.fields.${f}`) }),
    content: t(f === 'taskRetentionDays' ? 'sysadmin.logs.clearTasksContent' : 'sysadmin.logs.clearContent'),
    okText: t('sysadmin.logs.clearOk'),
    onOk: () => clear(f),
  })
}

async function clear(f: Field) {
  busy[`clean:${f}`] = true
  try {
    const { result: r } = await api<{ result: { deleted: number; logs?: number } }>('POST', `/api/system/purge/${KIND[f]}`)
    message.success(f === 'taskRetentionDays' ? t('sysadmin.logs.clearedTasks', { n: r.deleted, logs: r.logs ?? 0 })
      : f === 'logRetentionDays' ? t('sysadmin.logs.clearedFiles', { n: r.deleted }) : t('sysadmin.logs.cleared', { n: r.deleted }))
    if (f === 'notificationRetentionDays') void notifications.refresh() // the bell's unread count
  } catch (e) { message.error(errorText(e)) }
  finally { busy[`clean:${f}`] = false }
  await loadSizes()
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
        <a-tooltip :title="t('sysadmin.logs.cleanTip')">
          <a-button size="small" danger :loading="busy[`clean:${f}`]" :disabled="!loaded" @click="clean(f)">{{ t('sysadmin.logs.cleanNow') }}</a-button>
        </a-tooltip>
      </span>
      <a-tooltip :title="sizeTip(f) || undefined">
        <span class="size">{{ sizeText(f) }}</span>
      </a-tooltip>
    </div>
  </div>
</template>

<style scoped>
.retention { display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.label { width: 80px; flex: none; color: var(--cp-text); }
.actions { display: inline-flex; gap: 8px; }
.size { color: var(--cp-text-secondary); font-variant-numeric: tabular-nums; }
</style>
