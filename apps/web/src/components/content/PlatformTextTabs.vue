<script setup lang="ts">
import { platformIcon, platformName } from '../social/platformMeta'

/**
 * One text box per tab (平台文案): a tab per platform (or per target account), each with that platform's limit.
 * The default slot renders a tab's other fields (e.g. YouTube title / privacy) below its text box; `extra` goes
 * to the right of the tab bar (e.g. 插入话术, which inserts into the active tab).
 */
export interface TextTab {
  key: string
  /** Platform for the icon and the default label; null = plain text without a platform. */
  platform: string | null
  label?: string
  max: number
  placeholder?: string
  /** false: the tab has no text (e.g. Instagram stories); only the slot is shown. */
  text?: boolean
}
defineProps<{ tabs: TextTab[]; values: Record<string, string>; rows?: number }>()
const active = defineModel<string>('active', { required: true })
</script>

<template>
  <a-tabs v-model:active-key="active" size="small" class="text-tabs">
    <a-tab-pane v-for="tb in tabs" :key="tb.key">
      <template #tab>
        <span class="tab-label"><component :is="platformIcon(tb.platform ?? '')" v-if="tb.platform" />{{ tb.label ?? platformName(tb.platform ?? '') }}</span>
      </template>
      <a-textarea v-if="tb.text !== false" v-model:value="values[tb.key]" :rows="rows ?? 6" :maxlength="tb.max" show-count :placeholder="tb.placeholder" />
      <slot :tab="tb" />
    </a-tab-pane>
    <template v-if="$slots.extra" #rightExtra><slot name="extra" /></template>
  </a-tabs>
</template>

<style scoped>
.text-tabs :deep(.ant-tabs-nav) { margin-bottom: 8px; }
.tab-label { display: inline-flex; align-items: center; gap: 6px; }
</style>
