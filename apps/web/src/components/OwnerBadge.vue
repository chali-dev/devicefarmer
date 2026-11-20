<script setup lang="ts">
import { UserOutlined } from '@ant-design/icons-vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { InstanceOwner } from '../api/types'

/**
 * 分配用户 badge (admin, 我的云机 cards + table): the phone's user as a primary tag with a user icon (click = filter
 * the list by that user), or a muted 「未分配」 tag. Older data may have several users on one phone: the first is
 * shown with "+N" (tooltip lists everyone) and a warning colour, since a phone belongs to one user now.
 */
const props = defineProps<{ owners: InstanceOwner[]; label: (o: InstanceOwner) => string }>()
const emit = defineEmits<{ filter: [InstanceOwner] }>()
const { t } = useI18n()
const first = computed(() => props.owners[0])
const tip = computed(() => props.owners.map(props.label).join(t('common.listSep')))
</script>

<template>
  <a-tag v-if="!first" class="owner-badge none">
    <template #icon><UserOutlined /></template>{{ t('devices.unassigned') }}
  </a-tag>
  <a-tooltip v-else :title="tip">
    <a-tag class="owner-badge" :class="{ multi: owners.length > 1 }" @click="emit('filter', first)">
      <template #icon><UserOutlined /></template>
      <span class="name">{{ first.displayName || first.username }}</span><span v-if="owners.length > 1" class="more">+{{ owners.length - 1 }}</span>
    </a-tag>
  </a-tooltip>
</template>

<style scoped>
.owner-badge {
  display: inline-flex; align-items: center; gap: 2px; max-width: 100%; margin: 0; cursor: pointer;
  color: var(--cp-primary); background: var(--cp-primary-bg); border-color: var(--cp-primary);
  font-weight: 500;
}
.owner-badge .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.owner-badge .more { margin-inline-start: 4px; flex: none; }
.owner-badge.multi { color: var(--cp-warning); background: var(--cp-fill-alter); border-color: var(--cp-warning); }
.owner-badge.none { cursor: default; color: var(--cp-text-tertiary); background: var(--cp-fill-alter); border-style: dashed; border-color: var(--cp-border); font-weight: normal; }
</style>
