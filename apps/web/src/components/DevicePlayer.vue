<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getToken, wsUrl } from '../api/client'

const props = defineProps<{ instanceId: string; width: number; height: number }>()
const emit = defineEmits<{ (e: 'state', s: PlayerState): void }>()

export type PlayerState = 'connecting' | 'live' | 'closed' | 'error'

const canvas = ref<HTMLCanvasElement | null>(null)
const state = ref<PlayerState>('connecting')
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
  } catch { /* corrupt frame */ }
  drawing = false
  if (pending) { const p = pending; pending = null; void draw(p) }
}

function connect() {
  close()
  setState('connecting')
  ws = new WebSocket(wsUrl(`/api/instances/${props.instanceId}/session`))
  ws.binaryType = 'blob'
  ws.onopen = () => ws?.send(JSON.stringify({ type: 'auth', token: getToken() }))
  ws.onmessage = (m) => {
    if (m.data instanceof Blob) { void draw(m.data); return }
    const msg = JSON.parse(m.data)
    if (msg.type === 'ready') { setState('live'); if (secureView.value) send({ type: 'screenSource', source: 'secure' }) }
    else if (msg.type === 'screenSource') {
      secureView.value = msg.source === 'secure'
      if (msg.reason) void import('ant-design-vue').then(({ message: m }) => m.warning(msg.reason))
    }
    else if (msg.type === 'error') message.value = msg.message
  }
  ws.onclose = (e) => {
    if (state.value !== 'closed') setState(e.code === 1000 ? 'closed' : 'error', e.reason || message.value || '连接已断开')
  }
  fpsTimer = setInterval(() => { fps.value = frames; frames = 0 }, 1000)
}

function close() {
  if (fpsTimer) clearInterval(fpsTimer)
  fpsTimer = null
  if (ws) { ws.onclose = null; ws.close(1000) }
  ws = null
}

function point(e: PointerEvent) {
  const r = canvas.value!.getBoundingClientRect()
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  }
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
defineExpose({ key, paste, typeSecure, reconnect: connect })

onMounted(connect)
onBeforeUnmount(close)
watch(() => props.instanceId, connect)
</script>

<template>
  <div class="player">
    <div class="screen" :style="{ aspectRatio: `${width} / ${height}` }">
      <canvas
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
        <a-spin v-if="state === 'connecting'" tip="连接中…" />
        <template v-else>
          <div class="overlay-msg">{{ message || '已断开' }}</div>
          <a-button size="small" type="primary" @click="connect">重新连接</a-button>
        </template>
      </div>
    </div>
    <div class="nav">
      <a-tooltip title="返回（也可右键画面）"><a-button shape="circle" @click="key('back')">◁</a-button></a-tooltip>
      <a-tooltip title="主页"><a-button shape="circle" @click="key('home')">○</a-button></a-tooltip>
      <a-tooltip title="最近任务"><a-button shape="circle" @click="key('app_switch')">□</a-button></a-tooltip>
      <span class="fps">{{ state === 'live' ? `${fps} fps` : '' }}</span>
      <a-tooltip title="显示受保护画面（如 Google 登录页）。关闭时使用按需刷新的普通画面流，更省资源。">
        <a-switch size="small" :checked="secureView" :disabled="state !== 'live'" @change="(v: any) => setSecureView(v)" />
      </a-tooltip>
      <span class="fps" style="width: auto">受保护画面</span>
    </div>
  </div>
</template>

<style scoped>
.player { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.screen {
  position: relative; height: min(72vh, 900px); max-width: 100%;
  background: #000; border-radius: 18px; overflow: hidden; border: 6px solid #1f1f1f;
}
canvas { width: 100%; height: 100%; display: block; touch-action: none; outline: none; cursor: pointer; }
canvas:focus-visible { box-shadow: inset 0 0 0 2px #1677ff; }
.overlay {
  position: absolute; inset: 0; display: flex; flex-direction: column; gap: 12px;
  align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.6); color: #fff; padding: 16px; text-align: center;
}
.overlay-msg { font-size: 13px; }
.nav { display: flex; gap: 16px; align-items: center; }
.fps { width: 52px; color: #8c8c8c; font-size: 12px; font-variant-numeric: tabular-nums; }
</style>
