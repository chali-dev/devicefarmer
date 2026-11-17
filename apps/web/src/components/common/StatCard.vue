<script setup lang="ts">
import type { Component } from 'vue'
import type { RouteLocationRaw } from 'vue-router'

/**
 * KPI card (dashboard / page summaries): title, big value (+ optional suffix), optional icon and
 * a footer line (#footer slot or `footer`). With `to` the whole card links to the filtered list.
 * `tone` colours the value when it is non-zero (e.g. errors).
 */
defineProps<{
  title: string
  value: number | string
  suffix?: string
  icon?: Component
  footer?: string
  to?: RouteLocationRaw
  tone?: 'error' | 'warning' | 'success'
  loading?: boolean
}>()
</script>

<template>
  <component :is="to ? 'router-link' : 'div'" :to="to" class="cp-stat-card-link">
    <a-card :bordered="false" :hoverable="!!to" :loading="loading" class="cp-stat-card">
      <div class="head">
        <span class="title">{{ title }}</span>
        <span v-if="icon" class="icon"><component :is="icon" /></span>
      </div>
      <div :class="['value', tone && Number(value) > 0 ? tone : '']">
        {{ value }}<span v-if="suffix" class="suffix">{{ suffix }}</span>
      </div>
      <div v-if="footer || $slots.footer" class="foot"><slot name="footer">{{ footer }}</slot></div>
    </a-card>
  </component>
</template>

<style scoped>
.cp-stat-card-link { display: block; color: inherit; height: 100%; }
.cp-stat-card { height: 100%; }
.cp-stat-card :deep(.ant-card-body) { padding: 20px 24px 16px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--cp-text-tertiary); font-size: 14px; }
.title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon {
  flex: none; width: 32px; height: 32px; border-radius: var(--cp-radius); display: inline-flex; align-items: center; justify-content: center;
  background: var(--cp-primary-bg); color: var(--cp-primary); font-size: 16px;
}
.value { margin-top: 4px; font-size: 30px; line-height: 38px; font-weight: 600; color: var(--cp-text); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.value.error { color: var(--cp-error); }
.value.warning { color: var(--cp-warning); }
.value.success { color: var(--cp-success); }
.suffix { margin-inline-start: 4px; font-size: 14px; font-weight: 400; color: var(--cp-text-tertiary); }
.foot { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--cp-border-secondary); color: var(--cp-text-secondary); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@media (max-width: 640px) {
  .cp-stat-card :deep(.ant-card-body) { padding: 12px 16px; }
  .value { font-size: 24px; line-height: 32px; }
}
</style>
