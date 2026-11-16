<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
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
/** Show FLAG_SECURE windows (e.g. Google sign-in) via the system capture helper. */
const secureView = ref(false)
function setSecureView(v: boolean) {
  secureView.value = v
  send({ type: 'screenSource', source: v ? 'secure' : 'stf' })
}
let ws: WebSocket | null = null
let frames = 0
let fpsTimer: ReturnType<typeof setInterval> | null = null
let drawing = false
let pending: Blob | null = null
let pointerDown = false
let lastMove = 0

function setState(s: PlayerState, msg = '') {
  state.value = s
  message.value = msg
  emit('state', s)
}

function send(msg: object) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

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
    frames++
    if (state.value === 'connecting' && stage.value === 'frame') goLive()
  } catch { /* corrupt frame */ }
  drawing = false
  if (pending) { const p = pending; pending = null; void draw(p) }
}

/** Live on the first frame; a static screen may send none for a while, so don't wait forever. */
function goLive() {
  if (liveTimer) clearTimeout(liveTimer)
  liveTimer = null
  if (state.value === 'connecting') { setState('live'); if (secureView.value) send({ type: 'screenSource', source: 'secure' }) }
}

function connect() {
  close()
  stage.value = 'socket'
  setState('connecting')
  ws = new WebSocket(wsUrl(`/api/instances/${props.instanceId}/session`))
  ws.binaryType = 'blob'
  ws.onopen = () => { stage.value = 'session'; ws?.send(JSON.stringify({ type: 'auth', token: getToken() })) }
  ws.onmessage = (m) => {
    if (m.data instanceof Blob) { void draw(m.data); return }
    const msg = JSON.parse(m.data)
    if (msg.type === 'ready') { stage.value = 'frame'; liveTimer = setTimeout(goLive, 3000) }
    else if (msg.type === 'screenSource') {
      secureView.value = msg.source === 'secure'
      if (msg.reason) void import('ant-design-vue').then(({ message: m }) => m.warning(codeText(msg.code, msg.params, msg.reason)))
    }
    else if (msg.type === 'error') message.value = msg.message
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
.nav { display: flex; gap: 16px; align-items: center; }
.fps { width: 52px; color: var(--cp-text-tertiary); font-size: 12px; font-variant-numeric: tabular-nums; }
</style>
