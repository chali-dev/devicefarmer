<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { MODAL_WIDTH } from './ui'

/**
 * Small dialog for a 批量操作 menu item that needs a value first (category, persona, language, tags):
 * shows `note` (e.g. 「已选 N 个」) above the page's field (default slot); OK stays disabled until `ready`.
 * The page runs the action on `ok` and closes it by setting `open` to false.
 */
defineProps<{ title: string; note?: string; ready: boolean; busy?: boolean }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ ok: [] }>()
const { t } = useI18n()
</script>

<template>
  <a-modal
    v-model:open="open" :title="title" :width="MODAL_WIDTH.sm" :ok-text="t('common.ok')" :cancel-text="t('common.cancel')"
    :confirm-loading="busy" :ok-button-props="{ disabled: !ready }" @ok="emit('ok')"
  >
    <p v-if="note" class="muted">{{ note }}</p>
    <slot />
  </a-modal>
</template>
