<script setup lang="ts">
import { fmtDateTime } from '../i18n'
import { CheckOutlined, InboxOutlined, QuestionCircleOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import { egressGeo, taskText, type InstalledApp, type Task } from '../api/types'
import { useRouter } from 'vue-router'
import DevicePlayer from '../components/DevicePlayer.vue'
import { downloadScreenshot, uploadDeviceFile } from '../api/device'
import PageContainer from '../components/common/PageContainer.vue'
import StatusTag from '../components/common/StatusTag.vue'
import { actionColumn, confirmAction, confirmDanger } from '../components/common/ui'
import DeviceSocialCard from '../components/social/DeviceSocialCard.vue'
import { useInstancesStore } from '../stores/instances'
import { useAuthStore } from '../stores/auth'

const props = defineProps<{ id: string }>()
const store = useInstancesStore()
const auth = useAuthStore()
const router = useRouter()
const { t } = useI18n()
const player = ref<InstanceType<typeof DevicePlayer> | null>(null)

const inst = computed(() => store.byId.get(props.id))
// The store only holds the latest tasks of all devices; load this device's own history too,
// and let live store entries (newer) win over the loaded copy.
const ownTasks = ref<Task[]>([])
async function loadOwnTasks() {
  try { ownTasks.value = (await api<{ tasks: Task[] }>('GET', `/api/tasks?instanceId=${props.id}&limit=10`)).tasks } catch { /* list stays live-only */ }
}
onMounted(loadOwnTasks)
const tasks = computed(() => {
  const merged = new Map(ownTasks.value.map((t) => [t.id, t]))
  for (const t of store.tasks) if (t.instanceId === props.id) merged.set(t.id, t)
  return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10)
})
const text = ref('')
const secure = ref(false)
const uploading = ref(false)

function sendText() {
  if (!text.value) return
  // Secure mode: per-character key events, nothing on the device clipboard, nothing stored.
  if (secure.value) player.value?.typeSecure(text.value)
  else player.value?.paste(text.value)
  text.value = ''
}

async function upload(opt: { file: File; onSuccess?: (r: unknown) => void; onError?: (e: Error) => void }) {
  uploading.value = true
  try {
    const r = await store.installApp([props.id], opt.file)
    message.success(t('detail.uploadedApk', { name: opt.file.name, n: r.apks }))
    opt.onSuccess?.(r)
  } catch (e) {
    message.error(errorText(e))
    opt.onError?.(e as Error)
  } finally {
    uploading.value = false
  }
}

// ---- installed apps
const appsList = ref<InstalledApp[]>([])
const appsLoading = ref(false)
async function loadApps() {
  if (inst.value?.status !== 'running') return
  appsLoading.value = true
  try { appsList.value = (await api<{ apps: InstalledApp[] }>('GET', `/api/instances/${props.id}/apps`)).apps }
  catch (e) { message.error(errorText(e)) }
  finally { appsLoading.value = false }
}
function uninstall(pkg: string) {
  confirmDanger({
    title: t('detail.apps.confirmUninstall', { pkg }), content: t('detail.apps.uninstallContent'), okText: t('common.uninstall'),
    onOk: async () => {
      try { await store.uninstallApp([props.id], pkg); message.success(t('detail.apps.uninstallSubmitted')) }
      catch (e) { message.error(errorText(e)) }
    },
  })
}
// refresh the list when an install/uninstall task for this instance finishes
watch(() => tasks.value.filter((t) => (t.type === 'install-apk' || t.type === 'uninstall-app') && t.status === 'success').length, () => void loadApps())
watch(() => inst.value?.status, (s) => { if (s === 'running') void loadApps() }, { immediate: true })

// ---- upload files (photos/videos) into the phone's shared storage
const fileUploading = ref(false)
const lastUploads = ref<string[]>([])
async function uploadFile(opt: { file: File; onSuccess?: (r: unknown) => void; onError?: (e: Error) => void }) {
  fileUploading.value = true
  try {
    const r = await uploadDeviceFile(props.id, opt.file)
    lastUploads.value = [r.path, ...lastUploads.value].slice(0, 5)
    message.success(t('detail.files.uploaded', { folder: r.folder }))
    opt.onSuccess?.(r)
  } catch (e) { message.error(errorText(e)); opt.onError?.(e as Error) }
  finally { fileUploading.value = false }
}

// ---- app library import
async function importToLibrary(pkg: string) {
  try { await api('POST', '/api/library/import', { instanceId: props.id, package: pkg }); message.success(t('detail.apps.importing', { pkg })) }
  catch (e) { message.error(errorText(e)) }
}

// ---- network: the proxy is set at the phone's source; the egress is measured on the phone itself
const proxyChecking = ref(false)
async function checkProxy() {
  proxyChecking.value = true
  try { await api('POST', `/api/instances/${props.id}/proxy/check`) }
  catch (e) { message.error(errorText(e)) }
  finally { proxyChecking.value = false }
}

// ---- screenshot (full resolution PNG from the device)
const shooting = ref(false)
async function screenshot() {
  shooting.value = true
  try { await downloadScreenshot(props.id, inst.value?.name ?? props.id) }
  catch (e) { message.error(errorText(e)) }
  finally { shooting.value = false }
}

async function act(a: 'start' | 'stop' | 'restart') {
  const go = async () => {
    try {
      const r = await store.action(a, [props.id])
      if (r.skipped.length) message.warning(r.skipped[0]!.reason)
    } catch (e) {
      message.error(errorText(e))
    }
  }
  // BitBrowser phones are billed from power-on until shutdown.
  if (inst.value?.engine === 'bitbrowser' && a !== 'stop') {
    confirmAction({ title: t('devices.ext.billingTitle'), content: t('devices.ext.billingConfirm'), okText: t(`devices.${a}`), onOk: go })
  } else await go()
}
const appColumns = computed(() => [
  { title: t('detail.apps.package'), dataIndex: 'package', key: 'package' },
  { title: t('detail.apps.version'), key: 'version', width: 160 },
  actionColumn(170),
])
</script>


<template>
  <a-result v-if="!inst && !store.loading" status="404" :title="t('detail.notFound')">
    <template #extra><a-button @click="router.push('/instances')">{{ t('detail.backToList') }}</a-button></template>
  </a-result>

  <PageContainer v-else-if="inst" :title="inst.name">
    <template #title-suffix><StatusTag :status="inst.status" /></template>
    <template #extra>
      <a-button :loading="shooting" :disabled="inst.status !== 'running'" @click="screenshot">{{ t('detail.screenshot') }}</a-button>
      <template v-if="auth.isAdmin">
        <a-button :disabled="inst.status === 'running'" @click="act('start')">{{ t('devices.start') }}</a-button>
        <a-button :disabled="inst.status !== 'running'" @click="act('stop')">{{ t('devices.stop') }}</a-button>
        <a-button @click="act('restart')">{{ t('devices.restart') }}</a-button>
      </template>
    </template>

    <a-alert v-if="inst.lastError" type="error" :message="inst.lastError" show-icon />

    <a-row :gutter="[16, 16]">
      <a-col :xs="24" :lg="11" :xl="9">
        <a-card :bordered="false" class="player-card">
          <DevicePlayer
            v-if="inst.status === 'running'"
            ref="player"
            :key="inst.id"
            :instance-id="inst.id"
            :width="inst.spec.width"
            :height="inst.spec.height"
          />
          <a-empty v-else :description="t('detail.notRunning', { status: t(`status.${inst.status}`) })" />
        </a-card>
      </a-col>

      <a-col :xs="24" :lg="13" :xl="15">
        <div class="stack">
          <a-card :bordered="false" :title="t('cloud.basic')">
            <a-descriptions bordered size="small" :column="{ xs: 1, sm: 2 }">
              <a-descriptions-item :label="t('detail.engine')">{{ t(`devices.ext.kinds.${inst.engine}`) }}</a-descriptions-item>
              <a-descriptions-item :label="t('detail.boot')">{{ inst.bootCompleted ? t('detail.bootDone') : t('detail.bootPending') }}</a-descriptions-item>
              <a-descriptions-item label="ADB">{{ inst.adbState ?? '—' }}</a-descriptions-item>
              <a-descriptions-item label="STF">{{ inst.stfReady ? t('detail.stfReady') : t('detail.stfNotReady') }}</a-descriptions-item>
              <a-descriptions-item :label="t('devices.colAdbPort')">{{ inst.adbPort }}</a-descriptions-item>
              <a-descriptions-item :label="t('devices.colResolution')">{{ inst.spec.width }}×{{ inst.spec.height }} @ {{ inst.spec.dpi }}dpi</a-descriptions-item>
              <a-descriptions-item :label="t('devices.ext.phoneId')" :span="2"><a-typography-text copyable>{{ inst.externalId }}</a-typography-text></a-descriptions-item>
            </a-descriptions>
          </a-card>

          <a-card :bordered="false" :title="t('detail.input.title')">
            <template #extra>
              <a-tooltip :title="t('detail.input.secureTip')">
                <a-space :size="4"><a-switch v-model:checked="secure" size="small" />{{ t('detail.input.secure') }}</a-space>
              </a-tooltip>
            </template>
            <a-input-password v-if="secure" v-model:value="text" :placeholder="t('detail.input.securePlaceholder')" :disabled="inst.status !== 'running'" autocomplete="off" @press-enter="sendText">
              <template #addonAfter><a @click="sendText">{{ t('common.send') }}</a></template>
            </a-input-password>
            <a-input-search
              v-else
              v-model:value="text"
              :placeholder="t('detail.input.placeholder')"
              :enter-button="t('common.send')"
              :disabled="inst.status !== 'running'"
              @search="sendText"
            />
          </a-card>

          <a-card :bordered="false" :title="t('detail.files.title')">
            <a-upload-dragger :multiple="true" :show-upload-list="false" :custom-request="uploadFile as any" :disabled="inst.status !== 'running' || fileUploading">
              <p class="ant-upload-drag-icon"><InboxOutlined /></p>
              <p class="ant-upload-text">{{ fileUploading ? t('common.uploading') : t('detail.files.drop') }}</p>
            </a-upload-dragger>
            <div v-for="p in lastUploads" :key="p" class="muted small upload-line"><CheckOutlined /> {{ p }}</div>
          </a-card>

          <a-card :bordered="false" :title="t('detail.apps.title')">
            <template #extra>
              <a-button size="small" :loading="appsLoading" :disabled="inst.status !== 'running'" @click="loadApps">{{ t('common.refresh') }}</a-button>
            </template>
            <a-upload-dragger
              accept=".apk,.apks,.xapk,.apkm,.zip"
              :show-upload-list="false"
              :custom-request="upload as any"
              :disabled="inst.status !== 'running' || uploading"
              style="margin-bottom: 12px"
            >
              <p class="ant-upload-drag-icon"><InboxOutlined /></p>
              <p class="ant-upload-text">{{ uploading ? t('common.uploading') : t('detail.apps.drop') }}</p>
            </a-upload-dragger>
            <a-table :data-source="appsList" :columns="appColumns" row-key="package" size="small" :pagination="false" :loading="appsLoading" :scroll="{ x: 560 }"
              :locale="{ emptyText: inst.status === 'running' ? t('detail.apps.empty') : t('detail.apps.deviceNotRunning') }">
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'version'">{{ record.versionName ?? '—' }}</template>
                <template v-else-if="column.key === 'ops'">
                  <a-tag v-if="record.protected">{{ t('detail.apps.platform') }}</a-tag>
                  <a-space v-else :size="0">
                    <a-button v-if="auth.isAdmin" type="link" size="small" @click="importToLibrary(record.package)">{{ t('detail.apps.addToLibrary') }}</a-button>
                    <a-button type="link" size="small" danger @click="uninstall(record.package)">{{ t('common.uninstall') }}</a-button>
                  </a-space>
                </template>
              </template>
            </a-table>
          </a-card>

          <a-card :bordered="false">
            <template #title>
              <a-space :size="4">
                {{ t('detail.proxy.title') }}
                <a-tooltip :title="t('devices.ext.proxyHint')"><QuestionCircleOutlined class="muted" /></a-tooltip>
              </a-space>
            </template>
            <template #extra>
              <a-button size="small" :loading="proxyChecking" :disabled="inst.status !== 'running'" @click="checkProxy">{{ t('detail.proxy.check') }}</a-button>
            </template>
            <a-descriptions bordered size="small" :column="{ xs: 1, sm: 2 }">
              <a-descriptions-item :label="t('detail.proxy.current')" :span="2">
                {{ t('devices.ext.proxyShort') }}
              </a-descriptions-item>
              <template v-if="inst.proxyStatus">
                <a-descriptions-item :label="t('detail.proxy.egress')">
                  <a-tag :color="inst.proxyStatus.ok ? 'success' : 'error'">{{ inst.proxyStatus.ok ? t('detail.proxy.ok') : t('detail.proxy.blocked') }}</a-tag>
                </a-descriptions-item>
                <a-descriptions-item :label="t('detail.proxy.egressIp')">{{ inst.proxyStatus.egressIp ?? '—' }}</a-descriptions-item>
                <a-descriptions-item :label="t('detail.proxy.egressLocation')" :span="2">{{ egressGeo(inst.proxyStatus) || '—' }}</a-descriptions-item>
                <a-descriptions-item :label="t('detail.proxy.latency')">{{ inst.proxyStatus.latencyMs != null ? `${inst.proxyStatus.latencyMs} ms` : '—' }}</a-descriptions-item>
                <a-descriptions-item :label="t('detail.proxy.dns')">{{ inst.proxyStatus.dnsOk ? t('detail.proxy.ok') : t('detail.proxy.dnsFailed') }}</a-descriptions-item>
                <a-descriptions-item :label="t('detail.proxy.checkedAt')" :span="inst.proxyStatus.error ? 1 : 2">{{ fmtDateTime(inst.proxyStatus.checkedAt) }}</a-descriptions-item>
                <a-descriptions-item v-if="inst.proxyStatus.error" :label="t('common.error')">{{ inst.proxyStatus.error }}</a-descriptions-item>
              </template>
            </a-descriptions>
          </a-card>

          <DeviceSocialCard :instance-id="id" :allowed-platforms="inst.allowedPlatforms ?? null" />

          <a-card :bordered="false" :title="t('detail.tasksTitle')">
            <a-list :data-source="tasks" size="small" :locale="{ emptyText: t('detail.noTasks') }">
              <template #renderItem="{ item }">
                <a-list-item>
                  <a-space wrap>
                    <StatusTag kind="task" :status="item.status" />
                    <span>{{ taskText(item.type) }}</span>
                    <a-typography-text v-if="item.error" type="danger">{{ item.error }}</a-typography-text>
                  </a-space>
                  <template #extra><span class="muted small nowrap">{{ fmtDateTime(item.createdAt) }}</span></template>
                </a-list-item>
              </template>
            </a-list>
          </a-card>
        </div>
      </a-col>
    </a-row>
  </PageContainer>
</template>

<style scoped>
.stack { display: flex; flex-direction: column; gap: var(--cp-gap); }
.player-card :deep(.ant-card-body) { padding: 20px 12px; }
.upload-line { margin-top: 8px; }
</style>
