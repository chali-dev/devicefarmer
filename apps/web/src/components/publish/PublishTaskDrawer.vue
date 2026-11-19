<script setup lang="ts">
import { dateLocale } from '../../i18n'
import { computed, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import dayjs, { type Dayjs } from 'dayjs'
import { useI18n } from 'vue-i18n'
import { logText } from '../../api/logText'
import { api, codeText, errorText } from '../../api/client'
import { deviceListLink } from '../../api/query'
import type { PublishAttempt, PublishLog, PublishRun, PublishTaskItem } from '../../api/types'
import StatusTag from '../common/StatusTag.vue'
import { confirmDanger, DRAWER_WIDTH, MODAL_WIDTH } from '../common/ui'
import MediaStrip from '../content/MediaStrip.vue'
import PlatformTextTabs from '../content/PlatformTextTabs.vue'
import { textMax } from '../social/platformMeta'
import PlatformTag from '../social/PlatformTag.vue'
import PostTypeTag from './PostTypeTag.vue'
import EvidenceModal from '../feed/EvidenceModal.vue'

/**
 * Publish task detail + actions: cancel, reschedule, edit texts, record the manual outcome, and
 * 编辑后重新发布 (no automatic or snapshot retries since 2026-11-18: the content opens in the editor with this account,
 * the person edits it and publishes again, which creates a new publish task; this one stays as history).
 * 发布记录 = every task of this content on this account (编辑后重新发布 leaves several), the shown one marked; a click
 * shows another one in the same drawer.
 * No 打开设备 / 推送素材到设备 buttons (owner 2026-11-18, too many entry points): the device is the 设备 row's link.
 */
const props = defineProps<{ open: boolean; taskId: string | null }>()
const emit = defineEmits<{ 'update:open': [boolean]; changed: [] }>()
const { t } = useI18n()

const task = ref<PublishTaskItem | null>(null)
const logs = ref<PublishLog[]>([])
const runs = ref<PublishRun[]>([])
const history = ref<PublishAttempt[]>([])
/** The task shown: the caller's, or another attempt picked in 发布记录. */
const shownId = ref<string | null>(props.taskId)
const loading = ref(false)
const busy = ref(false)
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')

async function load() {
  if (!shownId.value) return
  loading.value = true
  try {
    const r = await api<{ task: PublishTaskItem; logs: PublishLog[]; runs: PublishRun[]; history?: PublishAttempt[] }>('GET', `/api/publish/tasks/${shownId.value}`)
    task.value = r.task
    logs.value = r.logs
    runs.value = r.runs
    history.value = r.history ?? []
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
watch(() => [props.open, props.taskId], () => { shownId.value = props.taskId; if (props.open) void load() }, { immediate: true })
function showAttempt(id: string) { if (id !== shownId.value) { shownId.value = id; void load() } }
defineExpose({ reload: load })

const s = computed(() => task.value?.status)
const canCancel = computed(() => s.value === 'pending' || s.value === 'scheduled' || s.value === 'awaiting_operator')
const canReschedule = computed(() => s.value === 'pending' || s.value === 'scheduled')
const evidenceOpen = ref(false)
const canOutcome = computed(() => s.value === 'awaiting_operator')
const errorMsg = computed(() => (task.value?.errorCode ? codeText(task.value.errorCode, undefined, task.value.error ?? task.value.errorCode) : null))

async function act(fn: () => Promise<unknown>, ok: string) {
  busy.value = true
  try { await fn(); message.success(ok); await load(); emit('changed') } catch (e) { message.error(errorText(e)) } finally { busy.value = false }
}
function cancel() {
  confirmDanger({
    title: t('publish.cancelConfirm'), okText: t('publish.cancel'),
    onOk: () => act(() => api('POST', `/api/publish/tasks/${task.value!.id}/cancel`), t('publish.cancelled')),
  })
}

// reschedule
const timeOpen = ref(false)
const timeForm = reactive({ now: false, at: null as Dayjs | null })
function openTime() {
  timeForm.now = false
  timeForm.at = task.value ? dayjs(task.value.scheduledAt) : null
  timeOpen.value = true
}
async function submitTime() {
  if (!timeForm.now && !timeForm.at) { message.warning(t('distribute.pickTime')); return }
  const scheduledAt = timeForm.now ? null : timeForm.at!.toISOString()
  timeOpen.value = false
  await act(() => api('POST', `/api/publish/tasks/${task.value!.id}/reschedule`, { scheduledAt }), t('publish.rescheduled'))
}

// edit texts
const editOpen = ref(false)
const editForm = reactive({ title: '' })
/**
 * One text tab: the task's platform (same layout as the content editor). No separate hashtags field (owner 2026-11-18):
 * the caption is edited as it will be posted, so an older task's stored hashtags are folded into it (`text`) and the
 * list is cleared on save; a task without them sends no `hashtags` at all.
 */
const editText = reactive<Record<string, string>>({})
const editTab = ref('')
const editTabs = computed(() => (task.value ? [{ key: task.value.platform, platform: task.value.platform, max: textMax(task.value.platform) }] : []))
function openEdit() {
  Object.assign(editForm, { title: task.value?.title ?? '' })
  editTab.value = task.value?.platform ?? ''
  editText[editTab.value] = (task.value?.hashtags.length ? task.value.text : task.value?.caption) ?? ''
  editOpen.value = true
}
async function submitEdit() {
  editOpen.value = false
  await act(() => api('PATCH', `/api/publish/tasks/${task.value!.id}`, {
    ...(task.value?.platform === 'youtube' ? { title: editForm.title } : {}), caption: editText[editTab.value] ?? '',
    ...(task.value?.hashtags.length ? { hashtags: [] } : {}),
  }), t('common.saved'))
}

// operator outcome
const outcomeOpen = ref(false)
const outForm = reactive({ result: 'published' as 'published' | 'failed', url: '', externalId: '', reason: '' })
const failReason = ref('')
function openOutcome() { Object.assign(outForm, { result: 'published', url: '', externalId: '', reason: '' }); failReason.value = ''; outcomeOpen.value = true }
async function submitOutcome() {
  const body = outForm.result === 'published'
    ? { result: 'published', url: outForm.url.trim() || null, externalId: outForm.externalId.trim() || null }
    : { result: 'failed', reason: failReason.value.trim() }
  busy.value = true
  try {
    await api('POST', `/api/publish/tasks/${task.value!.id}/outcome`, body)
    outcomeOpen.value = false
    message.success(t('publish.recorded'))
    await load(); emit('changed')
  } catch (e) { message.error(errorText(e)) } finally { busy.value = false }
}

const runColumns = computed(() => [
  { title: t('publish.round'), key: 'n', width: 70 }, { title: t('common.status'), key: 'status', width: 100 },
  { title: t('publish.colTime'), key: 'runAt' }, { title: t('common.error'), key: 'error' },
])
const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); message.success(t('publish.copied')) } catch { message.error(t('publish.copyFailed')) } }
</script>

<template>
  <a-drawer :open="open" :title="t('publish.detail')" :width="DRAWER_WIDTH.lg" @close="emit('update:open', false)">
    <a-spin :spinning="loading">
      <template v-if="task">
        <a-space wrap style="margin-bottom: 12px">
          <a-button v-if="canOutcome" type="primary" :disabled="busy" @click="openOutcome">{{ t('publish.outcome') }}</a-button>
          <a-button v-if="task.hasEvidence" @click="evidenceOpen = true">{{ t('publish.evidence') }}</a-button>
          <a-button v-if="canReschedule && task.postType !== 'story' && !task.content?.locked" :disabled="busy" @click="openEdit">{{ t('publish.edit') }}</a-button>
          <a-button v-if="canReschedule" :disabled="busy" @click="openTime">{{ t('publish.reschedule') }}</a-button>
          <a-button v-if="canCancel" danger :disabled="busy" @click="cancel">{{ t('publish.cancel') }}</a-button>
        </a-space>
        <a-alert v-if="canOutcome" type="warning" show-icon :message="t('publish.operatorHint')" style="margin-bottom: 16px">
          <template v-if="task.postType !== 'feed'" #description><b>{{ t('publish.operatorType', { type: t(`publish.type.${task.postType}`) }) }}</b></template>
        </a-alert>
        <a-alert v-if="errorMsg && s === 'scheduled'" type="warning" show-icon :message="errorMsg" style="margin-bottom: 16px" />
        <a-alert v-if="errorMsg && canOutcome && task.method === 'device'" type="error" show-icon :message="errorMsg" style="margin-bottom: 16px" />
        <a-alert v-if="errorMsg && (s === 'failed' || s === 'pending')" type="error" show-icon :message="errorMsg" :description="task.error && task.error !== errorMsg ? task.error : undefined" style="margin-bottom: 16px" />

        <a-descriptions :column="1" size="small" bordered>
          <a-descriptions-item :label="t('common.status')">
            <StatusTag kind="publish" :status="task.status" />
            <span v-if="task.method" class="muted small">{{ t(`publish.method.${task.method}`) }}</span>
            <a-tag v-if="task.republish">{{ t('publish.republish') }}</a-tag>
          </a-descriptions-item>
          <a-descriptions-item :label="t('publish.postType')">
            <PostTypeTag :type="task.postType" /> <b v-if="task.postType !== 'feed'">{{ t('publish.asType', { type: t(`publish.type.${task.postType}`) }) }}</b>
          </a-descriptions-item>
          <a-descriptions-item :label="t('publish.colAccount')">
            <PlatformTag :platform="task.platform" /> @{{ task.account?.handle ?? '—' }}
            <StatusTag v-if="task.account" kind="socialLogin" :status="task.account.loginStatus" style="margin-left: 6px" />
            <StatusTag v-if="task.account && task.account.accountStatus !== 'active'" kind="socialAccount" :status="task.account.accountStatus" />
          </a-descriptions-item>
          <a-descriptions-item :label="t('common.device')">
            <template v-if="task.instance">
              <a-badge :status="task.instance.online ? 'success' : 'default'" />
              <router-link v-if="task.instance.accessible" :to="deviceListLink(task.instance.id)">{{ task.instance.name }}</router-link>
              <span v-else>{{ task.instance.name }}</span>
              · {{ task.instance.online ? t('distribute.online') : t('distribute.offline') }}
            </template>
            <span v-else class="muted">{{ t('distribute.noDevice') }}</span>
          </a-descriptions-item>
          <a-descriptions-item :label="t('publish.colContent')">
            <router-link v-if="task.content" to="/content">{{ task.content.title }}</router-link>
          </a-descriptions-item>
          <a-descriptions-item :label="t('publish.colTime')">{{ fmt(task.scheduledAt) }}</a-descriptions-item>
          <a-descriptions-item v-if="task.publishedAt" :label="t('publish.publishedAt')">{{ fmt(task.publishedAt) }}</a-descriptions-item>
          <a-descriptions-item v-if="task.url || task.externalId" :label="t('publish.result')">
            <a v-if="task.url" :href="task.url" target="_blank" rel="noopener noreferrer">{{ task.url }}</a>
            <span v-if="task.externalId" class="muted small"> {{ t('publish.externalId') }}: {{ task.externalId }}</span>
          </a-descriptions-item>
          <a-descriptions-item v-if="task.title" :label="t('distribute.titleOverride')">
            {{ task.title }} <a @click="copy(task.title!)">{{ t('common.copy') }}</a>
          </a-descriptions-item>
          <a-descriptions-item v-if="task.postType !== 'story'" :label="t('publish.text')">
            <div class="text">{{ task.text || '—' }}</div>
            <a v-if="task.text" @click="copy(task.text)">{{ t('common.copy') }}</a>
          </a-descriptions-item>
          <a-descriptions-item v-if="task.options.privacy" :label="t('distribute.privacy')">{{ t(`distribute.privacyOpt.${task.options.privacy}`) }}</a-descriptions-item>
          <a-descriptions-item v-if="task.evidence?.inputText" :label="t('publish.readBack')"><div class="text">{{ task.evidence.inputText }}</div></a-descriptions-item>
          <a-descriptions-item :label="t('publish.media')"><MediaStrip :media="task.media" :size="64" /></a-descriptions-item>
          <a-descriptions-item v-if="task.ownerName" :label="t('content.colOwner')">{{ task.ownerName }}</a-descriptions-item>
        </a-descriptions>

        <template v-if="history.length > 1">
          <a-divider orientation="left" plain>{{ t('publish.historyTitle', { n: history.length }) }}</a-divider>
          <div v-for="a in history" :key="a.id" class="attempt" :class="{ cur: a.id === task.id }">
            <span class="small">{{ fmt(a.publishedAt ?? a.updatedAt) }}</span>
            <StatusTag kind="publish" :status="a.status" />
            <a-typography-text v-if="a.errorCode" type="danger" class="small">{{ codeText(a.errorCode, undefined, a.error ?? a.errorCode) }}</a-typography-text>
            <a-tag v-if="a.id === task.id" color="blue">{{ t('publish.historyShown') }}</a-tag>
            <a-button v-else type="link" size="small" @click="showAttempt(a.id)">{{ t('common.view') }}</a-button>
          </div>
        </template>

        <a-divider orientation="left" plain>{{ t('publish.runs') }}</a-divider>
        <a-table :data-source="runs" row-key="id" size="small" :pagination="false" :columns="runColumns">
          <template #bodyCell="{ column, record, index }">
            <template v-if="column.key === 'n'">{{ index + 1 }}</template>
            <template v-else-if="column.key === 'status'"><StatusTag kind="task" :status="record.status" /></template>
            <template v-else-if="column.key === 'runAt'">{{ fmt(record.startedAt ?? record.runAt ?? record.createdAt) }}</template>
            <template v-else-if="column.key === 'error'">
              <a-typography-text v-if="record.errorCode" type="danger" class="small">{{ codeText(record.errorCode, undefined, record.error ?? record.errorCode) }}</a-typography-text>
              <span v-else-if="(record.result as any)?.state" class="muted small">{{ t(`publish.status.${(record.result as any).state}`) }}</span>
              <span v-else-if="(record.result as any)?.skipped" class="muted small">{{ t('publish.skipped') }}</span>
            </template>
          </template>
        </a-table>

        <a-divider orientation="left" plain>{{ t('publish.logs') }}</a-divider>
        <a-timeline>
          <a-timeline-item v-for="l in logs" :key="l.id" :color="l.level === 'error' ? 'red' : l.level === 'warn' ? 'orange' : 'blue'">
            <span class="muted small">{{ fmt(l.at) }} · {{ t('publish.roundShort', { n: l.attemptNo ?? 1 }) }}<template v-if="l.actorName"> · {{ l.actorName }}</template></span>
            <div>{{ logText(l.message, l.data) }}</div>
            <div v-if="l.data && Object.keys(l.data).length" class="muted small mono data">{{ JSON.stringify(l.data) }}</div>
          </a-timeline-item>
        </a-timeline>
      </template>
    </a-spin>

    <a-modal v-model:open="timeOpen" :title="t('publish.reschedule')" :width="MODAL_WIDTH.sm" :ok-text="t('common.ok')" :cancel-text="t('common.cancel')" @ok="submitTime">
      <a-radio-group v-model:value="timeForm.now">
        <a-radio :value="true">{{ t('distribute.now') }}</a-radio>
        <a-radio :value="false">{{ t('distribute.at') }}</a-radio>
      </a-radio-group>
      <a-date-picker v-if="!timeForm.now" v-model:value="timeForm.at" show-time style="margin-top: 8px; display: flex" />
    </a-modal>

    <a-modal v-model:open="editOpen" :title="t('publish.edit')" :width="MODAL_WIDTH.md" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" @ok="submitEdit">
      <a-form layout="vertical">
        <a-form-item v-if="task?.platform === 'youtube'" :label="t('distribute.titleOverride')"><a-input v-model:value="editForm.title" :maxlength="100" /></a-form-item>
        <a-form-item :label="t('content.caption')"><PlatformTextTabs v-model:active="editTab" :tabs="editTabs" :values="editText" :rows="5" /></a-form-item>
      </a-form>
    </a-modal>

    <a-modal v-model:open="outcomeOpen" :title="t('publish.outcome')" :width="MODAL_WIDTH.sm" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" :confirm-loading="busy" @ok="submitOutcome">
      <a-form layout="vertical">
        <a-form-item>
          <a-radio-group v-model:value="outForm.result" button-style="solid">
            <a-radio-button value="published">{{ t('publish.outcomePublished') }}</a-radio-button>
            <a-radio-button value="failed">{{ t('publish.outcomeFailed') }}</a-radio-button>
          </a-radio-group>
        </a-form-item>
        <template v-if="outForm.result === 'published'">
          <a-form-item :label="t('publish.postUrl')" :extra="t('publish.linkOrId')"><a-input v-model:value="outForm.url" placeholder="https://" /></a-form-item>
          <a-form-item :label="t('publish.externalId')"><a-input v-model:value="outForm.externalId" :maxlength="200" /></a-form-item>
        </template>
        <template v-else>
          <a-form-item :label="t('publish.reason')"><a-textarea v-model:value="failReason" :rows="3" :maxlength="1000" /></a-form-item>
        </template>
      </a-form>
    </a-modal>
  </a-drawer>
  <EvidenceModal v-model:open="evidenceOpen" :url="task?.hasEvidence ? `/api/publish/tasks/${task.id}/evidence` : null" :title="t('publish.evidenceTitle')" />
</template>

<style scoped>
.text { white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto; }
.data { word-break: break-all; }
.attempt { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 2px 0; }
</style>
