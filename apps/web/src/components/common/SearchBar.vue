<script setup lang="ts">
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'

/**
 * Table toolbar: filters on the left (default slot), then 查询 / 重置 / 刷新 when the page listens for
 * them, then right-aligned actions (#actions: batch buttons, counters). Wraps on narrow screens.
 * Filters that apply on change need no 查询 button: just don't listen to `search`.
 */
defineProps<{
  loading?: boolean
  onSearch?: () => void
  onReset?: () => void
  onRefresh?: () => void
}>()
const { t } = useI18n()
</script>

<template>
  <div class="cp-search-bar">
    <slot />
    <a-button v-if="onSearch" type="primary" @click="onSearch"><template #icon><SearchOutlined /></template>{{ t('common.search') }}</a-button>
    <a-button v-if="onReset" @click="onReset">{{ t('common.reset') }}</a-button>
    <a-tooltip v-if="onRefresh" :title="t('common.refresh')">
      <a-button :loading="loading" :aria-label="t('common.refresh')" @click="onRefresh"><template #icon><ReloadOutlined /></template></a-button>
    </a-tooltip>
    <div v-if="$slots.actions" class="cp-search-actions"><slot name="actions" /></div>
  </div>
</template>

<style scoped>
.cp-search-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: var(--cp-gap); }
.cp-search-bar > :deep(*) { max-width: 100%; }
.cp-search-actions { margin-inline-start: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
</style>
