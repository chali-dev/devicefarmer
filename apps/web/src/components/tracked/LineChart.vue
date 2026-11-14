<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * Minimal single-series time line chart (inline SVG, no chart library): recessive grid,
 * 2px line, point markers, crosshair + tooltip on hover. Colours come from --cp-* theme tokens.
 * The snapshot table next to it is the accessible table view.
 */
const props = withDefaults(defineProps<{
  points: { t: number; v: number }[]
  height?: number
  format?: (v: number) => string
  formatTime?: (t: number) => string
  ariaLabel?: string
}>(), { height: 200 })

const box = ref<HTMLDivElement>()
const width = ref(600)
let ro: ResizeObserver | null = null
onMounted(() => {
  ro = new ResizeObserver(([e]) => { if (e) width.value = Math.max(240, e.contentRect.width) })
  if (box.value) ro.observe(box.value)
})
onBeforeUnmount(() => ro?.disconnect())

const fmt = (v: number) => (props.format ? props.format(v) : String(v))
const fmtT = (t: number) => (props.formatTime ? props.formatTime(t) : new Date(t).toLocaleDateString())
const PAD = { l: 56, r: 16, t: 12, b: 26 }

const geo = computed(() => {
  const pts = [...props.points].sort((a, b) => a.t - b.t)
  const w = width.value, h = props.height
  const t0 = pts[0]?.t ?? 0, t1 = pts[pts.length - 1]?.t ?? 1
  let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v))
  if (!Number.isFinite(lo)) { lo = 0; hi = 1 }
  if (lo === hi) { lo -= Math.max(1, Math.abs(lo) * 0.05); hi += Math.max(1, Math.abs(hi) * 0.05) }
  const pad = (hi - lo) * 0.1
  lo -= pad; hi += pad
  const x = (t: number) => (t1 === t0 ? (PAD.l + w - PAD.r) / 2 : PAD.l + ((t - t0) / (t1 - t0)) * (w - PAD.l - PAD.r))
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (h - PAD.t - PAD.b)
  const ticks = [0, 1, 2, 3].map((i) => lo + ((hi - lo) * i) / 3)
  const xy = pts.map((p) => ({ ...p, x: x(p.t), y: y(p.v) }))
  return {
    w, h, xy, ticks: ticks.map((v) => ({ v, y: y(v) })),
    path: xy.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
    xLabels: pts.length ? [{ x: x(t0), t: t0, anchor: 'start' }, ...(t1 !== t0 ? [{ x: x(t1), t: t1, anchor: 'end' }] : [])] : [],
  }
})

const hover = ref<number | null>(null)
function onMove(e: MouseEvent) {
  const svg = e.currentTarget as SVGSVGElement
  const mx = e.clientX - svg.getBoundingClientRect().left
  let best = -1, dist = Infinity
  geo.value.xy.forEach((p, i) => { const d = Math.abs(p.x - mx); if (d < dist) { dist = d; best = i } })
  hover.value = best >= 0 ? best : null
}
const hp = computed(() => (hover.value === null ? null : geo.value.xy[hover.value] ?? null))
</script>

<template>
  <div ref="box" class="chart">
    <svg :width="geo.w" :height="geo.h" role="img" :aria-label="ariaLabel" @mousemove="onMove" @mouseleave="hover = null">
      <g class="grid">
        <template v-for="tk in geo.ticks" :key="tk.v">
          <line :x1="PAD.l" :x2="geo.w - PAD.r" :y1="tk.y" :y2="tk.y" />
          <text :x="PAD.l - 6" :y="tk.y" text-anchor="end" dominant-baseline="middle">{{ fmt(Math.round(tk.v)) }}</text>
        </template>
        <text v-for="xl in geo.xLabels" :key="xl.t" :x="xl.x" :y="geo.h - 6" :text-anchor="xl.anchor">{{ fmtT(xl.t) }}</text>
      </g>
      <path :d="geo.path" class="line" />
      <circle v-for="p in geo.xy" :key="p.t" :cx="p.x" :cy="p.y" r="4" class="dot" />
      <template v-if="hp">
        <line :x1="hp.x" :x2="hp.x" :y1="PAD.t" :y2="geo.h - PAD.b" class="cross" />
        <circle :cx="hp.x" :cy="hp.y" r="6" class="dot hot" />
      </template>
    </svg>
    <div v-if="hp" class="tip" :style="{ left: `${Math.min(hp.x + 10, geo.w - 150)}px`, top: `${Math.max(hp.y - 44, 0)}px` }">
      <div class="tip-v">{{ fmt(hp.v) }}</div>
      <div class="tip-t">{{ new Date(hp.t).toLocaleString() }}</div>
    </div>
  </div>
</template>

<style scoped>
.chart { position: relative; width: 100%; }
svg { display: block; overflow: visible; }
.grid line { stroke: var(--cp-border-secondary); stroke-width: 1; }
.grid text { fill: var(--cp-text-tertiary); font-size: 11px; }
.line { fill: none; stroke: var(--cp-primary); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.dot { fill: var(--cp-primary); stroke: var(--cp-bg-container); stroke-width: 2; }
.cross { stroke: var(--cp-text-quaternary); stroke-width: 1; stroke-dasharray: 3 3; }
.tip {
  position: absolute; pointer-events: none; background: var(--cp-bg-container); border: 1px solid var(--cp-border-secondary);
  border-radius: 6px; padding: 4px 8px; font-size: 12px; white-space: nowrap;
}
.tip-v { color: var(--cp-text); font-weight: 600; }
.tip-t { color: var(--cp-text-tertiary); }
</style>
