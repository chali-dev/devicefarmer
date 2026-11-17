<script setup lang="ts">
import { computed } from 'vue'
import { statusBadge, statusColor, statusLabel, type StatusKind } from './status'

/**
 * The one way to show a status. `kind` picks the family (colours + labels live in ./status.ts).
 * Default look is a tag (tables, details); `badge` shows a dot + text (dense lists, device cards).
 * Device status (the default kind) keeps its badge look.
 */
const props = withDefaults(defineProps<{ status: string; kind?: StatusKind; badge?: boolean }>(), { kind: 'instance', badge: undefined })
const asBadge = computed(() => props.badge ?? props.kind === 'instance')
const text = computed(() => statusLabel(props.kind, props.status))
</script>

<template>
  <a-badge v-if="asBadge" :status="statusBadge(kind, status)" :text="text" />
  <a-tag v-else :color="statusColor(kind, status)">{{ text }}<slot /></a-tag>
</template>
