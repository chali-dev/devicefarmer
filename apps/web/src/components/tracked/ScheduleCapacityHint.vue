<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TrackedCapacity } from '../../api/types'

/**
 * 采集容量提示 next to a 采集频率 / 采集手机 picker: per 采集手机 its scheduled visits per hour (every account on that
 * phone, from GET /api/tracked-accounts/capacity) plus the change being edited (`deltas`: visits/hour per phone id),
 * against the device pace. Over the limit it only warns: collection queues and runs later, saving is allowed.
 */
const props = defineProps<{ capacity: TrackedCapacity | null; deltas: Record<string, number> }>()
const { t } = useI18n()
const fmt = (n: number) => String(Math.round(n * 10) / 10)
const lines = computed(() => (props.capacity?.phones ?? [])
  .filter((p) => p.instanceId in props.deltas)
  .map((p) => {
    const load = Math.max(0, p.visitsPerHour + (props.deltas[p.instanceId] ?? 0))
    return { id: p.instanceId, name: p.name, load: fmt(load), max: p.capacityPerHour, over: load > p.capacityPerHour }
  }))
</script>

<template>
  <div v-for="l in lines" :key="l.id" class="cap small">
    <div class="muted">{{ t('collect.capacity', { name: l.name, n: l.load, max: l.max }) }}</div>
    <div v-if="l.over" class="over">{{ t('collect.capacityOver') }}</div>
  </div>
</template>

<style scoped>
.cap { margin-top: 4px; line-height: 1.5; }
.over { color: var(--cp-warning); }
</style>
