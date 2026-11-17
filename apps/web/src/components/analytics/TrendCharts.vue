<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { dateLocale } from '../../i18n'
import { compactNumber, dayTs, type AnalyticsSums } from '../../api/types'
import LineChart from '../tracked/LineChart.vue'

/**
 * Followers gained / views / likes / comments / shares per day. A day without data is a gap in the line
 * (not 0, so missing days don't pull the line or the axis down) and '—' in the totals when no day has data.
 */
const props = defineProps<{ days: ({ day: string } & Partial<AnalyticsSums>)[]; height?: number }>()
const { t } = useI18n()
const KEYS = ['followersGained', 'views', 'likes', 'comments', 'shares'] as const
const shortDay = (ts: number) => new Date(ts).toLocaleDateString(dateLocale(), { month: '2-digit', day: '2-digit' })
const series = computed(() => KEYS.map((k) => {
  const vals = props.days.map((d) => d[k] ?? null)
  const reported = vals.filter((v): v is number => v !== null)
  return {
    key: k,
    points: props.days.map((d, i) => ({ t: dayTs(d.day), v: vals[i] ?? null })),
    total: reported.length ? reported.reduce((s, v) => s + v, 0) : null,
  }
}))
</script>

<template>
  <a-row :gutter="[16, 16]">
    <a-col v-for="s in series" :key="s.key" :xs="24" :md="12" :xl="8">
      <div class="chart-title">
        {{ t(`analytics.perDay.${s.key}`) }}
        <span class="total">{{ s.total === null ? '—' : (s.key === 'followersGained' && s.total > 0 ? '+' : '') + compactNumber(s.total) }}</span>
      </div>
      <LineChart :points="s.points" :height="height ?? 160" :format-time="shortDay" :format="compactNumber" :aria-label="t(`analytics.perDay.${s.key}`)" />
    </a-col>
  </a-row>
</template>

<style scoped>
.chart-title { color: var(--cp-text-secondary); margin-bottom: 4px; display: flex; justify-content: space-between; gap: 8px; }
.total { color: var(--cp-text); font-weight: 600; font-variant-numeric: tabular-nums; }
</style>
