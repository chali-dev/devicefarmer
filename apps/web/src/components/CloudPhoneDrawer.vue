<script setup lang="ts">
import {
  AppstoreOutlined, CameraOutlined, CompressOutlined, ExpandOutlined, PoweroffOutlined, ReloadOutlined,
  RotateRightOutlined, SoundOutlined, SyncOutlined, UploadOutlined, WifiOutlined, ZoomInOutlined, ZoomOutOutlined,
} from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { api, errorText } from '../api/client'
import { downloadScreenshot, uploadDeviceFile } from '../api/device'
import { proxyLabel, type Instance } from '../api/types'
import { dateLocale } from '../i18n'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'
import DevicePlayer from './DevicePlayer.vue'
import StatusTag from './StatusTag.vue'

/** Slide-in remote control for one cloud phone: screen + side tools on the left, info and actions on the right. */
type MenuKey = 'start' | 'stop' | 'restart' | 'delete' | 'install' | 'uninstall'
const props = defineProps<{ instanceId: string | null; profileName: (id: string) => string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ (e: 'menu', key: MenuKey, ids: string[]): void; (e: 'log', id: string): void }>()

const { t } = useI18n()
const router = useRouter()
const store = useInstancesStore()
const auth = useAuthStore()
const inst = computed<Instance | undefined>(() => (props.instanceId ? store.byId.get(props.instanceId) : undefined))
const running = computed(() => inst.value?.status === 'running')
/** The screen comes through STF, which attaches a little after adb (and again after an adb reconnect). */
const screenReady = computed(() => running.value && !!inst.value?.stfReady)
const player = ref<InstanceType<typeof DevicePlayer> | null>(null)

// ---- view: rotation, zoom, fullscreen (view only, the phone isn't touched)
const rotation = ref<0 | 90 | 180 | 270>(0)
const zoom = ref(1)
const ZOOM_MIN = 0.5
const ZOOM_MAX = 1.6
const stageEl = ref<HTMLElement | null>(null)
const fullscreen = ref(false)
const size = computed(() => `calc((100vh - ${fullscreen.value ? 165 : 250}px) * ${zoom.value})`)
function rotate() { rotation.value = ((rotation.value + 90) % 360) as typeof rotation.value }
function zoomBy(d: number) { zoom.value = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom.value + d)) * 10) / 10 }
function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen()
  else void stageEl.value?.requestFullscreen().catch(() => message.warning(t('cloud.fullscreenFailed')))
}
function onFsChange() { fullscreen.value = document.fullscreenElement === stageEl.value }
onMounted(() => document.addEventListener('fullscreenchange', onFsChange))
onBeforeUnmount(() => document.removeEventListener('fullscreenchange', onFsChange))
watch(open, (o) => { if (!o) { if (document.fullscreenElement) void document.exitFullscreen(); rotation.value = 0; zoom.value = 1 } })

// ---- side tools
const key = (k: string) => player.value?.key(k)
const shooting = ref(false)
async function screenshot() {
  if (!inst.value) return
  shooting.value = true
  try { await downloadScreenshot(inst.value.id, inst.value.name) } catch (e) { message.error(errorText(e)) } finally { shooting.value = false }
}
const uploading = ref(false)
async function upload(opt: { file: File; onSuccess?: (r: unknown) => void; onError?: (e: Error) => void }) {
  if (!inst.value) return
  uploading.value = true
  try {
    const r = await uploadDeviceFile(inst.value.id, opt.file)
    message.success(t('detail.files.uploaded', { folder: r.folder }))
    opt.onSuccess?.(r)
  } catch (e) { message.error(errorText(e)); opt.onError?.(e as Error) } finally { uploading.value = false }
}
const menu = (k: MenuKey) => inst.value && emit('menu', k, [inst.value.id])

// ---- text input (normal = paste, secure = per-character, never on the device clipboard)
const text = ref('')
const secure = ref(false)
function sendText() {
  if (!text.value) return
  if (secure.value) player.value?.typeSecure(text.value)
  else player.value?.paste(text.value)
  text.value = ''
}

// ---- info read from the device (model, Android version, locale, time zone)
const actual = ref<Record<string, string> | null>(null)
async function loadInfo() {
  actual.value = null
  if (!inst.value || !running.value) return
  try { actual.value = (await api<{ actual: Record<string, string> | null }>('GET', `/api/instances/${inst.value.id}/settings`)).actual }
  catch { /* shown as — */ }
}
watch([() => props.instanceId, running, open], () => { if (open.value) void loadInfo() }, { immediate: true })

const tab = ref<'info' | 'ops'>('info')
const dash = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '—' : String(v))
const kindText = computed(() => {
  const i = inst.value
  if (!i) return '—'
  return i.sourceId ? t(`devices.ext.kinds.${i.engine}`) : props.profileName(i.profile)
})
const basic = computed(() => {
  const i = inst.value
  if (!i) return []
  return [
    [t('cloud.name'), i.name],
    [t('cloud.id'), i.sourceId ? i.externalId : i.id],
    [t('cloud.kind'), kindText.value],
    [t('cloud.model'), dash(actual.value?.model)],
    [t('cloud.android'), actual.value?.release ? `Android ${actual.value.release}` : '—'],
    [t('devices.colResolution'), `${i.spec.width}×${i.spec.height} @ ${i.spec.dpi}dpi`],
    [t('cloud.memory'), i.spec.memoryMb ? `${i.spec.memoryMb} MB` : t('devices.form.unlimited')],
    [t('devices.colAdbPort'), i.adbPort],
    [t('cloud.created'), new Date(i.createdAt).toLocaleString(dateLocale())],
  ] as [string, string | number | null][]
})
/** WLAN MAC read from the device (wlan0, else eth0 on redroid). */
const macText = computed(() => actual.value?.mac ? `${actual.value.mac}${actual.value.macIf && actual.value.macIf !== 'wlan0' ? ` (${actual.value.macIf})` : ''}` : '—')
/** Geo of the measured egress IP; before the first such check, the location configured on the proxy (marked). */
const geoText = computed(() => {
  const i = inst.value
  const s = i?.proxyStatus
  if (s?.country) return [s.country, ...[s.region, s.city].filter((x, n, a) => x && a.indexOf(x) === n)].filter(Boolean).join(' · ')
  const conf = [i?.proxy?.country, i?.proxy?.city].filter(Boolean).join(' ')
  return conf ? t('cloud.locationConfigured', { where: conf }) : '—'
})
const checking = ref(false)
async function recheckEgress() {
  if (!inst.value || checking.value) return
  checking.value = true
  try { await api('POST', `/api/instances/${inst.value.id}/proxy/check`) } // the row update arrives as an event
  catch (e) { message.error(errorText(e)) }
  finally { checking.value = false }
}
type Row = [string, string, ('geo' | undefined)?]
const network = computed<Row[]>(() => {
  const i = inst.value
  if (!i) return []
  const mac: Row = [t('cloud.mac'), macText.value]
  if (!i.proxy) return [[t('cloud.proxy'), i.sourceId ? t('devices.ext.proxyShort') : t('devices.direct')], mac]
  const s = i.proxyStatus
  return [
    [t('cloud.proxy'), `${i.proxy.type.toUpperCase()} ${proxyLabel(i.proxy)}`],
    mac,
    [t('cloud.location'), geoText.value, 'geo'],
    [t('cloud.egressIp'), dash(s?.egressIp)],
    [t('cloud.latency'), s?.latencyMs != null ? `${s.latencyMs} ms` : '—'],
    [t('cloud.proxyState'), s ? (s.ok ? t('cloud.proxyOk') : t('cloud.proxyFailed', { error: s.error ?? '' })) : t('cloud.proxyUnchecked')],
    [t('cloud.checkedAt'), s ? new Date(s.checkedAt).toLocaleString(dateLocale()) : '—'],
  ]
})
const other = computed(() => [
  [t('devices.form.locale'), dash(actual.value?.locale || inst.value?.spec.locale)],
  [t('devices.form.timezone'), dash(actual.value?.timezone || inst.value?.spec.timezone)],
  [t('devices.form.deviceName'), dash(actual.value?.deviceName && actual.value.deviceName !== 'null' ? actual.value.deviceName : inst.value?.spec.deviceName)],
  [t('cloud.gms'), inst.value?.google ? (inst.value.google.gms.running ? t('cloud.gmsOk') : t('cloud.gmsDown')) : '—'],
] as [string, string][])
</script>

<template>
  <a-drawer v-model:open="open" placement="right" width="min(1180px, 100vw)" :closable="false" :body-style="{ padding: 0 }" destroy-on-close>
    <template v-if="inst">
      <div class="layout">
        <section class="left">
          <header class="bar">
            <a-space :size="8" class="title">
              <strong>{{ inst.name }}</strong>
              <StatusTag :status="inst.status" />
            </a-space>
            <a-space :size="2">
              <a-tooltip :title="t('cloud.rotate')"><a-button type="text" :disabled="!running" @click="rotate"><RotateRightOutlined /></a-button></a-tooltip>
              <a-tooltip :title="t('cloud.zoomIn')"><a-button type="text" :disabled="!running || zoom >= ZOOM_MAX" @click="zoomBy(0.1)"><ZoomInOutlined /></a-button></a-tooltip>
              <a-tooltip :title="t('cloud.zoomOut')"><a-button type="text" :disabled="!running || zoom <= ZOOM_MIN" @click="zoomBy(-0.1)"><ZoomOutOutlined /></a-button></a-tooltip>
              <a-tooltip :title="t('cloud.fullscreen')"><a-button type="text" :disabled="!running" @click="toggleFullscreen"><ExpandOutlined /></a-button></a-tooltip>
            </a-space>
          </header>

          <div ref="stageEl" class="stage" :class="{ fs: fullscreen }">
            <a-button v-if="fullscreen" class="fs-exit" @click="toggleFullscreen"><CompressOutlined /> {{ t('cloud.exitFullscreen') }}</a-button>
            <DevicePlayer
              v-if="screenReady" ref="player" :key="`${inst.id}-${inst.containerId}`"
              :instance-id="inst.id" :width="inst.spec.width" :height="inst.spec.height" :size="size" :rotation="rotation"
              :title="inst.name" :subtitle="inst.externalId ?? inst.id" @exit="open = false"
            >
              <template #side="{ latency, color, tip }">
                <div class="tools">
                  <a-tooltip placement="left">
                    <template #title><div v-for="(line, i) in tip" :key="i">{{ line }}</div></template>
                    <div class="tool tool-static net" :class="{ idle: latency == null }" :style="{ color }">
                      <WifiOutlined /><span>{{ latency != null ? t('player.latencyShort', { ms: latency }) : '—' }}</span>
                    </div>
                  </a-tooltip>
                  <a-tooltip :title="t('cloud.volUp')" placement="left"><button class="tool" @click="key('volume_up')"><SoundOutlined /><span>{{ t('cloud.volUpShort') }}</span></button></a-tooltip>
                  <a-tooltip :title="t('cloud.volDown')" placement="left"><button class="tool" @click="key('volume_down')"><SoundOutlined /><span>{{ t('cloud.volDownShort') }}</span></button></a-tooltip>
                  <a-tooltip :title="t('cloud.powerKey')" placement="left"><button class="tool" @click="key('power')"><PoweroffOutlined /><span>{{ t('cloud.powerShort') }}</span></button></a-tooltip>
                  <a-tooltip :title="t('detail.screenshot')" placement="left"><button class="tool" :disabled="shooting" @click="screenshot"><CameraOutlined /><span>{{ t('detail.screenshot') }}</span></button></a-tooltip>
                  <a-upload :multiple="true" :show-upload-list="false" :custom-request="upload as any" :disabled="uploading">
                    <a-tooltip :title="t('cloud.uploadTip')" placement="left"><button class="tool" :disabled="uploading"><UploadOutlined /><span>{{ t('cloud.upload') }}</span></button></a-tooltip>
                  </a-upload>
                  <a-tooltip :title="t('devices.restart')" placement="left"><button class="tool" @click="menu('restart')"><ReloadOutlined /><span>{{ t('devices.restart') }}</span></button></a-tooltip>
                  <a-tooltip :title="t('cloud.openDetail')" placement="left"><button class="tool" @click="router.push(`/instances/${inst.id}`)"><AppstoreOutlined /><span>{{ t('cloud.more') }}</span></button></a-tooltip>
                </div>
              </template>
            </DevicePlayer>
            <div v-else-if="running" class="waiting"><a-spin /><span>{{ t('cloud.waitingScreen') }}</span></div>
            <a-empty v-else :description="t('detail.notRunning', { status: t(`status.${inst.status}`) })">
              <a-button v-if="inst.status === 'stopped' || inst.status === 'error'" type="primary" @click="menu('start')">{{ t('devices.start') }}</a-button>
            </a-empty>
          </div>
        </section>

        <aside class="right">
          <header class="bar">
            <a-tabs v-model:active-key="tab" size="small" class="tabs">
              <a-tab-pane key="info" :tab="t('cloud.tabInfo')" />
              <a-tab-pane key="ops" :tab="t('cloud.tabOps')" />
            </a-tabs>
            <a-button type="text" shape="circle" :aria-label="t('cloud.close')" @click="open = false">✕</a-button>
          </header>
          <div class="panel">
            <template v-if="tab === 'info'">
              <a-alert v-if="inst.lastError" type="error" :message="inst.lastError" show-icon style="margin-bottom: 12px" />
              <h4>{{ t('cloud.basic') }}</h4>
              <dl><template v-for="[k, v] in basic" :key="k"><dt>{{ k }}</dt><dd>{{ dash(v) }}</dd></template></dl>
              <h4>{{ t('cloud.network') }}</h4>
              <dl>
                <template v-for="[k, v, kind] in network" :key="k">
                  <dt>{{ k }}</dt>
                  <dd>
                    {{ v }}
                    <a-tooltip v-if="kind === 'geo' && running" :title="t('cloud.recheckEgress')">
                      <a-button type="link" size="small" :loading="checking" :aria-label="t('cloud.recheckEgress')" style="padding: 0 4px; height: auto" @click="recheckEgress"><SyncOutlined v-if="!checking" /></a-button>
                    </a-tooltip>
                  </dd>
                </template>
              </dl>
              <h4>{{ t('cloud.other') }}</h4>
              <dl><template v-for="[k, v] in other" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template></dl>
            </template>

            <template v-else>
              <h4>{{ t('cloud.power') }}</h4>
              <a-space wrap>
                <a-button :disabled="running" @click="menu('start')">{{ t('devices.start') }}</a-button>
                <a-button :disabled="inst.status === 'stopped'" @click="menu('stop')">{{ t('devices.stop') }}</a-button>
                <a-button @click="menu('restart')">{{ t('devices.restart') }}</a-button>
              </a-space>

              <h4>{{ t('detail.input.title') }}</h4>
              <a-input-password v-if="secure" v-model:value="text" :placeholder="t('detail.input.securePlaceholder')" :disabled="!running" autocomplete="off" @press-enter="sendText" />
              <a-input v-else v-model:value="text" :placeholder="t('detail.input.placeholder')" :disabled="!running" @press-enter="sendText" />
              <a-space style="margin-top: 8px; width: 100%; justify-content: space-between">
                <a-tooltip :title="t('detail.input.secureTip')"><a-space :size="4"><a-switch v-model:checked="secure" size="small" />{{ t('detail.input.secure') }}</a-space></a-tooltip>
                <a-button type="primary" size="small" :disabled="!running || !text" @click="sendText">{{ t('common.send') }}</a-button>
              </a-space>
              <div class="hint">{{ secure ? t('detail.input.secureHint') : t('detail.input.hint') }}</div>

              <h4>{{ t('cloud.apps') }}</h4>
              <a-space wrap>
                <a-button :disabled="!running" @click="menu('install')">{{ t('devices.installApp') }}</a-button>
                <a-button :disabled="!running" @click="menu('uninstall')">{{ t('devices.uninstallApp') }}</a-button>
              </a-space>

              <h4>{{ t('cloud.maintenance') }}</h4>
              <a-space wrap>
                <a-button @click="emit('log', inst.id)">{{ t('devices.log') }}</a-button>
                <a-button @click="router.push(`/instances/${inst.id}`)">{{ t('cloud.openDetail') }}</a-button>
                <a-button v-if="auth.isAdmin" danger @click="menu('delete')">{{ t('devices.delete') }}</a-button>
              </a-space>
            </template>
          </div>
        </aside>
      </div>
    </template>
  </a-drawer>
</template>

<style scoped>
.layout { display: flex; height: 100%; min-height: 100vh; }
.left { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.right { width: 380px; flex: none; border-left: 1px solid var(--cp-border-secondary); display: flex; flex-direction: column; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 12px 0 16px; height: 52px; border-bottom: 1px solid var(--cp-border-secondary); flex: none; }
.title { min-width: 0; overflow: hidden; white-space: nowrap; }
.tabs { flex: 1; min-width: 0; }
.tabs :deep(.ant-tabs-nav) { margin: 0; }
.stage { flex: 1; display: flex; align-items: center; justify-content: center; padding: 20px 16px; overflow: auto; background: var(--cp-bg-layout); position: relative; }
.stage.fs { background: #000; }
.waiting { display: flex; flex-direction: column; align-items: center; gap: 12px; color: var(--cp-text-secondary); }
.fs-exit { position: absolute; top: 12px; right: 12px; z-index: 2; }
.tools { display: flex; flex-direction: column; gap: 2px; padding: 6px 4px; background: #1f1f1f; border-radius: 10px; align-self: center; }
.tool { display: flex; flex-direction: column; align-items: center; gap: 2px; width: 52px; padding: 6px 0; border: 0; border-radius: 6px; background: transparent; color: #e6e6e6; font-size: 16px; cursor: pointer; }
.tool span { font-size: 11px; line-height: 1.2; }
.tool:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); }
.tool:disabled { opacity: 0.4; cursor: default; }
.tool-static { cursor: default; font-variant-numeric: tabular-nums; }
.tool.tool-static:hover { background: transparent; }
.net.idle { opacity: 0.4; }
.panel { flex: 1; overflow: auto; padding: 4px 16px 24px; }
h4 { margin: 18px 0 10px; font-size: 14px; font-weight: 600; color: var(--cp-text); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 10px 16px; margin: 0; padding-bottom: 16px; border-bottom: 1px solid var(--cp-border-secondary); font-size: 13px; }
dt { color: var(--cp-text-secondary); }
dd { margin: 0; text-align: right; color: var(--cp-text); word-break: break-all; }
.hint { margin-top: 6px; color: var(--cp-text-tertiary); font-size: 12px; }
@media (max-width: 900px) {
  .layout { flex-direction: column; min-height: 0; }
  .right { width: 100%; border-left: 0; border-top: 1px solid var(--cp-border-secondary); }
  .stage { padding: 12px 8px; }
}
</style>
