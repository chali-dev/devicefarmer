<script setup lang="ts">
import { dateLocale } from '../../i18n'
import { QuestionCircleOutlined } from '@ant-design/icons-vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { TaskRetentionSettings } from '../../api/types'
import { useInstancesStore } from '../../stores/instances'

/**
 * Settings → Data retention (admin): finished tasks of the task centre (editable; cleaned up hourly by a
 * `tasks-cleanup` task). The audit log's retention (read-only) is in LogRetentionSettings (系统配置 → 日志).
 */
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
      <a-typography-title :level="5">
        {{ t('settings.retention.tasksTitle') }}
        <a-tooltip :title="t('settings.retention.tasksHint')"><QuestionCircleOutlined class="muted small" /></a-tooltip>
      </a-typography-title>
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

    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 640px; }
.last { margin: 12px 0 0; }
.env { margin-inline-start: 8px; font-size: 11px; max-width: 100%; white-space: normal; word-break: break-all; }
</style>
