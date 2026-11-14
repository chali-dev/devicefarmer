<script setup lang="ts">
import { message, Modal } from 'ant-design-vue'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText, getToken, responseError } from '../api/client'
import { TASK_STATUS_COLOR, taskText, type InstalledApp, type ProxyInput } from '../api/types'
import { useRouter } from 'vue-router'
import DevicePlayer from '../components/DevicePlayer.vue'
import StatusTag from '../components/StatusTag.vue'
import { useInstancesStore } from '../stores/instances'

const props = defineProps<{ id: string }>()
const store = useInstancesStore()
const router = useRouter()
const { t } = useI18n()
const player = ref<InstanceType<typeof DevicePlayer> | null>(null)

const inst = computed(() => store.byId.get(props.id))
const tasks = computed(() => store.tasks.filter((t) => t.instanceId === props.id).slice(0, 10))
const text = ref('')
const secure = ref(false)
const uploading = ref(false)
const checking = ref(false)
const google = computed(() => inst.value?.google ?? null)

function sendText() {
  if (!text.value) return
  // Secure mode: per-character key events, nothing on the device clipboard, nothing stored.
  if (secure.value) player.value?.typeSecure(text.value)
  else player.value?.paste(text.value)
  text.value = ''
}

async function checkGoogle() {
  checking.value = true
  try { await store.googleCheck(props.id) } catch (e) { message.error(errorText(e)) } finally { checking.value = false }
}

async function copyGsf() {
  if (!google.value?.gsf.gsfId) return
  try { await navigator.clipboard.writeText(google.value.gsf.gsfId); message.success(t('detail.copiedGsf')) }
  catch { message.warning(t('detail.copyFailed')) }
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
  Modal.confirm({
    title: t('detail.apps.confirmUninstall', { pkg }), content: t('detail.apps.uninstallContent'), okType: 'danger',
    okText: t('common.uninstall'), cancelText: t('common.cancel'),
    onOk: async () => {
      try { await store.uninstallApp([props.id], pkg); message.success(t('detail.apps.uninstallSubmitted')) }
      catch (e) { message.error(errorText(e)) }
    },
  })
}
// refresh the list when an install/uninstall task for this instance finishes
watch(() => tasks.value.filter((t) => (t.type === 'install-apk' || t.type === 'uninstall-app') && t.status === 'succeeded').length, () => void loadApps())
watch(() => inst.value?.status, (s) => { if (s === 'running') void loadApps() }, { immediate: true })

// ---- device settings (system settings only; hardware identity is not configurable)
const settingsForm = reactive({ locale: '', timezone: '', deviceName: '' })
const actual = ref<Record<string, string> | null>(null)
const savingSettings = ref(false)
const TIMEZONES = Intl.supportedValuesOf('timeZone')
const LOCALES = ['zh-CN', 'zh-TW', 'zh-HK', 'en-US', 'en-GB', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES', 'pt-BR', 'ru-RU', 'ar-SA', 'th-TH', 'vi-VN', 'id-ID']
async function loadSettings() {
  try {
    const r = await api<{ configured: Record<string, string | undefined>; actual: Record<string, string> | null }>('GET', `/api/instances/${props.id}/settings`)
    actual.value = r.actual
    settingsForm.locale = r.configured.locale ?? r.actual?.locale ?? ''
    settingsForm.timezone = r.configured.timezone ?? r.actual?.timezone ?? ''
    settingsForm.deviceName = r.configured.deviceName ?? ''
  } catch { /* shown as empty */ }
}
async function saveSettings() {
  savingSettings.value = true
  try {
    const body = Object.fromEntries(Object.entries(settingsForm).filter(([, v]) => v)) as Record<string, string>
    const r = await store.updateSettings(props.id, body)
    message.success(r.taskId ? t('detail.settings.applying') : t('detail.settings.savedNextBoot'))
  } catch (e) { message.error(errorText(e)) }
  finally { savingSettings.value = false }
}
watch(() => tasks.value.find((t) => t.type === 'apply-settings')?.status, (s) => { if (s === 'succeeded') void loadSettings() })
onMounted(loadSettings)

// ---- upload files (photos/videos) into the phone's shared storage
const fileUploading = ref(false)
const lastUploads = ref<string[]>([])
async function uploadFile(opt: { file: File; onSuccess?: (r: unknown) => void; onError?: (e: Error) => void }) {
  fileUploading.value = true
  try {
    const fd = new FormData()
    fd.append('file', opt.file, opt.file.name)
    const r = await api<{ path: string; folder: string }>('POST', `/api/instances/${props.id}/files`, fd)
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

// ---- network proxy (per instance; password is write-only)
const proxyForm = reactive({ enabled: false, type: 'socks5' as 'socks5' | 'http', host: '', port: 1080 as number | undefined, username: '', password: '' })
const proxySaving = ref(false)
const proxyChecking = ref(false)
function fillProxyForm() {
  const p = inst.value?.proxy
  Object.assign(proxyForm, p
    ? { enabled: true, type: p.type, host: p.host, port: p.port, username: p.username ?? '', password: '' }
    : { enabled: false, type: 'socks5', host: '', port: 1080, username: '', password: '' })
}
watch(() => inst.value?.proxy, fillProxyForm, { immediate: true })
async function saveProxy() {
  proxySaving.value = true
  try {
    let proxy: ProxyInput | null = null
    if (proxyForm.enabled) {
      if (!proxyForm.host || !proxyForm.port) throw new Error(t('detail.proxy.required'))
      proxy = { type: proxyForm.type, host: proxyForm.host.trim(), port: proxyForm.port,
        ...(proxyForm.username ? { username: proxyForm.username } : {}),
        ...(proxyForm.password ? { password: proxyForm.password } : {}) }
    }
    await api('PUT', `/api/instances/${props.id}/proxy`, { proxy })
    message.success(inst.value?.netContainerId ? t('detail.proxy.hotSwitch') : t('detail.proxy.rebuild'))
    proxyForm.password = ''
  } catch (e) { message.error(errorText(e)) }
  finally { proxySaving.value = false }
}
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
  try {
    const res = await fetch(`/api/instances/${props.id}/screenshot`, { headers: { authorization: `Bearer ${getToken()}` } })
    if (!res.ok) throw await responseError(res, 'detail.screenshotFailed')
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = `${inst.value?.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) { message.error(errorText(e)) }
  finally { shooting.value = false }
}

async function act(a: 'start' | 'stop' | 'restart') {
  try {
    const r = await store.action(a, [props.id])
    if (r.skipped.length) message.warning(r.skipped[0]!.reason)
  } catch (e) {
    message.error(errorText(e))
  }
}

</script>

<template>
  <a-result v-if="!inst && !store.loading" status="404" :title="t('detail.notFound')">
    <template #extra><a-button @click="router.push('/instances')">{{ t('detail.backToList') }}</a-button></template>
  </a-result>

  <a-row v-else-if="inst" :gutter="[24, 24]">
    <a-col :xs="24" :lg="11" :xl="9">
      <a-card size="small" :body-style="{ padding: '20px 12px' }">
        <DevicePlayer
          v-if="inst.status === 'running'"
          ref="player"
          :key="`${inst.id}-${inst.containerId}`"
          :instance-id="inst.id"
          :width="inst.spec.width"
          :height="inst.spec.height"
        />
        <a-empty v-else :description="t('detail.notRunning', { status: t(`status.${inst.status}`) })" />
      </a-card>
    </a-col>

    <a-col :xs="24" :lg="13" :xl="15">
      <a-space direction="vertical" size="middle" style="width: 100%">
        <a-card size="small">
          <template #title>
            <a-space><a @click="router.push('/instances')">{{ t('nav.instances') }}</a><span>/</span><span>{{ inst.name }}</span></a-space>
          </template>
          <template #extra>
            <a-space>
              <a-button size="small" :loading="shooting" :disabled="inst.status !== 'running'" @click="screenshot">{{ t('detail.screenshot') }}</a-button>
              <a-button size="small" :disabled="inst.status === 'running'" @click="act('start')">{{ t('devices.start') }}</a-button>
              <a-button size="small" :disabled="inst.status !== 'running'" @click="act('stop')">{{ t('devices.stop') }}</a-button>
              <a-button size="small" @click="act('restart')">{{ t('devices.restart') }}</a-button>
            </a-space>
          </template>
          <a-descriptions :column="{ xs: 1, sm: 2 }" size="small">
            <a-descriptions-item :label="t('common.status')"><StatusTag :status="inst.status" /></a-descriptions-item>
            <a-descriptions-item :label="t('detail.engine')">{{ inst.engine }} · {{ inst.profile }}</a-descriptions-item>
            <a-descriptions-item :label="t('detail.boot')">{{ inst.bootCompleted ? t('detail.bootDone') : t('detail.bootPending') }}</a-descriptions-item>
            <a-descriptions-item label="ADB">{{ inst.adbState ?? '—' }}</a-descriptions-item>
            <a-descriptions-item label="STF">{{ inst.stfReady ? t('detail.stfReady') : t('detail.stfNotReady') }}</a-descriptions-item>
            <a-descriptions-item :label="t('devices.colAdbPort')">{{ inst.adbPort }}</a-descriptions-item>
            <a-descriptions-item :label="t('devices.colResolution')">{{ inst.spec.width }}×{{ inst.spec.height }} @ {{ inst.spec.dpi }}dpi</a-descriptions-item>
            <a-descriptions-item :label="t('devices.colImage')"><a-typography-text :ellipsis="true" style="max-width: 260px">{{ inst.image }}</a-typography-text></a-descriptions-item>
          </a-descriptions>
          <a-alert v-if="inst.lastError" type="error" :message="inst.lastError" show-icon style="margin-top: 8px" />
        </a-card>

        <a-card v-if="inst.google || inst.profile.includes('gapps') || inst.engine === 'emulator'" size="small" :title="t('detail.google.title')">
          <template #extra>
            <a-space>
              <a-button size="small" :loading="checking" :disabled="inst.status !== 'running'" @click="checkGoogle">{{ t('detail.google.checkNow') }}</a-button>
            </a-space>
          </template>
          <template v-if="google">
            <a-space wrap style="margin-bottom: 8px">
              <a-tag :color="google.gms.running ? 'green' : google.gms.installed ? 'orange' : 'red'">GMS {{ google.gms.version?.split(' ')[0] ?? t('detail.google.notInstalled') }}{{ google.gms.installed && !google.gms.running ? t('detail.google.notRunning') : '' }}</a-tag>
              <a-tag :color="google.gsf.installed ? 'green' : 'red'">GSF {{ google.gsf.installed ? t('detail.google.installed') : t('detail.google.notInstalled') }}</a-tag>
              <a-tooltip :title="t('detail.google.updateChannelTip')"><a-tag :color="google.playStore.installed ? 'default' : 'orange'">{{ t('detail.google.updateChannel', { state: google.playStore.installed ? t('detail.google.ok') : t('detail.google.missing') }) }}</a-tag></a-tooltip>
              <a-tag :color="google.youtube.installed ? 'green' : 'default'">YouTube {{ google.youtube.installed ? google.youtube.version : t('detail.google.notInstalled') }}</a-tag>
              <a-tag v-if="google.youtube.playing" color="blue">{{ t('detail.google.youtubePlaying') }}</a-tag>
              <a-tag :color="google.googleAccounts ? 'green' : 'default'">{{ google.googleAccounts ? t('detail.google.accounts', { n: google.googleAccounts }) : t('detail.google.noAccount') }}</a-tag>
            </a-space>
            <a-descriptions :column="1" size="small">
              <a-descriptions-item label="GSF ID">
                <template v-if="google.gsf.gsfId">
                  <a-typography-text code>{{ google.gsf.gsfId }}</a-typography-text>
                  <a-button type="link" size="small" @click="copyGsf">{{ t('common.copy') }}</a-button>
                </template>
                <span v-else class="muted">{{ t('detail.google.gsfPending') }}</span>
              </a-descriptions-item>
              <a-descriptions-item :label="t('detail.google.checkedAt')">{{ new Date(google.checkedAt).toLocaleString() }}</a-descriptions-item>
            </a-descriptions>
            <a-alert v-if="!google.googleAccounts" type="info" show-icon style="margin-top: 8px">
              <template #message>{{ t('detail.google.beforeLogin') }}</template>
              <template #description>
                {{ t('detail.google.beforeLogin1') }}
                <a href="https://www.google.com/android/uncertified" target="_blank" rel="noopener noreferrer">google.com/android/uncertified</a>
                {{ t('detail.google.beforeLogin2') }}
              </template>
            </a-alert>
          </template>
          <a-empty v-else :description="t('detail.google.notChecked')" />
        </a-card>

        <a-card size="small" :title="t('detail.input.title')">
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
          <div class="hint">{{ secure ? t('detail.input.secureHint') : t('detail.input.hint') }}</div>
        </a-card>

        <a-card size="small" :title="t('detail.files.title')">
          <a-upload-dragger :multiple="true" :show-upload-list="false" :custom-request="uploadFile as any" :disabled="inst.status !== 'running' || fileUploading">
            <p style="margin: 8px 0">{{ fileUploading ? t('common.uploading') : t('detail.files.drop') }}</p>
            <p class="hint" style="margin: 0 0 8px">{{ t('detail.files.hint') }}</p>
          </a-upload-dragger>
          <div v-for="p in lastUploads" :key="p" class="hint">✓ {{ p }}</div>
        </a-card>

        <a-card size="small" :title="t('detail.apps.title')">
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
            <p style="margin: 8px 0">{{ uploading ? t('common.uploading') : t('detail.apps.drop') }}</p>
            <p class="hint" style="margin: 0 0 8px">{{ t('detail.apps.hint') }}</p>
          </a-upload-dragger>
          <a-table :data-source="appsList" row-key="package" size="small" :pagination="false" :loading="appsLoading"
            :locale="{ emptyText: inst.status === 'running' ? t('detail.apps.empty') : t('detail.apps.deviceNotRunning') }"
            :columns="[{ title: t('detail.apps.package'), dataIndex: 'package', key: 'package' }, { title: t('detail.apps.version'), key: 'version', width: 160 }, { title: '', key: 'ops', width: 170 }]">
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'version'">{{ record.versionName ?? '—' }}</template>
              <template v-else-if="column.key === 'ops'">
                <a-tag v-if="record.protected">{{ t('detail.apps.platform') }}</a-tag>
                <a-space v-else :size="0">
                  <a-button type="link" size="small" @click="importToLibrary(record.package)">{{ t('detail.apps.addToLibrary') }}</a-button>
                  <a-button type="link" size="small" danger @click="uninstall(record.package)">{{ t('common.uninstall') }}</a-button>
                </a-space>
              </template>
            </template>
          </a-table>
        </a-card>

        <a-card size="small" :title="t('detail.proxy.title')">
          <template #extra>
            <a-button size="small" :loading="proxyChecking" :disabled="inst.status !== 'running' || !inst.netContainerId" @click="checkProxy">{{ t('detail.proxy.check') }}</a-button>
          </template>
          <a-form layout="vertical" :disabled="['creating', 'starting', 'stopping', 'restarting', 'deleting'].includes(inst.status)">
            <a-form-item style="margin-bottom: 8px">
              <a-switch v-model:checked="proxyForm.enabled" size="small" /> <span style="margin-left: 6px">{{ proxyForm.enabled ? t('detail.proxy.enabled') : t('devices.direct') }}</span>
            </a-form-item>
            <a-row v-if="proxyForm.enabled" :gutter="12">
              <a-col :xs="24" :sm="5"><a-form-item :label="t('detail.proxy.type')"><a-select v-model:value="proxyForm.type" :options="[{ value: 'socks5', label: 'SOCKS5' }, { value: 'http', label: 'HTTP' }]" /></a-form-item></a-col>
              <a-col :xs="24" :sm="11"><a-form-item :label="t('detail.proxy.host')"><a-input v-model:value="proxyForm.host" :placeholder="t('detail.proxy.hostPlaceholder')" /></a-form-item></a-col>
              <a-col :xs="24" :sm="8"><a-form-item :label="t('detail.proxy.port')"><a-input-number v-model:value="proxyForm.port" :min="1" :max="65535" style="width: 100%" /></a-form-item></a-col>
              <a-col :xs="24" :sm="12"><a-form-item :label="t('common.username')"><a-input v-model:value="proxyForm.username" autocomplete="off" /></a-form-item></a-col>
              <a-col :xs="24" :sm="12">
                <a-form-item :label="t('common.password')" :extra="inst.proxy?.hasPassword ? t('detail.proxy.passwordSaved') : undefined">
                  <a-input-password v-model:value="proxyForm.password" autocomplete="new-password" />
                </a-form-item>
              </a-col>
            </a-row>
            <a-button type="primary" size="small" :loading="proxySaving" @click="saveProxy">{{ t('detail.proxy.saveApply') }}</a-button>
          </a-form>
          <a-descriptions v-if="inst.proxyStatus" :column="{ xs: 1, sm: 2 }" size="small" style="margin-top: 12px">
            <a-descriptions-item :label="t('detail.proxy.egress')">
              <a-tag :color="inst.proxyStatus.ok ? 'green' : 'red'">{{ inst.proxyStatus.ok ? t('detail.proxy.ok') : t('detail.proxy.blocked') }}</a-tag>
            </a-descriptions-item>
            <a-descriptions-item :label="t('detail.proxy.egressIp')">{{ inst.proxyStatus.egressIp ?? '—' }}</a-descriptions-item>
            <a-descriptions-item :label="t('detail.proxy.latency')">{{ inst.proxyStatus.latencyMs != null ? `${inst.proxyStatus.latencyMs} ms` : '—' }}</a-descriptions-item>
            <a-descriptions-item :label="t('detail.proxy.dns')">{{ inst.proxyStatus.dnsOk ? t('detail.proxy.ok') : t('detail.proxy.dnsFailed') }}</a-descriptions-item>
            <a-descriptions-item :label="t('detail.proxy.checkedAt')">{{ new Date(inst.proxyStatus.checkedAt).toLocaleString() }}</a-descriptions-item>
            <a-descriptions-item v-if="inst.proxyStatus.error" :label="t('common.error')">{{ inst.proxyStatus.error }}</a-descriptions-item>
          </a-descriptions>
          <div class="hint" style="margin-top: 8px">{{ t('detail.proxy.hint') }}</div>
        </a-card>

        <a-card size="small" :title="t('detail.settings.title')">
          <a-form layout="vertical" :disabled="['creating', 'starting', 'stopping', 'restarting', 'deleting'].includes(inst.status)">
            <a-row :gutter="12">
              <a-col :xs="24" :sm="8">
                <a-form-item :label="t('devices.form.locale')">
                  <a-select v-model:value="settingsForm.locale" show-search allow-clear :placeholder="t('common.default')" :options="LOCALES.map((l) => ({ value: l, label: l }))" />
                </a-form-item>
              </a-col>
              <a-col :xs="24" :sm="8">
                <a-form-item :label="t('devices.form.timezone')">
                  <a-select v-model:value="settingsForm.timezone" show-search allow-clear :placeholder="t('common.default')" :options="TIMEZONES.map((z) => ({ value: z, label: z }))" />
                </a-form-item>
              </a-col>
              <a-col :xs="24" :sm="8">
                <a-form-item :label="t('devices.form.deviceName')">
                  <a-input v-model:value="settingsForm.deviceName" :placeholder="t('detail.settings.deviceNamePlaceholder')" :maxlength="40" />
                </a-form-item>
              </a-col>
            </a-row>
            <a-space wrap>
              <a-button type="primary" size="small" :loading="savingSettings" @click="saveSettings">{{ t('detail.proxy.saveApply') }}</a-button>
              <span v-if="actual" class="hint">{{ t('detail.settings.current', { locale: actual.locale || t('detail.settings.defaultLocale'), timezone: actual.timezone ?? '', release: actual.release ?? '', model: actual.model ?? '' }) }}</span>
            </a-space>
          </a-form>
        </a-card>

        <a-card size="small" :title="t('detail.tasksTitle')">
          <a-list :data-source="tasks" size="small" :locale="{ emptyText: t('detail.noTasks') }">
            <template #renderItem="{ item }">
              <a-list-item>
                <a-space wrap>
                  <a-badge :status="TASK_STATUS_COLOR[item.status as keyof typeof TASK_STATUS_COLOR] as any" :text="taskText(item.type)" />
                  <a-typography-text v-if="item.error" type="danger">{{ item.error }}</a-typography-text>
                </a-space>
                <template #extra><span class="time">{{ new Date(item.createdAt).toLocaleString() }}</span></template>
              </a-list-item>
            </template>
          </a-list>
        </a-card>
      </a-space>
    </a-col>
  </a-row>
</template>

<style scoped>
.hint { color: var(--cp-text-tertiary); font-size: 12px; margin-top: 8px; }
.time { color: var(--cp-text-tertiary); font-size: 12px; }
.muted { color: var(--cp-text-tertiary); }
</style>
