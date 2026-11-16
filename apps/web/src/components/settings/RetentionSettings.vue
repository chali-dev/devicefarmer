<script setup lang="ts">
import { dateLocale } from '../../i18n'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { TaskRetentionSettings } from '../../api/types'
import { useInstancesStore } from '../../stores/instances'

/**
 * Settings → Data retention (admin): finished tasks of the task centre (editable; cleaned up hourly by a
 * `tasks-cleanup` task) and the audit log (env AUDIT_RETENTION_DAYS, read-only).
 */
defineProps<{ auditRetentionDays: number | null }>()
const { t } = useI18n()
const store = useInstancesStore()
const data = ref<TaskRetentionSettings | null>(null)
const keepForever = ref(false)
const days = ref<number>(90)
const saving = ref(false)
const running = ref(false)

async function load() {
  try {
    data.value = await api<TaskRetentionSettings>('GET', '/api/settings/tasks')
    keepForever.value = data.value.retention.days === null
    days.value = data.value.retention.days ?? data.value.defaultDays
  } catch (e) { message.error(errorText(e)) }
}
onMounted(load)
// The cleanup task's outcome arrives as a task event.
const off = store.onTaskEvent((ev) => { if (ev.type === 'task.updated' && ev.task.type === 'tasks-cleanup') void load() })
onBeforeUnmount(off)

async function save() {
  saving.value = true
  try {
    await api('PUT', '/api/settings/tasks', { retentionDays: keepForever.value ? null : days.value })
    message.success(t('common.saved'))
    await load()
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
async function runNow() {
  running.value = true
  try {
    await api('POST', '/api/settings/tasks/cleanup')
    message.success(t('settings.retention.started'))
    await load()
  } catch (e) { message.error(errorText(e)) }
  finally { running.value = false }
}
const last = computed(() => data.value?.lastCleanup ?? null)
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="!data">
      <h4>{{ t('settings.retention.tasksTitle') }}</h4>
      <p class="muted">{{ t('settings.retention.tasksHint') }}</p>
      <a-form layout="vertical">
        <a-form-item>
          <a-checkbox v-model:checked="keepForever">{{ t('settings.retention.keepForever') }}</a-checkbox>
        </a-form-item>
        <a-form-item v-if="!keepForever" :label="t('settings.retention.days')" :extra="t('settings.retention.default', { n: data?.defaultDays ?? 90 })">
          <a-input-number v-model:value="days" :min="1" :max="data?.maxDays ?? 3650" :precision="0" :addon-after="t('settings.retention.dayUnit')" style="width: 200px" />
        </a-form-item>
        <a-space wrap>
          <a-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</a-button>
          <a-button :loading="running" @click="runNow">{{ t('settings.retention.runNow') }}</a-button>
          <span v-if="data?.retention.updatedAt" class="muted small">{{ t('settings.updatedAt', { at: new Date(data.retention.updatedAt).toLocaleString(dateLocale()) }) }}</span>
        </a-space>
      </a-form>
      <p v-if="last" class="last">
        {{ t('settings.retention.lastRun') }}:
        <router-link :to="{ path: '/tasks', query: { task: last.id } }">{{ new Date(last.createdAt).toLocaleString(dateLocale()) }}</router-link>
        · {{ t(`tasks.status.${last.status}`) }}
        <template v-if="last.result">· {{ t('settings.retention.lastResult', { tasks: last.result.tasks, logs: last.result.logs }) }}</template>
      </p>

      <a-divider />
      <h4>{{ t('settings.retention.auditTitle') }}</h4>
      <p class="muted">{{ t('settings.retention.auditHint') }}</p>
      <a-descriptions size="small" :column="1" bordered>
        <a-descriptions-item :label="t('settings.retention.days')">
          {{ auditRetentionDays ?? '—' }} <a-tag class="ro">{{ t('settings.readOnlyEnv', { name: 'AUDIT_RETENTION_DAYS' }) }}</a-tag>
        </a-descriptions-item>
      </a-descriptions>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 640px; }
.muted { color: var(--cp-text-tertiary); }
.small { font-size: 12px; }
.last { margin-top: 12px; }
.ro { margin-left: 8px; }
</style>
