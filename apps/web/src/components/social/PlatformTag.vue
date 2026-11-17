<script setup lang="ts">
import PlatformIcon from './PlatformIcon.vue'
import { platformName } from './platformMeta'

/**
 * Platform label: coloured brand icon + name (no tag border). `iconOnly` for tight spots: the icon alone with a
 * tooltip and an accessible name. Unknown (newly registered) platforms get a neutral icon and the raw id.
 */
withDefaults(defineProps<{ platform: string; name?: string; iconOnly?: boolean; size?: number }>(), { size: 18 })
</script>

<template>
  <a-tooltip v-if="iconOnly" :title="name ?? platformName(platform)">
    <PlatformIcon :platform="platform" :size="size" labelled />
  </a-tooltip>
  <span v-else class="platform-tag">
    <PlatformIcon :platform="platform" :size="size" />
    <span>{{ name ?? platformName(platform) }}</span>
  </span>
</template>

<style scoped>
.platform-tag { display: inline-flex; align-items: center; gap: 6px; vertical-align: middle; white-space: nowrap; }
</style>
