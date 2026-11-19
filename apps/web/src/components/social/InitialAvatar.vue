<script setup lang="ts">
import { computed } from 'vue'

/** Initial circle for an account (no avatar images are stored): first letter of the name, else of the handle. */
const props = withDefaults(defineProps<{ name?: string | null; handle: string; size?: number }>(), { size: 24 })
const letter = computed(() => (props.name?.trim() || props.handle.replace(/^@/, '')).slice(0, 1).toUpperCase())
</script>

<template>
  <span class="avatar" aria-hidden="true" :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size / 2)}px` }">{{ letter }}</span>
</template>

<style scoped>
.avatar { border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-weight: 600; background: var(--cp-primary-bg); color: var(--cp-primary); flex: none; }
</style>
