<script setup lang="ts">
import { computed } from 'vue'
import { platformIcon, platformName } from './platformMeta'

/** Platform badge. Unknown (newly registered) platforms fall back to a generic icon and the raw id. */
const props = defineProps<{ platform: string; name?: string }>()
const icon = computed(() => platformIcon(props.platform))
</script>

<template>
  <a-tag class="platform-tag">
    <component :is="icon" />
    <span>{{ name ?? platformName(platform) }}</span>
  </a-tag>
</template>

<style scoped>
.platform-tag { display: inline-flex; align-items: center; gap: 4px; margin-inline-end: 0; }
</style>
