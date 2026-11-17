<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Rect } from './media'

/**
 * Picked file (image, or a scrubbable video frame) with a crop box that can be moved and resized
 * from its corners. `ratio` = pixel w/h the box is locked to (null = free). The rect is in 0..1 of
 * the displayed (orientation-corrected) source, which is what the API expects; the server crops.
 */
const props = defineProps<{ src: string; video: boolean; ratio: number | null; disabled?: boolean }>()
const rect = defineModel<Rect | null>('rect', { required: true })
const dims = defineModel<{ w: number; h: number } | null>('dims', { required: true })
/** The loaded <img>/<video> (after each seek for video), for the editor's preview. */
const emit = defineEmits<{ frame: [el: HTMLImageElement | HTMLVideoElement] }>()
const { t } = useI18n()

const stage = ref<HTMLElement | null>(null)
const media = ref<HTMLImageElement | HTMLVideoElement | null>(null)
const duration = ref(0)
const time = ref(0)

function onImg(e: Event) {
  const el = e.target as HTMLImageElement
  dims.value = { w: el.naturalWidth, h: el.naturalHeight }
  emit('frame', el)
}
function onMeta(e: Event) {
  const el = e.target as HTMLVideoElement
  dims.value = { w: el.videoWidth, h: el.videoHeight }
  duration.value = Number.isFinite(el.duration) ? el.duration : 0
  time.value = Math.min(0.1, duration.value / 2)
  el.currentTime = time.value
}
function onSeeked(e: Event) { emit('frame', e.target as HTMLVideoElement) }
watch(time, (v) => { if (media.value instanceof HTMLVideoElement && Math.abs(media.value.currentTime - v) > 0.01) media.value.currentTime = v })
watch(() => props.src, () => { time.value = 0 })

const box = computed(() => (dims.value && rect.value && !props.disabled ? rect.value : null))

// ------------------------------------------------------------ pointer: move inside the box, resize from a corner
type Handle = 'nw' | 'ne' | 'sw' | 'se'
const HANDLES: Handle[] = ['nw', 'ne', 'sw', 'se']
let drag: { id: number; mode: 'move' | Handle; start: { x: number; y: number }; r0: Rect } | null = null

/** Pointer position in source pixels. */
function srcPoint(e: PointerEvent) {
  const r = stage.value!.getBoundingClientRect()
  const d = dims.value!
  return { x: ((e.clientX - r.left) / r.width) * d.w, y: ((e.clientY - r.top) / r.height) * d.h }
}
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

function down(e: PointerEvent) {
  const b = box.value
  if (!b || !stage.value || e.button > 0) return
  const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined
  const p = srcPoint(e)
  const d = dims.value!
  const inside = p.x >= b.x * d.w && p.x <= (b.x + b.w) * d.w && p.y >= b.y * d.h && p.y <= (b.y + b.h) * d.h
  if (!handle && !inside) return
  drag = { id: e.pointerId, mode: handle ?? 'move', start: p, r0: { ...b } }
  stage.value.setPointerCapture(e.pointerId)
  e.preventDefault()
}

function move(e: PointerEvent) {
  if (!drag || drag.id !== e.pointerId || !dims.value) return
  const { w: W, h: H } = dims.value
  const p = srcPoint(e)
  const r0 = drag.r0
  if (drag.mode === 'move') {
    const dx = (p.x - drag.start.x) / W, dy = (p.y - drag.start.y) / H
    rect.value = { ...r0, x: clamp(r0.x + dx, 0, 1 - r0.w), y: clamp(r0.y + dy, 0, 1 - r0.h) }
    return
  }
  // Anchor = the corner opposite the dragged one; the box may flip across it.
  const ax = (drag.mode.includes('w') ? r0.x + r0.w : r0.x) * W
  const ay = (drag.mode.includes('n') ? r0.y + r0.h : r0.y) * H
  const dx = p.x - ax, dy = p.y - ay
  const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1
  const maxW = sx > 0 ? W - ax : ax, maxH = sy > 0 ? H - ay : ay
  // Smallest box: 3 % of each side (the server accepts ≥ 1 %), at least 16 px.
  const minW = Math.min(maxW, Math.max(16, 0.03 * W)), minH = Math.min(maxH, Math.max(16, 0.03 * H))
  let w: number, h: number
  const r = props.ratio
  if (r) {
    w = Math.max(Math.abs(dx), Math.abs(dy) * r, minW, minH * r)
    w = Math.min(w, maxW, maxH * r)
    h = w / r
  } else {
    w = clamp(Math.abs(dx), minW, maxW)
    h = clamp(Math.abs(dy), minH, maxH)
  }
  const x = sx > 0 ? ax : ax - w, y = sy > 0 ? ay : ay - h
  rect.value = { x: clamp(x / W, 0, 1), y: clamp(y / H, 0, 1), w: Math.min(w / W, 1), h: Math.min(h / H, 1) }
}
function up(e: PointerEvent) { if (drag?.id === e.pointerId) drag = null }

const pct = (v: number) => `${v * 100}%`
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`
</script>

<template>
  <div class="wrap">
    <div ref="stage" class="stage" :class="{ editable: !!box }" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up">
      <video
        v-if="video" ref="media" :src="src" muted playsinline preload="auto"
        @loadedmetadata="onMeta" @seeked="onSeeked"
      />
      <img v-else ref="media" :src="src" alt="" draggable="false" @load="onImg">
      <template v-if="box">
        <!-- four shades instead of one big box-shadow: Chrome doesn't paint that over a <video> -->
        <div class="shade" :style="{ left: 0, top: 0, width: '100%', height: pct(box.y) }" />
        <div class="shade" :style="{ left: 0, top: pct(box.y + box.h), width: '100%', bottom: 0 }" />
        <div class="shade" :style="{ left: 0, top: pct(box.y), width: pct(box.x), height: pct(box.h) }" />
        <div class="shade" :style="{ left: pct(box.x + box.w), right: 0, top: pct(box.y), height: pct(box.h) }" />
        <div class="box" :style="{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }">
          <div v-for="h in HANDLES" :key="h" class="handle" :class="h" :data-handle="h" />
        </div>
      </template>
    </div>
    <div v-if="video && duration > 0" class="scrub">
      <span class="muted small nowrap">{{ t('media.editorFrame') }}</span>
      <a-slider v-model:value="time" :min="0" :max="duration" :step="0.1" :tip-formatter="null" style="flex: 1" />
      <span class="muted small nowrap">{{ fmtTime(time) }}</span>
    </div>
  </div>
</template>

<style scoped>
.wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 340px; background: var(--cp-fill-alter); border-radius: var(--cp-radius); padding: 12px; }
.stage { position: relative; display: inline-block; max-width: 100%; line-height: 0; user-select: none; }
.stage.editable { touch-action: none; }
.stage img, .stage video { display: block; max-width: 100%; max-height: 360px; pointer-events: none; }
.shade { position: absolute; z-index: 1; background: var(--cp-mask); pointer-events: none; }
.box { position: absolute; z-index: 2; outline: 2px solid var(--cp-primary); outline-offset: -1px; cursor: move; }
.handle { position: absolute; width: 14px; height: 14px; background: var(--cp-bg-container); border: 2px solid var(--cp-primary); border-radius: 2px; }
.handle.nw { left: -7px; top: -7px; cursor: nwse-resize; }
.handle.ne { right: -7px; top: -7px; cursor: nesw-resize; }
.handle.sw { left: -7px; bottom: -7px; cursor: nesw-resize; }
.handle.se { right: -7px; bottom: -7px; cursor: nwse-resize; }
.scrub { display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 8px; }
</style>
