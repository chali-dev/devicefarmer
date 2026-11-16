<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getToken } from '../api/client'

/**
 * Live-ish screen preview for the cloud phone grid: a small JPEG refreshed every few seconds, only
 * while the card is on screen and the tab is visible (the API shares one screencap per device).
 */
const props = defineProps<{ instanceId: string; running: boolean; width: number; height: number }>()
const REFRESH_MS = 5000

const el = ref<HTMLElement | null>(null)
const src = ref<string | null>(null)
const denied = ref(false)
let visible = false
let timer: ReturnType<typeof setTimeout> | null = null
let busy = false
let observer: IntersectionObserver | null = null

function setSrc(url: string | null) {
  if (src.value) URL.revokeObjectURL(src.value)
  src.value = url
}

async function load() {
  timer = null
  if (!props.running || denied.value || !visible || document.hidden || busy) return schedule()
  busy = true
  try {
    const res = await fetch(`/api/instances/${props.instanceId}/screenshot?thumb=1`, { headers: { authorization: `Bearer ${getToken()}` } })
    if (res.status === 403) denied.value = true // no `control` grant: keep the placeholder
    else if (res.ok) setSrc(URL.createObjectURL(await res.blob()))
  } catch { /* keep the last frame */ }
  busy = false
  schedule()
}
function schedule() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(load, REFRESH_MS)
}
function now() { if (timer) clearTimeout(timer); void load() }
function onVisibility() { if (!document.hidden) now() }

onMounted(() => {
  observer = new IntersectionObserver(([e]) => {
    const was = visible
    visible = !!e?.isIntersecting
    if (visible && !was) now()
  })
  if (el.value) observer.observe(el.value)
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  observer?.disconnect()
  document.removeEventListener('visibilitychange', onVisibility)
  setSrc(null)
})
watch(() => props.running, (r) => { if (r) now(); else setSrc(null) })
</script>

<template>
  <div ref="el" class="thumb" :style="{ aspectRatio: `${width} / ${height}` }">
    <img v-if="src && running" :src="src" alt="" draggable="false" />
    <div v-else class="placeholder"><slot /></div>
  </div>
</template>

<style scoped>
.thumb { position: relative; width: 100%; background: var(--cp-fill-alter); border-radius: 10px; overflow: hidden; }
img { width: 100%; height: 100%; object-fit: cover; display: block; user-select: none; }
.placeholder { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 8px; align-items: center; justify-content: center; color: var(--cp-text-tertiary); font-size: 12px; padding: 8px; text-align: center; }
</style>
