<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import { fmtDateTime } from '../../i18n'
import { useInstancesStore } from '../../stores/instances'
import { fetchAuthBlob, fmtSize } from '../media/media'
import StatusTag from '../common/StatusTag.vue'
import { actionColumn, pagination, TABLE_SIZE } from '../common/ui'

/**
 * Database backups (数据库备份): daily schedule + keep N, back up now, list (newest row only until 展开), download,
 * delete, 导入 (restore the whole database from one, task db-restore with a safety backup first; typed confirmation).
 */
interface Backup {
  id: string; status: 'running' | 'ok' | 'failed'; trigger: 'manual' | 'scheduled' | 'pre-restore'; storage: 'local' | 's3'; key: string
  size: number | null; error: string | null; errorCode: string | null; taskId: string | null; createdAt: string; finishedAt: string | null
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
const expanded = ref(false)
const shown = computed(() => (expanded.value ? backups.value : backups.value.slice(0, 1)))

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
const off = store.onTaskEvent((ev) => {
  if (ev.type !== 'task.updated') return
  if (ev.task.type === 'db-backup' || ev.task.type === 'db-restore') void reloadList()
  if (ev.task.id === restoreTask.value) void checkRestore()
})
onBeforeUnmount(() => { off(); stopPoll() })

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

// ------------------------------------------------------------ 导入
const restoring = ref<Backup | null>(null)
const typed = ref('')
const restoreTask = ref<string | null>(null)
const restoreBusy = ref(false)
let poll: ReturnType<typeof setInterval> | null = null
function stopPoll() { if (poll) { clearInterval(poll); poll = null } }
function askRestore(b: Backup) { restoring.value = b; typed.value = '' }
const typedOk = computed(() => typed.value.trim().toLowerCase() === t('sysadmin.backup.restoreWord').toLowerCase())
async function startRestore() {
  const b = restoring.value
  if (!b || !typedOk.value) return
  restoreBusy.value = true
  try {
    const r = await api<{ task: { id: string } }>('POST', `/api/system/backups/${b.id}/restore`)
    restoring.value = null
    restoreTask.value = r.task.id
    message.info(t('sysadmin.backup.restoreStarted'))
    // Events may stop once the users table is replaced: poll as well.
    stopPoll()
    poll = setInterval(() => void checkRestore(), 3000)
  } catch (e) { message.error(errorText(e)) }
  finally { restoreBusy.value = false }
}
async function checkRestore() {
  const id = restoreTask.value
  if (!id) return
  try {
    const { task } = await api<{ task: { status: string; error: string | null; errorCode: string | null } }>('GET', `/api/tasks/${id}`)
    if (task.status === 'success') {
      message.success({ content: t('sysadmin.backup.restoreDone'), duration: 10 })
    } else if (task.status === 'failed' || task.status === 'cancelled') {
      message.error({ content: t('sysadmin.backup.restoreFailed', { reason: codeText(task.errorCode, undefined, task.error ?? '') }), duration: 10 })
    } else return
  } catch { return /* next tick */ }
  restoreTask.value = null
  stopPoll()
  await reloadList()
}

/** Translated failure reason (coded error), raw message as fallback. */
const reason = (b: Backup) => codeText(b.errorCode, undefined, b.error ?? '')
/** Newest finished backup failed because the backup command could not run: short warning above the list. */
const cmdProblem = computed(() => {
  const last = backups.value.find((b) => b.status !== 'running')
  return last?.status === 'failed' && last.errorCode?.startsWith('system.backup_cmd') ? last : null
})

const columns = computed(() => [
  { title: t('common.time'), key: 'createdAt', width: 180 },
  { title: t('common.status'), key: 'status', width: 100 },
  { title: t('sysadmin.backup.trigger'), key: 'trigger', width: 100 },
  { title: t('sysadmin.backup.storage'), key: 'storage', width: 110 },
  { title: t('sysadmin.backup.size'), key: 'size', width: 110 },
  { title: t('sysadmin.backup.error'), key: 'error', width: 280 },
  { title: t('common.name'), key: 'key', ellipsis: true, width: 260 },
  actionColumn(190),
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
      <a-space :size="12" align="baseline">
        <a-typography-title :level="5" class="head-title">{{ t('sysadmin.backup.list') }}</a-typography-title>
        <a v-if="backups.length > 1" @click="expanded = !expanded">{{ expanded ? t('sysadmin.backup.collapse') : t('sysadmin.backup.expand', { n: backups.length }) }}</a>
      </a-space>
      <a-space wrap>
        <a-button type="primary" :loading="starting" @click="backupNow">{{ t('sysadmin.backup.now') }}</a-button>
      </a-space>
    </div>
    <a-alert
      v-if="cmdProblem" type="warning" show-icon class="warn"
      :message="t('sysadmin.backup.cmdWarning', { reason: reason(cmdProblem) })"
    >
      <template #description><code class="mono small">PG_DUMP_CMD={{ pgDumpCmd }}</code></template>
    </a-alert>
    <a-table
      :data-source="shown" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading"
      :pagination="pagination({ hideOnSinglePage: true })" :locale="{ emptyText: t('sysadmin.backup.empty') }" :scroll="{ x: 1290 }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'createdAt'">{{ fmtDateTime(record.createdAt) }}</template>
        <template v-else-if="column.key === 'status'">
          <StatusTag kind="backup" :status="record.status" />
        </template>
        <template v-else-if="column.key === 'trigger'">{{ t(`sysadmin.backup.triggers.${record.trigger}`) }}</template>
        <template v-else-if="column.key === 'storage'">{{ t(`sysadmin.backup.storages.${record.storage}`) }}</template>
        <template v-else-if="column.key === 'size'">{{ record.size !== null ? fmtSize(record.size) : '—' }}</template>
        <template v-else-if="column.key === 'error'">
          <a-tooltip v-if="record.status === 'failed'" :title="record.error">
            <a-typography-text type="danger" :ellipsis="true" :content="reason(record as Backup)" />
          </a-tooltip>
        </template>
        <template v-else-if="column.key === 'key'">
          <router-link v-if="record.taskId" :to="{ path: '/tasks', query: { task: record.taskId } }" class="mono">{{ record.key }}</router-link>
          <span v-else class="mono">{{ record.key }}</span>
        </template>
        <template v-else-if="column.key === 'ops'">
          <a-space :size="0">
            <a-button size="small" type="link" :disabled="record.status !== 'ok'" @click="download(record as Backup)">{{ t('sysadmin.backup.download') }}</a-button>
            <a-button size="small" type="link" danger :disabled="record.status !== 'ok' || !!restoreTask" @click="askRestore(record as Backup)">{{ t('sysadmin.backup.restore') }}</a-button>
            <a-popconfirm :title="t('sysadmin.backup.deleteConfirm')" :disabled="record.status === 'running'" @confirm="remove(record as Backup)">
              <a-button size="small" type="link" danger :disabled="record.status === 'running'">{{ t('common.delete') }}</a-button>
            </a-popconfirm>
          </a-space>
        </template>
      </template>
    </a-table>


    <a-modal
      :open="!!restoring" :title="restoring ? t('sysadmin.backup.restoreTitle', { time: fmtDateTime(restoring.createdAt) }) : ''"
      :ok-text="t('sysadmin.backup.restore')" :ok-button-props="{ danger: true, disabled: !typedOk }" :confirm-loading="restoreBusy"
      @ok="startRestore" @cancel="restoring = null"
    >
      <a-alert type="error" show-icon :message="t('sysadmin.backup.restoreWarn')" class="warn" />
      <p class="muted">{{ t('sysadmin.backup.restoreSafety') }}</p>
      <p v-if="restoring" class="mono small">{{ restoring.key }}</p>
      <a-input v-model:value="typed" :placeholder="t('sysadmin.backup.restoreType', { word: t('sysadmin.backup.restoreWord') })" @press-enter="startRestore" />
    </a-modal>
  </div>
</template>

<style scoped>
.schedule { row-gap: 8px; }
.head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.head-title { margin: 0; }
.warn { margin-bottom: 12px; }
code { word-break: break-all; }
</style>
