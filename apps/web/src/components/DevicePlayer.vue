<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, message as toast, notification } from 'ant-design-vue'
import { codeText, getToken, wsUrl } from '../api/client'

const props = defineProps<{
  instanceId: string; width: number; height: number
  /** CSS length of the screen's long edge (default min(72vh, 900px)). */
  size?: string
  /** View-only rotation (clockwise); the device itself is not rotated, touches are mapped back. */
  rotation?: 0 | 90 | 180 | 270
}>()
const rot = computed(() => props.rotation ?? 0)
const sideways = computed(() => rot.value === 90 || rot.value === 270)
const screenStyle = computed(() => {
  const long = props.size ?? 'min(72vh, 900px)'
  return sideways.value
    ? { aspectRatio: `${props.height} / ${props.width}`, width: long }
    : { aspectRatio: `${props.width} / ${props.height}`, height: long }
})
/** Sideways: the canvas keeps the device's portrait shape and is rotated around the container's centre. */
const canvasStyle = computed(() => sideways.value
  ? { position: 'absolute' as const, left: '50%', top: '50%', width: `calc(100% * ${props.width} / ${props.height})`, height: `calc(100% * ${props.height} / ${props.width})`, transform: `translate(-50%, -50%) rotate(${rot.value}deg)` }
  : rot.value ? { transform: `rotate(${rot.value}deg)` } : {})
const emit = defineEmits<{ (e: 'state', s: PlayerState): void }>()
const { t } = useI18n()

export type PlayerState = 'connecting' | 'live' | 'closed' | 'error'

const canvas = ref<HTMLCanvasElement | null>(null)
const state = ref<PlayerState>('connecting')
/** Connection progress shown while connecting: socket → session (auth, RBAC, device claim) → first frame. */
type Stage = 'socket' | 'session' | 'frame'
const STAGES: Stage[] = ['socket', 'session', 'frame']
const stage = ref<Stage>('socket')
let liveTimer: ReturnType<typeof setTimeout> | null = null
const message = ref('')
const fps = ref(0)

/**
 * Screen sources: 'stf' (标准, JPEG frames from STF), 'scrcpy' (高速, H.264 from scrcpy-server, decoded
 * here with WebCodecs) and 'secure' (JPEG from the capture helper, shows FLAG_SECURE windows).
 * `preferred` is the viewer's stf/scrcpy choice (remembered in this browser); `source` is what the
 * server currently delivers (it falls back to STF on its own and says so).
 */
type Source = 'stf' | 'scrcpy' | 'secure'
const canH264 = typeof VideoDecoder !== 'undefined'
const PREF_KEY = 'cp.player.source'
/** Default 高速 (scrcpy) where the browser can decode it; the server falls back to STF when scrcpy can't start. */
const DEFAULT_SOURCE: 'stf' | 'scrcpy' = 'scrcpy'
function loadPref(): 'stf' | 'scrcpy' {
  try { const v = localStorage.getItem(PREF_KEY); if (v === 'stf' || v === 'scrcpy') return v } catch { /* storage unavailable */ }
  return DEFAULT_SOURCE
}
const preferred = ref<'stf' | 'scrcpy'>(canH264 ? loadPref() : 'stf')
const source = ref<Source>('stf')
const secureView = computed(() => source.value === 'secure')
function setPreferred(v: 'stf' | 'scrcpy') {
  if (v === 'scrcpy' && !canH264) { toast.warning(t('player.noWebCodecs')); return }
  preferred.value = v
  try { localStorage.setItem(PREF_KEY, v) } catch { /* storage unavailable */ }
  if (!secureView.value) send({ type: 'screenSource', source: v })
}
/** Show FLAG_SECURE windows (e.g. Google sign-in) via the system capture helper. Kept across reconnects. */
let secureWanted = false
function setSecureView(v: boolean) {
  secureWanted = v
  send({ type: 'screenSource', source: v ? 'secure' : preferred.value })
}
let ws: WebSocket | null = null
let frames = 0
let fpsTimer: ReturnType<typeof setInterval> | null = null
let drawing = false
let pending: Blob | null = null
let pointerDown = false
let lastMove = 0
/** How binary messages are decoded: JPEG (stf/secure) until a {type:'video'} message announces H.264. */
let binMode: 'jpeg' | 'h264' = 'jpeg'

function setState(s: PlayerState, msg = '') {
  state.value = s
  message.value = msg
  emit('state', s)
}

function send(msg: object) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function onFrameDrawn() {
  frames++
  if (state.value === 'connecting' && stage.value === 'frame') goLive()
}

// ---- H.264 (scrcpy) ----
// Packets: [u8 flags: 1 = config (SPS/PPS), 2 = key frame][u64 pts][Annex B]. Without a `description`
// the decoder takes Annex B with SPS/PPS in band, so the config is prepended to each key frame.
let decoder: VideoDecoder | null = null
let codec = ''
let avcConfig: Uint8Array | null = null
let needKey = true
let rafId = 0
const MAX_DECODE_QUEUE = 4

/*
 * Playout buffer. Through a high-latency adb link (BitBrowser's SSH tunnel, ~0.3 s RTT, no adb
 * `delayed_ack`) frames arrive in bursts, one burst per round trip; painting only the newest frame per
 * display refresh then shows ~5-7 fps although ~20 arrive. So frames are shown at their own pts cadence,
 * delayed by the recent worst lateness (max of arrival - pts over JITTER_WINDOW_MS). On a smooth link
 * (local redroid) that lateness is flat and the added delay stays near zero. Bounded by MAX_JITTER_MS.
 */
const JITTER_WINDOW_MS = 2000
const MAX_JITTER_MS = 600
let frames_q: VideoFrame[] = []
let lateness: { at: number; ms: number }[] = []
let minLate = Infinity
function playoutDelay(now: number): number {
  while (lateness.length && now - lateness[0]!.at > JITTER_WINDOW_MS) lateness.shift()
  let max = 0
  for (const l of lateness) if (l.ms > max) max = l.ms
  return Math.min(MAX_JITTER_MS, max)
}
function clearQueue() {
  for (const f of frames_q) f.close()
  frames_q = []
  lateness = []
  minLate = Infinity
}

function closeDecoder() {
  if (decoder && decoder.state !== 'closed') { try { decoder.close() } catch { /* already closed */ } }
  decoder = null
  clearQueue()
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  needKey = true
}

function onDecoded(f: VideoFrame) {
  const now = performance.now()
  // Lateness relative to the earliest frame seen (device pts and our clock have different origins).
  const raw = now - f.timestamp / 1000
  // pts restart with the encoder (rotation, reset for a late joiner): start the estimate over.
  if (raw < minLate || raw - minLate > 5000) { if (raw - minLate > 5000) lateness = []; minLate = raw }
  lateness.push({ at: now, ms: raw - minLate })
  frames_q.push(f)
  if (!rafId) rafId = requestAnimationFrame(paintDue)
}

/** Paints the newest frame whose playout time has come; older due frames are skipped. */
function paintDue() {
  rafId = 0
  const now = performance.now()
  const delay = playoutDelay(now)
  let f: VideoFrame | null = null
  while (frames_q.length && (frames_q[0]!.timestamp / 1000 + minLate + delay <= now || frames_q.length > 30)) {
    f?.close()
    f = frames_q.shift()!
  }
  if (frames_q.length) rafId = requestAnimationFrame(paintDue)
  const c = canvas.value
  if (!f) return
  if (c) {
    if (c.width !== f.displayWidth || c.height !== f.displayHeight) { c.width = f.displayWidth; c.height = f.displayHeight }
    c.getContext('2d')?.drawImage(f, 0, 0)
  }
  f.close()
  onFrameDrawn()
}

function ensureDecoder(): VideoDecoder | null {
  if (decoder && decoder.state !== 'closed') return decoder
  if (!codec) return null
  decoder = new VideoDecoder({
    output: onDecoded,
    error: () => { decoder = null; needKey = true }, // recovers at the next key frame
  })
  decoder.configure({ codec, optimizeForLatency: true })
  needKey = true
  return decoder
}

let videoSize = ''
function onVideoInfo(msg: { codec: string | null; width: number; height: number }) {
  binMode = 'h264'
  const size = `${msg.width}x${msg.height}`
  if (size !== videoSize) { videoSize = size; closeDecoder() } // e.g. rotation: start clean at the next key frame
  if (msg.codec && msg.codec !== codec) {
    codec = msg.codec
    closeDecoder()
    VideoDecoder.isConfigSupported({ codec }).then((r) => {
      if (!r.supported) { toast.warning(t('player.decoderUnsupported', { codec })); setPreferred('stf') }
    }).catch(() => undefined)
  }
}

function onH264(buf: ArrayBuffer) {
  const v = new DataView(buf)
  if (buf.byteLength < 9) return
  const flags = v.getUint8(0)
  const data = new Uint8Array(buf, 9)
  if (flags & 1) { avcConfig = data.slice(); needKey = true; return }
  const key = (flags & 2) !== 0
  const d = ensureDecoder()
  if (!d) return
  if (!key && (needKey || d.decodeQueueSize > MAX_DECODE_QUEUE)) { needKey = true; return } // wait for a key frame
  let payload = data
  if (key && avcConfig) { payload = new Uint8Array(avcConfig.length + data.length); payload.set(avcConfig); payload.set(data, avcConfig.length) }
  try {
    d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Number(v.getBigUint64(1)), data: payload }))
    if (key) needKey = false
  } catch { closeDecoder() }
}

// ---- JPEG (stf, secure) ----
/** Decode only the latest frame; drop intermediate ones when the client is slow. */
async function draw(blob: Blob) {
  if (drawing) { pending = blob; return }
  drawing = true
  try {
    const bmp = await createImageBitmap(blob)
    const c = canvas.value
    if (c) {
      if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height }
      c.getContext('2d')?.drawImage(bmp, 0, 0)
    }
    bmp.close()
    onFrameDrawn()
  } catch { /* corrupt frame */ }
  drawing = false
  if (pending) { const p = pending; pending = null; void draw(p) }
}

/** Live on the first frame; a static screen may send none for a while, so don't wait forever. */
function goLive() {
  if (liveTimer) clearTimeout(liveTimer)
  liveTimer = null
  if (state.value === 'connecting') { setState('live'); if (secureWanted) send({ type: 'screenSource', source: 'secure' }) }
}

/** Device clipboard (scrcpy): a toast with a copy button. */
function showClipboard(text: string, requested: boolean) {
  if (!text) { if (requested) toast.info(t('player.clipboardEmpty')); return }
  const key = `clip-${props.instanceId}`
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); toast.success(t('player.copied')); notification.close(key) } catch { toast.error(t('player.copyFailed')) }
  }
  notification.open({
    key, message: t('player.clipboardTitle'), duration: 8, placement: 'bottomRight',
    description: h('div', { class: 'cp-clip-text' }, text.length > 300 ? `${text.slice(0, 300)}…` : text),
    btn: () => h(Button, { type: 'primary', size: 'small', onClick: copy }, () => t('player.copy')),
  })
}
function readClipboard() { send({ type: 'getClipboard' }) }

function connect() {
  close()
  stage.value = 'socket'
  setState('connecting')
  ws = new WebSocket(wsUrl(`/api/instances/${props.instanceId}/session`))
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => { stage.value = 'session'; ws?.send(JSON.stringify({ type: 'auth', token: getToken() })) }
  ws.onmessage = (m) => {
    if (m.data instanceof ArrayBuffer) {
      if (binMode === 'h264') onH264(m.data)
      else void draw(new Blob([m.data], { type: 'image/jpeg' }))
      return
    }
    const msg = JSON.parse(m.data)
    if (msg.type === 'ready') {
      stage.value = 'frame'
      liveTimer = setTimeout(goLive, 3000)
      if (preferred.value === 'scrcpy' && !secureWanted) send({ type: 'screenSource', source: 'scrcpy' })
    }
    else if (msg.type === 'video') onVideoInfo(msg)
    else if (msg.type === 'screenSource') {
      source.value = msg.source
      secureWanted = msg.source === 'secure'
      if (msg.source !== 'scrcpy') { binMode = 'jpeg'; closeDecoder() }
      if (msg.reason) toast.warning(codeText(msg.code, msg.params, msg.reason))
    }
    else if (msg.type === 'clipboard') showClipboard(msg.text, !!msg.requested)
    else if (msg.type === 'error') {
      if (msg.code && state.value === 'live') toast.warning(codeText(msg.code, msg.params, msg.message))
      else message.value = msg.message
    }
  }
  ws.onclose = (e) => {
    if (state.value !== 'closed') setState(e.code === 1000 ? 'closed' : 'error', e.reason || message.value || t('player.connectionLost'))
  }
  fpsTimer = setInterval(() => { fps.value = frames; frames = 0 }, 1000)
}

function close() {
  if (liveTimer) clearTimeout(liveTimer)
  liveTimer = null
  if (fpsTimer) clearInterval(fpsTimer)
  fpsTimer = null
  if (ws) { ws.onclose = null; ws.close(1000) }
  ws = null
  closeDecoder()
  binMode = 'jpeg'
  codec = ''
  videoSize = ''
  avcConfig = null
  source.value = 'stf'
}

/** Device coordinates (0..1) of a pointer event, undoing the view rotation. */
function point(e: PointerEvent) {
  const r = canvas.value!.getBoundingClientRect() // bounding box of the rotated canvas
  const X = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
  const Y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
  if (rot.value === 90) return { x: Y, y: 1 - X }
  if (rot.value === 180) return { x: 1 - X, y: 1 - Y }
  if (rot.value === 270) return { x: 1 - Y, y: X }
  return { x: X, y: Y }
}

// STF protocol: every touch belongs to a gesture (gestureStart ... gestureStop).
function onPointerDown(e: PointerEvent) {
  if (state.value !== 'live' || e.button !== 0) return
  canvas.value?.setPointerCapture(e.pointerId)
  canvas.value?.focus()
  pointerDown = true
  const p = point(e)
  send({ type: 'touch', ev: { type: 'gestureStart' } })
  send({ type: 'touch', ev: { type: 'down', ...p } })
  send({ type: 'touch', ev: { type: 'commit' } })
}
function onPointerMove(e: PointerEvent) {
  if (!pointerDown) return
  const now = performance.now()
  if (now - lastMove < 16) return // ~60 Hz
  lastMove = now
  send({ type: 'touch', ev: { type: 'move', ...point(e) } })
  send({ type: 'touch', ev: { type: 'commit' } })
}
function onPointerUp() {
  if (!pointerDown) return
  pointerDown = false
  send({ type: 'touch', ev: { type: 'up' } })
  send({ type: 'touch', ev: { type: 'commit' } })
  send({ type: 'touch', ev: { type: 'gestureStop' } })
}

// Keyboard: special keys as key events; printable text is batched and pasted,
// because per-key injection drops/reorders characters on redroid.
const SPECIAL: Record<string, string> = {
  Enter: 'enter', Backspace: 'del', Delete: 'forward_del', Tab: 'tab', Escape: 'back',
  ArrowUp: 'dpad_up', ArrowDown: 'dpad_down', ArrowLeft: 'dpad_left', ArrowRight: 'dpad_right',
  Home: 'move_home', End: 'move_end', PageUp: 'page_up', PageDown: 'page_down',
}
let textBuf = ''
let textTimer: ReturnType<typeof setTimeout> | null = null
function flushText() {
  if (textBuf) send({ type: 'paste', text: textBuf })
  textBuf = ''
  textTimer = null
}
function onKeyDown(e: KeyboardEvent) {
  if (state.value !== 'live' || e.metaKey || e.ctrlKey) return
  const special = SPECIAL[e.key]
  if (special) {
    e.preventDefault()
    flushText()
    send({ type: 'key', action: 'press', key: special })
  } else if (e.key.length === 1) {
    e.preventDefault()
    textBuf += e.key
    if (textTimer) clearTimeout(textTimer)
    textTimer = setTimeout(flushText, 250)
  }
}
function onPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData('text')
  if (text) { e.preventDefault(); flushText(); send({ type: 'paste', text }) }
}

function key(name: string) { send({ type: 'key', action: 'press', key: name }) }
function paste(text: string) { send({ type: 'paste', text }) }
/** Per-character key events; never touches the device clipboard (for passwords). */
function typeSecure(text: string) { send({ type: 'typeSecure', text }) }
defineExpose({ key, paste, typeSecure, reconnect: connect, state })

onMounted(connect)
onBeforeUnmount(close)
watch(() => props.instanceId, connect)
</script>

<template>
  <div class="player">
    <div class="stage">
    <div class="screen" :style="screenStyle">
      <canvas
        :style="canvasStyle"
        ref="canvas"
        tabindex="0"
        :width="width"
        :height="height"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @keydown="onKeyDown"
        @paste="onPaste"
        @contextmenu.prevent="key('back')"
      />
      <div v-if="state !== 'live'" class="overlay">
        <div v-if="state === 'connecting'" class="steps">
          <a-spin />
          <div v-for="(s, i) in STAGES" :key="s" class="step" :class="{ done: i < STAGES.indexOf(stage), active: s === stage }">
            <span class="dot">{{ i < STAGES.indexOf(stage) ? '✓' : i + 1 }}</span>{{ t(`player.stage.${s}`) }}
          </div>
        </div>
        <template v-else>
          <div class="overlay-msg">{{ message || t('player.disconnected') }}</div>
          <a-button size="small" type="primary" @click="connect">{{ t('player.reconnect') }}</a-button>
        </template>
      </div>
    </div>
    <slot name="side" />
    </div>
    <div class="nav">
      <a-tooltip :title="t('player.back')"><a-button shape="circle" @click="key('back')">◁</a-button></a-tooltip>
      <a-tooltip :title="t('player.home')"><a-button shape="circle" @click="key('home')">○</a-button></a-tooltip>
      <a-tooltip :title="t('player.recents')"><a-button shape="circle" @click="key('app_switch')">□</a-button></a-tooltip>
      <span class="fps">{{ state === 'live' ? `${fps} fps` : '' }}</span>
      <a-tooltip :title="canH264 ? t('player.sourceTip') : t('player.noWebCodecs')">
        <a-radio-group
          size="small" button-style="solid" :value="secureView ? undefined : source"
          :disabled="state !== 'live' || secureView"
          @change="(e: any) => setPreferred(e.target.value)"
        >
          <a-radio-button value="stf">{{ t('player.sourceStf') }}</a-radio-button>
          <a-radio-button value="scrcpy" :disabled="!canH264">{{ t('player.sourceScrcpy') }}</a-radio-button>
        </a-radio-group>
      </a-tooltip>
      <a-tooltip v-if="source === 'scrcpy'" :title="t('player.readClipboard')">
        <a-button size="small" :disabled="state !== 'live'" @click="readClipboard">{{ t('player.clipboard') }}</a-button>
      </a-tooltip>
      <a-tooltip :title="t('player.secureTip')">
        <a-switch size="small" :checked="secureView" :disabled="state !== 'live'" @change="(v: any) => setSecureView(v)" />
      </a-tooltip>
      <span class="fps" style="width: auto">{{ t('player.secure') }}</span>
    </div>
  </div>
</template>

<style scoped>
.player { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.stage { display: flex; gap: 8px; align-items: stretch; max-width: 100%; }
.screen {
  position: relative; max-width: 100%;
  background: #000; border-radius: 18px; overflow: hidden; border: 6px solid #1f1f1f;
}
canvas { width: 100%; height: 100%; display: block; touch-action: none; outline: none; cursor: pointer; }
canvas:focus-visible { box-shadow: inset 0 0 0 2px var(--cp-primary); }
.overlay {
  position: absolute; inset: 0; display: flex; flex-direction: column; gap: 12px;
  align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.6); color: #fff; padding: 16px; text-align: center;
}
.overlay-msg { font-size: 13px; }
.steps { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; font-size: 13px; }
.steps :deep(.ant-spin) { align-self: center; margin-bottom: 6px; }
.step { display: flex; gap: 8px; align-items: center; opacity: 0.5; }
.step.done { opacity: 0.8; }
.step.active { opacity: 1; font-weight: 600; }
.dot { width: 18px; height: 18px; border-radius: 50%; border: 1px solid currentColor; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
.nav { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; justify-content: center; }
.fps { width: 52px; color: var(--cp-text-tertiary); font-size: 12px; font-variant-numeric: tabular-nums; }
</style>

<style>
/* notification content is rendered outside this component */
.cp-clip-text { white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow: auto; font-size: 12px; }
</style>
