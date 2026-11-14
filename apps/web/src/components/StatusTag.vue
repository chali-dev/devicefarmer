<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { InstanceStatus } from '../api/types'

const props = defineProps<{ status: InstanceStatus }>()
const { t } = useI18n()
const COLOR: Record<InstanceStatus, string> = {
  creating: 'processing',
  starting: 'processing',
  running: 'success',
  stopping: 'processing',
  stopped: 'default',
  restarting: 'processing',
  deleting: 'warning',
  error: 'error',
}
const color = computed(() => COLOR[props.status])
const text = computed(() => t(`status.${props.status}`))
</script>

<template>
  <a-badge :status="color as any" :text="text" />
</template>
