<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { MediaCropAspect } from '../../api/types'
import { cropFraction } from './media'

/**
 * Local preview of a picked file (image, or a video's first frame) with a draggable crop box
 * for the chosen aspect. Only the position is chosen here; the server does the cropping.
 * `pos` = centre of the box in 0..1 of the displayed source (what the API expects).
 */
const props = defineProps<{ file: File; video: boolean; aspect: MediaCropAspect }>()
const pos = defineModel<{ x: number; y: number }>('pos', { required: true })
const dims = defineModel<{ w: number; h: number } | null>('dims', { default: null })

const url = ref('')
watch(() => props.file, (f) => {
  if (url.value) URL.revokeObjectURL(url.value)
  url.value = URL.createObjectURL(f)
}, { immediate: true })
onBeforeUnmount(() => { if (url.value) URL.revokeObjectURL(url.value) })

function onImg(e: Event) { const el = e.target as HTMLImageElement; dims.value = { w: el.naturalWidth, h: el.naturalHeight } }
function onVideo(e: Event) { const el = e.target as HTMLVideoElement; dims.value = { w: el.videoWidth, h: el.videoHeight } }

const box = computed(() => (dims.value && props.aspect !== 'original' ? cropFraction(dims.value.w, dims.value.h, props.aspect, pos.value) : null))

const stage = ref<HTMLElement | null>(null)
let drag: { id: number; dx: number; dy: number } | null = null
function frac(e: PointerEvent) {
  const r = stage.value!.getBoundingClientRect()
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
}
/** Keeps the stored centre on the clamped box, so it matches what the server will cut. */
function moveTo(cx: number, cy: number) {
  if (!dims.value) return
  const b = cropFraction(dims.value.w, dims.value.h, props.aspect, { x: cx, y: cy })
  pos.value = { x: round(b.left + b.w / 2), y: round(b.top + b.h / 2) }
}
const round = (v: number) => Math.round(v * 10000) / 10000
function down(e: PointerEvent) {
  const b = box.value
  if (!b || !stage.value) return
  const p = frac(e)
  const inside = p.x >= b.left && p.x <= b.left + b.w && p.y >= b.top && p.y <= b.top + b.h
  if (!inside) moveTo(p.x, p.y)
  const c = { x: pos.value.x, y: pos.value.y }
  drag = { id: e.pointerId, dx: p.x - c.x, dy: p.y - c.y }
  stage.value.setPointerCapture(e.pointerId)
  e.preventDefault()
}
function move(e: PointerEvent) {
  if (!drag || drag.id !== e.pointerId) return
  const p = frac(e)
  moveTo(p.x - drag.dx, p.y - drag.dy)
}
function up(e: PointerEvent) { if (drag?.id === e.pointerId) drag = null }
</script>

<template>
  <div class="wrap">
    <div ref="stage" class="stage" :class="{ draggable: !!box }" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up">
      <video v-if="video" :src="`${url}#t=0.1`" muted playsinline preload="metadata" @loadedmetadata="onVideo" />
      <img v-else :src="url" alt="" draggable="false" @load="onImg">
      <template v-if="box">
        <!-- four shades instead of one big box-shadow: Chrome doesn't paint that over a <video> -->
        <div class="shade" :style="{ left: 0, top: 0, width: '100%', height: `${box.top * 100}%` }" />
        <div class="shade" :style="{ left: 0, top: `${(box.top + box.h) * 100}%`, width: '100%', bottom: 0 }" />
        <div class="shade" :style="{ left: 0, top: `${box.top * 100}%`, width: `${box.left * 100}%`, height: `${box.h * 100}%` }" />
        <div class="shade" :style="{ left: `${(box.left + box.w) * 100}%`, right: 0, top: `${box.top * 100}%`, height: `${box.h * 100}%` }" />
        <div class="box" :style="{ left: `${box.left * 100}%`, top: `${box.top * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.wrap { display: flex; justify-content: center; background: var(--cp-fill-alter); border-radius: var(--cp-radius); padding: 8px; }
.stage { position: relative; display: inline-block; max-width: 100%; line-height: 0; overflow: hidden; user-select: none; }
.stage.draggable { cursor: move; touch-action: none; }
.stage img, .stage video { display: block; max-width: 100%; max-height: 280px; pointer-events: none; }
.shade { position: absolute; z-index: 1; background: var(--cp-mask); }
.box { position: absolute; z-index: 1; outline: 2px solid var(--cp-primary); outline-offset: -2px; }
</style>
