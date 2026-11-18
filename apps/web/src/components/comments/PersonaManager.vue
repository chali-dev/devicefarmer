<script setup lang="ts">
import { ref } from 'vue'
import { RobotOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import type { ScopedItem } from '../../api/types'
import ScopedListManager from '../common/ScopedListManager.vue'
import PersonaDraftDrawer from './PersonaDraftDrawer.vue'

/** 人设管理 (shared by /scripts and /social): the scoped list manager plus 内容设定 (人设每日草稿, AI) per writable persona. */
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const draftPersona = ref<string | null>(null)
const manager = ref<InstanceType<typeof ScopedListManager> | null>(null)
function draftChanged() { void manager.value?.reload(); emit('changed') }
</script>

<template>
  <ScopedListManager ref="manager" v-model:open="open" path="/api/personas" list-key="personas" texts="scripts.personas" @changed="emit('changed')">
    <template #rowExtra="{ item }">
      <a-tag v-if="(item as ScopedItem).draftEnabled" color="purple" class="draft-tag">{{ t('scripts.personas.draftOn', { n: (item as ScopedItem).draftsPerDay ?? 0 }) }}</a-tag>
      <a-tooltip :title="t('scripts.personas.draftSettings')">
        <a-button type="text" size="small" :aria-label="t('scripts.personas.draftSettings')" @click="draftPersona = (item as ScopedItem).id"><RobotOutlined /></a-button>
      </a-tooltip>
    </template>
  </ScopedListManager>
  <PersonaDraftDrawer :persona-id="draftPersona" @close="draftPersona = null" @changed="draftChanged" />
</template>

<style scoped>
.draft-tag { margin-inline-end: 0; }
</style>
