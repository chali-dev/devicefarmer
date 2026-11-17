<script setup lang="ts">
import { computed } from 'vue'
import { platformBrand, platformName } from './platformMeta'

/**
 * Colourful round brand icon of a platform (registry: platformMeta.ts). Decorative next to a visible name;
 * pass `labelled` when it stands alone (role="img" + aria-label; PlatformTag `iconOnly` adds the tooltip).
 */
const props = withDefaults(defineProps<{ platform: string; size?: number; labelled?: boolean }>(), { size: 18 })
const brand = computed(() => platformBrand(props.platform))
const name = computed(() => platformName(props.platform))
const transform = (l: { scale?: number; dx?: number; dy?: number }) =>
  `translate(${12 + (l.dx ?? 0)} ${12 + (l.dy ?? 0)}) scale(${l.scale ?? 1}) translate(-12 -12)`
</script>

<template>
  <span
    class="platform-icon" :class="[brand?.shape ?? 'circle', { ring: brand?.ring, unknown: !brand }]"
    :style="{ width: `${size}px`, height: `${size}px`, background: brand?.bg, fontSize: `${Math.round(size * 0.6)}px` }"
    :role="labelled ? 'img' : undefined" :aria-label="labelled ? name : undefined" :aria-hidden="labelled ? undefined : 'true'"
  >
    <svg v-if="brand" viewBox="0 0 24 24" width="100%" height="100%" focusable="false">
      <path v-for="(l, i) in brand.layers" :key="i" :d="l.d" :fill="l.fill" :transform="transform(l)" />
    </svg>
    <template v-else>{{ name.charAt(0).toUpperCase() }}</template>
  </span>
</template>

<style scoped>
.platform-icon {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  vertical-align: -0.2em; overflow: hidden; line-height: 1; font-weight: 600;
}
.platform-icon.circle { border-radius: 50%; }
.platform-icon.square { border-radius: 28%; }
.platform-icon.ring { box-shadow: 0 0 0 1px var(--cp-border); }
.platform-icon.unknown { background: var(--cp-text-tertiary); color: var(--cp-bg-container); }
</style>
