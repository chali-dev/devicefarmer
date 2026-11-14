<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'

/** One dashboard number with its label, linking to the filtered list page. */
defineProps<{ label: string; value: number | string; to?: RouteLocationRaw; tone?: 'error' | 'warning' | 'success' }>()
</script>

<template>
  <component :is="to ? 'router-link' : 'div'" :to="to" :class="['stat', { link: !!to }]">
    <div class="label">{{ label }}</div>
    <div :class="['value', tone && Number(value) > 0 ? tone : '']">{{ value }}</div>
  </component>
</template>

<style scoped>
.stat { display: block; padding: 6px 8px; border-radius: 6px; color: inherit; min-width: 0; }
.stat.link:hover { background: var(--cp-bg-hover); }
.label { color: var(--cp-text-tertiary); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.value { color: var(--cp-text); font-size: 22px; font-weight: 600; line-height: 1.3; font-variant-numeric: tabular-nums; }
.value.error { color: var(--cp-error); }
.value.warning { color: var(--cp-warning); }
.value.success { color: var(--cp-success); }
</style>
