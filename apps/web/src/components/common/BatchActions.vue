<script setup lang="ts">
import { DownOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { confirmAction, confirmDanger } from './ui'

/**
 * 批量操作 dropdown for list pages: one button 「批量操作 (N)」 at the right of the table toolbar
 * (SearchBar #actions), disabled while nothing is selected. Items are the page's batch actions,
 * followed by 取消选择 (emits `clear`). An item with `confirm` asks first (danger items with the red
 * confirm); pages whose action needs its own dialog (form, result) leave `confirm` out and handle `select`.
 */
export interface BatchItem {
  key: string
  label: string
  danger?: boolean
  disabled?: boolean
  confirm?: { title: string; content?: string; okText?: string }
}

const props = defineProps<{ count: number; items: BatchItem[]; loading?: boolean }>()
const emit = defineEmits<{ select: [key: string]; clear: [] }>()
const { t } = useI18n()

const CLEAR = '__clear'
function onClick({ key }: { key: string | number }) {
  if (key === CLEAR) { emit('clear'); return }
  const item = props.items.find((i) => i.key === key)
  if (!item || item.disabled) return
  if (!item.confirm) { emit('select', item.key); return }
  const ask = item.danger ? confirmDanger : confirmAction
  ask({ ...item.confirm, onOk: () => emit('select', item.key) })
}
</script>

<template>
  <a-dropdown :disabled="!count" :trigger="['click']">
    <a-button :disabled="!count" :loading="loading" class="cp-batch-btn">
      <span class="cp-batch-label">{{ t('common.batchActions', { n: count }) }}</span> <DownOutlined />
    </a-button>
    <template #overlay>
      <a-menu @click="onClick">
        <a-menu-item v-for="it in items" :key="it.key" :danger="it.danger" :disabled="it.disabled">{{ it.label }}</a-menu-item>
        <a-menu-divider v-if="items.length" />
        <a-menu-item :key="CLEAR">{{ t('common.clearSelection') }}</a-menu-item>
      </a-menu>
    </template>
  </a-dropdown>
</template>

<style scoped>
.cp-batch-btn { max-width: 100%; display: inline-flex; align-items: center; }
.cp-batch-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
