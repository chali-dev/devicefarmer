<script setup lang="ts">
import { DownOutlined } from '@ant-design/icons-vue'

/**
 * The V toggle that folds replies / comments under their parent (评论互动 threads, the account feed's comments
 * under a post). The chevron turns when open; badges go in the default slot.
 */
defineProps<{ open: boolean; label: string }>()
const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <button type="button" class="fold-toggle" :aria-expanded="open" @click="emit('toggle')">
    <DownOutlined class="chev" :class="{ open }" />
    <span>{{ label }}</span>
    <slot />
  </button>
</template>

<style scoped>
.fold-toggle {
  display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; max-width: 100%; margin-top: 2px; padding: 2px 6px;
  border: 0; border-radius: var(--cp-radius); background: transparent; color: var(--cp-primary); font: inherit; font-size: 12px;
  text-align: start; cursor: pointer;
}
.fold-toggle:hover { background: var(--cp-bg-hover); }
.fold-toggle:focus-visible { outline: 2px solid var(--cp-primary); outline-offset: 1px; }
.chev { transition: transform 0.2s; }
.chev.open { transform: rotate(180deg); }
.fold-toggle :deep(.ant-tag) { margin: 0; }
</style>
