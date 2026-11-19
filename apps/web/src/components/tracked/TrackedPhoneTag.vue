<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TrackedPhone } from '../../api/types'

/**
 * 采集手机 of a tracked account: the phone's name (link to its card on 云机管理) and one state tag — 风控暂停 >
 * 不可用 (no longer the owner's phone) > 离线 > 在线; none set → 「未设置」 (warning). Tooltip = what to do.
 */
const props = defineProps<{ phone: TrackedPhone | null }>()
const { t } = useI18n()
const state = computed(() => {
  const p = props.phone
  if (!p) return { color: 'warning', label: t('tracked.phone.none'), tip: t('tracked.phone.noneHint') }
  if (p.halted) return { color: 'error', label: t('tracked.phone.halted'), tip: t('tracked.phone.haltedHint') }
  if (!p.allowed) return { color: 'warning', label: t('tracked.phone.notAllowed'), tip: t('tracked.phone.notAllowedHint') }
  return p.online ? { color: 'success', label: t('tracked.phone.online'), tip: '' } : { color: 'default', label: t('tracked.phone.offline'), tip: '' }
})
</script>

<template>
  <a-tooltip :title="state.tip || undefined">
    <span class="phone">
      <router-link v-if="phone" :to="{ path: '/instances', query: { id: phone.id } }" class="ellipsis name">{{ phone.name }}</router-link>
      <a-tag :color="state.color" class="tag">{{ state.label }}</a-tag>
    </span>
  </a-tooltip>
</template>

<style scoped>
.phone { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0; }
.name { min-width: 0; }
.tag { margin-inline-end: 0; }
</style>
