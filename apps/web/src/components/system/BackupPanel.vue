<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ReloadOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { dateLocale } from '../../i18n'
import { useInstancesStore } from '../../stores/instances'
import { fetchAuthBlob, fmtSize } from '../media/media'
import StatusTag from '../common/StatusTag.vue'
import { actionColumn, pagination, TABLE_SIZE } from '../common/ui'

/** Database backups (数据库备份): daily schedule + keep N, back up now, list, download, delete. */
interface Backup {
  id: string; status: 'running' | 'ok' | 'failed'; trigger: 'manual' | 'scheduled'; storage: 'local' | 's3'; key: string
  size: number | null; error: string | null; taskId: string | null; createdAt: string; finishedAt: string | null
}
interface SystemSettings { backup: { enabled: boolean; hour: number; keep: number }; logRetentionDays: number; historyRetentionDays: number; updatedAt: string | null }

const { t } = useI18n()
const store = useInstancesStore()
const backups = ref<Backup[]>([])
const pgDumpCmd = ref('')
const loading = ref(false)
const form = reactive({ enabled: true, hour: 3, keep: 7 })
const saving = ref(false)
const starting = ref(false)

async function load() {
  loading.value = true
  try {
    const [b, s] = await Promise.all([
      api<{ backups: Backup[]; pgDumpCmd: string }>('GET', '/api/system/backups'),
      api<{ settings: SystemSettings }>('GET', '/api/system/settings'),
    ])
    backups.value = b.backups
    pgDumpCmd.value = b.pgDumpCmd
    Object.assign(form, s.settings.backup)
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
async function reloadList() {
  try { backups.value = (await api<{ backups: Backup[] }>('GET', '/api/system/backups')).backups } catch { /* next event */ }
}
onMounted(load)
const off = store.onTaskEvent((ev) => { if (ev.type === 'task.updated' && ev.task.type === 'db-backup') void reloadList() })
onBeforeUnmount(off)

async function save() {
  saving.value = true
  try {
    await api('PUT', '/api/system/settings', { backup: { ...form } })
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
async function backupNow() {
  starting.value = true
  try {
    await api('POST', '/api/system/backups')
    message.success(t('sysadmin.backup.started'))
  } catch (e) { message.error(errorText(e)) }
  finally { starting.value = false }
}
async function download(b: Backup) {
  try {
    const url = URL.createObjectURL(await fetchAuthBlob(`/api/system/backups/${b.id}/download`))
    const a = document.createElement('a')
    a.href = url
    a.download = b.key.split('/').pop() ?? 'backup.dump'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch (e) { message.error(errorText(e)) }
}
async function remove(b: Backup) {
  try {
    await api('DELETE', `/api/system/backups/${b.id}`)
    message.success(t('common.deleted'))
    await reloadList()
  } catch (e) { message.error(errorText(e)) }
}

const restoreCmd = 'pg_restore --clean --if-exists --no-owner -h <host> -U <user> -d <database> <file>.dump'
const columns = computed(() => [
  { title: t('common.time'), key: 'createdAt', width: 180 },
  { title: t('common.status'), key: 'status', width: 100 },
  { title: t('sysadmin.backup.trigger'), key: 'trigger', width: 100 },
  { title: t('sysadmin.backup.storage'), key: 'storage', width: 110 },
  { title: t('sysadmin.backup.size'), key: 'size', width: 110 },
  { title: t('common.name'), key: 'key', ellipsis: true, width: 260 },
  actionColumn(150),
])
</script>

<template>
  <div>
    <a-typography-title :level="5">{{ t('sysadmin.backup.schedule') }}</a-typography-title>
    <a-form layout="inline" class="schedule">
      <a-form-item><a-checkbox v-model:checked="form.enabled">{{ t('sysadmin.backup.enabled') }}</a-checkbox></a-form-item>
      <a-form-item :label="t('sysadmin.backup.hour')">
        <a-select v-model:value="form.hour" :disabled="!form.enabled" style="width: 170px">
          <a-select-option v-for="h in 24" :key="h - 1" :value="h - 1">{{ t('sysadmin.backup.hourOption', { h: h - 1 }) }}</a-select-option>
        </a-select>
      </a-form-item>
      <a-form-item :label="t('sysadmin.backup.keep')">
        <a-tooltip :title="t('sysadmin.backup.keepHint')"><a-input-number v-model:value="form.keep" :min="1" :max="365" :precision="0" style="width: 100px" /></a-tooltip>
      </a-form-item>
      <a-form-item><a-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</a-button></a-form-item>
    </a-form>

    <a-divider />
    <div class="head">
      <a-typography-title :level="5" class="head-title">{{ t('sysadmin.backup.list') }}</a-typography-title>
      <a-space wrap>
        <a-tooltip :title="t('common.refresh')">
          <a-button :loading="loading" :aria-label="t('common.refresh')" @click="load"><template #icon><ReloadOutlined /></template></a-button>
        </a-tooltip>
        <a-button type="primary" :loading="starting" @click="backupNow">{{ t('sysadmin.backup.now') }}</a-button>
      </a-space>
    </div>
    <a-table
      :data-source="backups" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading"
      :pagination="pagination({ hideOnSinglePage: true })" :locale="{ emptyText: t('sysadmin.backup.empty') }" :scroll="{ x: 1010 }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'createdAt'">{{ new Date(record.createdAt).toLocaleString(dateLocale()) }}</template>
        <template v-else-if="column.key === 'status'">
          <a-tooltip :title="record.error"><span><StatusTag kind="backup" :status="record.status" /></span></a-tooltip>
        </template>
        <template v-else-if="column.key === 'trigger'">{{ t(`sysadmin.backup.triggers.${record.trigger}`) }}</template>
        <template v-else-if="column.key === 'storage'">{{ t(`sysadmin.backup.storages.${record.storage}`) }}</template>
        <template v-else-if="column.key === 'size'">{{ record.size !== null ? fmtSize(record.size) : '—' }}</template>
        <template v-else-if="column.key === 'key'">
          <router-link v-if="record.taskId" :to="{ path: '/tasks', query: { task: record.taskId } }" class="mono">{{ record.key }}</router-link>
          <span v-else class="mono">{{ record.key }}</span>
        </template>
        <template v-else-if="column.key === 'ops'">
          <a-space :size="0">
            <a-button size="small" type="link" :disabled="record.status !== 'ok'" @click="download(record as Backup)">{{ t('sysadmin.backup.download') }}</a-button>
            <a-popconfirm :title="t('sysadmin.backup.deleteConfirm')" :disabled="record.status === 'running'" @confirm="remove(record as Backup)">
              <a-button size="small" type="link" danger :disabled="record.status === 'running'">{{ t('common.delete') }}</a-button>
            </a-popconfirm>
          </a-space>
        </template>
      </template>
    </a-table>

    <a-descriptions size="small" :column="1" bordered class="info">
      <a-descriptions-item :label="t('sysadmin.backup.command')">
        <code class="mono small">{{ pgDumpCmd }} --format=custom --compress=6 …</code>
      </a-descriptions-item>
      <a-descriptions-item :label="t('sysadmin.backup.restoreTitle')">
        <div class="muted small">{{ t('sysadmin.backup.restoreHint') }}</div>
        <code class="mono small">{{ restoreCmd }}</code>
      </a-descriptions-item>
    </a-descriptions>
  </div>
</template>

<style scoped>
.schedule { row-gap: 8px; }
.head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.head-title { margin: 0; }
.info { margin-top: var(--cp-gap); }
code { word-break: break-all; }
</style>
