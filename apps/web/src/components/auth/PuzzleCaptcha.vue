<script setup lang="ts">
import { ArrowRightOutlined, CheckOutlined, CloseOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ApiError, api, errorText } from '../../api/client'

/**
 * Slider puzzle captcha (拼图验证) of the login page. Loads a challenge from GET /api/auth/captcha, lets the
 * user drag the piece with the slider (pointer = mouse + touch; arrow keys, Home/End, Enter to check) and
 * checks it on release with POST /api/auth/captcha/verify. A correct answer becomes the v-model (sent with
 * the login, which consumes it); a wrong one shows the failure and loads a new challenge. `enabled` is
 * false when the server has LOGIN_CAPTCHA=off (nothing is rendered then).
 */
export interface CaptchaAnswer { id: string; x: number; trail: [number, number][] }
interface Challenge { enabled: true; id: string; bg: string; piece: string; y: number; width: number; height: number; pieceSize: number; ttlSec: number }

const answer = defineModel<CaptchaAnswer | null>({ default: null })
const enabled = defineModel<boolean | null>('enabled', { default: null })
const { t } = useI18n()

const c = ref<Challenge | null>(null)
const loading = ref(false)
const loadError = ref('')
const status = ref<'idle' | 'dragging' | 'checking' | 'ok' | 'fail'>('idle')
const failText = ref('')
/** Piece position in challenge pixels (0 … width − pieceSize). */
const pos = ref(0)
const track = ref<HTMLElement | null>(null)
let trail: [number, number][] = []
let t0 = 0
let dragStart: { clientX: number; pos: number } | null = null
let expiryTimer: ReturnType<typeof setTimeout> | undefined
let failTimer: ReturnType<typeof setTimeout> | undefined

const W = computed(() => c.value?.width ?? 320)
const H = computed(() => c.value?.height ?? 160)
const P = computed(() => c.value?.pieceSize ?? 50)
const max = computed(() => W.value - P.value)
const pct = (v: number, of = W.value) => `${(v / of) * 100}%`
const locked = computed(() => !c.value || loading.value || status.value === 'checking' || status.value === 'ok' || status.value === 'fail')

async function refresh() {
  clearTimeout(expiryTimer)
  clearTimeout(failTimer)
  answer.value = null
  status.value = 'idle'
  pos.value = 0
  trail = []
  dragStart = null
  loading.value = true
  loadError.value = ''
  try {
    const r = await api<Challenge | { enabled: false }>('GET', '/api/auth/captcha')
    enabled.value = r.enabled
    if (!r.enabled) { c.value = null; return }
    c.value = r
    // Load a new one shortly before the server forgets this one.
    expiryTimer = setTimeout(refresh, Math.max(5, r.ttlSec - 3) * 1000)
  } catch (e) {
    c.value = null
    loadError.value = errorText(e)
    if (enabled.value === null) enabled.value = true
  } finally {
    loading.value = false
  }
}
defineExpose({ refresh })

function record() {
  const now = performance.now()
  if (!trail.length) t0 = now
  const p: [number, number] = [Math.round(pos.value), Math.round(now - t0)]
  const last = trail[trail.length - 1]
  if (last && p[1] - last[1] < 16 && trail.length > 1) trail[trail.length - 1] = p
  else if (trail.length < 400) trail.push(p)
  else trail[trail.length - 1] = p
}

function scale(): number {
  const w = track.value?.clientWidth ?? W.value
  return w ? W.value / w : 1
}
const clamp = (v: number) => Math.min(max.value, Math.max(0, v))

function down(e: PointerEvent) {
  if (locked.value || (e.pointerType === 'mouse' && e.button !== 0)) return
  try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
  dragStart = { clientX: e.clientX, pos: pos.value }
  status.value = 'dragging'
  trail = []
  record()
}
function move(e: PointerEvent) {
  if (!dragStart) return
  pos.value = clamp(dragStart.pos + (e.clientX - dragStart.clientX) * scale())
  record()
}
function up() {
  if (!dragStart) return
  const moved = Math.abs(pos.value - dragStart.pos) >= 1
  dragStart = null
  // A click (or a press without movement) is not an answer: it only focuses the slider.
  if (!moved) { status.value = 'idle'; trail = []; return }
  record()
  void check()
}

function key(e: KeyboardEvent) {
  if (locked.value) return
  const step = e.shiftKey ? 10 : 2
  let next: number | null = null
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = pos.value + step
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = pos.value - step
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = max.value
  else if ((e.key === 'Enter' || e.key === ' ') && trail.length) { e.preventDefault(); record(); void check(); return }
  if (next === null) return
  e.preventDefault()
  if (!trail.length) record()
  pos.value = clamp(next)
  record()
}

async function check() {
  if (!c.value) return
  status.value = 'checking'
  const body: CaptchaAnswer = { id: c.value.id, x: Math.round(pos.value), trail: trail.slice() }
  try {
    await api('POST', '/api/auth/captcha/verify', body)
    status.value = 'ok'
    answer.value = body
  } catch (e) {
    status.value = 'fail'
    failText.value = e instanceof ApiError && e.code ? errorText(e) : t('auth.captcha.failed')
    failTimer = setTimeout(refresh, 1200)
  }
}

onMounted(refresh)
onBeforeUnmount(() => { clearTimeout(expiryTimer); clearTimeout(failTimer) })
</script>

<template>
  <div v-if="enabled !== false" class="captcha" :class="status">
    <div class="stage" :style="{ aspectRatio: `${W} / ${H}` }">
      <template v-if="c">
        <img :src="c.bg" class="bg" alt="" draggable="false" />
        <img
          :src="c.piece" class="piece" alt="" draggable="false"
          :style="{ left: pct(pos), top: pct(c.y, H), width: pct(P) }"
        />
      </template>
      <div v-if="loading" class="overlay"><a-spin /></div>
      <button v-else-if="loadError" type="button" class="overlay load-error" @click="refresh">{{ loadError }}<br />{{ t('auth.captcha.retry') }}</button>
      <div v-if="status === 'fail'" class="banner fail" role="alert">{{ failText }}</div>
      <div v-else-if="status === 'ok'" class="banner ok" role="status">{{ t('auth.captcha.verified') }}</div>
      <a-tooltip :title="t('auth.captcha.refresh')">
        <button type="button" class="refresh" :aria-label="t('auth.captcha.refresh')" :disabled="loading || status === 'checking'" @click="refresh">
          <ReloadOutlined />
        </button>
      </a-tooltip>
    </div>
    <div ref="track" class="track">
      <div class="fill" :style="{ width: `calc(${pct(pos)} + ${pct(P)} / 2)` }" />
      <span v-if="status === 'idle' && pos === 0" class="hint">{{ t('auth.captcha.hint') }}</span>
      <div
        class="handle" role="slider" :tabindex="locked ? -1 : 0"
        :aria-label="t('auth.captcha.label')" :aria-valuemin="0" :aria-valuemax="max" :aria-valuenow="Math.round(pos)"
        :aria-disabled="locked" :style="{ left: pct(pos), width: pct(P) }"
        @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @keydown="key"
      >
        <CheckOutlined v-if="status === 'ok'" />
        <CloseOutlined v-else-if="status === 'fail'" />
        <ArrowRightOutlined v-else />
      </div>
    </div>
  </div>
</template>

<style scoped>
.captcha { margin-bottom: 24px; user-select: none; -webkit-user-select: none; }
.stage {
  position: relative; width: 100%; overflow: hidden; border-radius: var(--cp-radius);
  background: var(--cp-fill-alter); border: 1px solid var(--cp-border-secondary); box-sizing: border-box;
}
.bg { display: block; width: 100%; height: 100%; }
.piece { position: absolute; height: auto; pointer-events: none; filter: drop-shadow(0 0 3px rgba(0, 0, 0, 0.55)); }
.overlay {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: var(--cp-bg-container); color: var(--cp-text-secondary); border: 0; font: inherit; text-align: center; padding: 8px;
}
.load-error { cursor: pointer; color: var(--cp-error); }
.banner {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 4px 8px; font-size: 13px; text-align: center;
  color: var(--cp-bg-container);
}
.banner.ok { background: var(--cp-success); }
.banner.fail { background: var(--cp-error); }
.refresh {
  position: absolute; top: 6px; right: 6px; width: 28px; height: 28px; border: 0; border-radius: var(--cp-radius);
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
  background: var(--cp-mask); color: #fff; font-size: 14px;
}
.refresh:disabled { cursor: default; opacity: 0.5; }
.refresh:focus-visible { outline: 2px solid var(--cp-primary); outline-offset: 1px; }
.track {
  position: relative; margin-top: 8px; height: 40px; border-radius: var(--cp-radius);
  background: var(--cp-fill-alter); border: 1px solid var(--cp-border); box-sizing: border-box;
}
.fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: var(--cp-radius); background: var(--cp-primary-bg); }
.ok .fill { background: color-mix(in srgb, var(--cp-success) 18%, transparent); }
.fail .fill { background: color-mix(in srgb, var(--cp-error) 18%, transparent); }
.hint {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding-left: 16%;
  color: var(--cp-text-tertiary); font-size: 13px; pointer-events: none; white-space: nowrap; overflow: hidden;
}
.handle {
  position: absolute; top: -1px; bottom: -1px; min-width: 36px; box-sizing: border-box;
  display: flex; align-items: center; justify-content: center; cursor: grab; touch-action: none;
  border-radius: var(--cp-radius); background: var(--cp-primary); color: var(--cp-bg-container); font-size: 16px;
  box-shadow: var(--cp-shadow);
}
.dragging .handle { cursor: grabbing; }
.ok .handle { background: var(--cp-success); cursor: default; }
.fail .handle { background: var(--cp-error); cursor: default; }
.checking .handle { opacity: 0.8; cursor: progress; }
.handle:focus-visible { outline: 2px solid var(--cp-primary); outline-offset: 2px; }
</style>
