<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { compactNumber, dayTs, type AnalyticsSums } from '../../api/types'
import LineChart from '../tracked/LineChart.vue'

/** Followers gained / views / shares per day (days without data count as 0 in the line, '—' in the totals). */
const props = defineProps<{ days: ({ day: string } & Partial<AnalyticsSums>)[]; height?: number }>()
const { t } = useI18n()
const KEYS = ['followersGained', 'views', 'shares'] as const
const shortDay = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })
const series = computed(() => KEYS.map((k) => {
  const vals = props.days.map((d) => d[k] ?? null)
  const reported = vals.filter((v): v is number => v !== null)
  return {
    key: k,
    points: props.days.map((d, i) => ({ t: dayTs(d.day), v: vals[i] ?? 0 })),
    total: reported.length ? reported.reduce((s, v) => s + v, 0) : null,
  }
}))
</script>

<template>
  <a-row :gutter="[16, 16]">
    <a-col v-for="s in series" :key="s.key" :xs="24" :lg="8">
      <div class="chart-title">
        {{ t(`analytics.perDay.${s.key}`) }}
        <span class="total">{{ s.total === null ? '—' : (s.key === 'followersGained' && s.total > 0 ? '+' : '') + compactNumber(s.total) }}</span>
      </div>
      <LineChart :points="s.points" :height="height ?? 160" :format-time="shortDay" :format="compactNumber" :aria-label="t(`analytics.perDay.${s.key}`)" />
    </a-col>
  </a-row>
</template>

<style scoped>
.chart-title { font-weight: 600; color: var(--cp-text-secondary); font-size: 13px; margin-bottom: 4px; display: flex; justify-content: space-between; }
.total { color: var(--cp-text); font-variant-numeric: tabular-nums; }
</style>
