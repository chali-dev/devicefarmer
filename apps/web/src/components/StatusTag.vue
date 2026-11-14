<script setup lang="ts">
import { computed } from 'vue'
import type { InstanceStatus } from '../api/types'

const props = defineProps<{ status: InstanceStatus }>()
const MAP: Record<InstanceStatus, { color: string; text: string; busy?: boolean }> = {
  creating: { color: 'processing', text: '创建中', busy: true },
  starting: { color: 'processing', text: '启动中', busy: true },
  running: { color: 'success', text: '运行中' },
  stopping: { color: 'processing', text: '停止中', busy: true },
  stopped: { color: 'default', text: '已停止' },
  restarting: { color: 'processing', text: '重启中', busy: true },
  deleting: { color: 'warning', text: '删除中', busy: true },
  error: { color: 'error', text: '异常' },
}
const m = computed(() => MAP[props.status])
</script>

<template>
  <a-badge :status="m.color as any" :text="m.text" />
</template>
