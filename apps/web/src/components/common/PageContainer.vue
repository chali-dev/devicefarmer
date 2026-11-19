<script setup lang="ts">
import { computed } from 'vue'
import { useMenuLocation } from './menu'

/**
 * Page frame (Ant Design Pro PageContainer): title row (title from the menu by default, optional
 * subtitle, title suffix and right-side actions), then the content blocks stacked with the standard gap.
 * Put each block in an <a-card :bordered="false">; the breadcrumb lives in the app header. `title=""` without title / extra
 * slots drops the title row (a page whose header breadcrumb already names it, e.g. a media account's page).
 */
const props = defineProps<{ title?: string; subtitle?: string }>()
const loc = useMenuLocation()
const shownTitle = computed(() => props.title ?? loc.title.value)
</script>

<template>
  <div class="cp-page">
    <div v-if="shownTitle || $slots.title || $slots.extra" class="cp-page-head">
      <div class="cp-page-heading">
        <div class="cp-page-title-row">
          <h1 class="cp-page-title"><slot name="title">{{ shownTitle }}</slot></h1>
          <slot name="title-suffix" />
        </div>
        <div v-if="subtitle || $slots.subtitle" class="cp-page-subtitle"><slot name="subtitle">{{ subtitle }}</slot></div>
      </div>
      <div v-if="$slots.extra" class="cp-page-extra"><a-space wrap><slot name="extra" /></a-space></div>
    </div>
    <slot />
  </div>
</template>

<style scoped>
.cp-page { display: flex; flex-direction: column; gap: var(--cp-gap); min-width: 0; }
.cp-page-head { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; }
.cp-page-heading { min-width: 0; flex: 1 1 auto; }
.cp-page-title-row { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; min-height: 32px; }
.cp-page-title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; color: var(--cp-text); }
.cp-page-subtitle { margin-top: 2px; color: var(--cp-text-tertiary); font-size: 14px; }
.cp-page-extra { flex: none; max-width: 100%; }
</style>
