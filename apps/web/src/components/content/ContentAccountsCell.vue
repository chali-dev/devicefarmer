<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { dateLocale } from '../../i18n'
import type { Content } from '../../api/types'
import StatusTag from '../common/StatusTag.vue'
import PlatformIcon from '../social/PlatformIcon.vue'

/**
 * 媒体号 cell of the content list: the accounts of the content's (visible) publish tasks, or, before it was distributed,
 * its 发布目标 (shown muted). At most `max` inline, the rest behind "+N"; the popover lists all with their publish status.
 */
const props = withDefaults(defineProps<{ content: Content; max?: number }>(), { max: 2 })
const { t } = useI18n()
const fromTasks = computed(() => props.content.publishAccounts.length > 0)
const rows = computed(() => (fromTasks.value
  ? props.content.publishAccounts.map((a) => ({ ...a, at: a.publishedAt ?? a.scheduledAt }))
  : props.content.targets.map((a) => ({ id: a.id, platform: a.platform, handle: a.handle, displayName: a.displayName, status: null, at: null }))))
const shown = computed(() => rows.value.slice(0, props.max))
const more = computed(() => rows.value.length - shown.value.length)
const fmt = (d: string) => new Date(d).toLocaleString(dateLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <span v-if="!rows.length" class="muted">—</span>
  <a-popover v-else :title="fromTasks ? t('content.accounts.tasks') : t('content.accounts.targets')" placement="bottomLeft">
    <template #content>
      <div class="acc-list">
        <div v-for="a in rows" :key="a.id" class="acc-row">
          <PlatformIcon :platform="a.platform" :size="16" />
          <span class="handle">@{{ a.handle }}</span>
          <span v-if="a.displayName" class="muted small ellipsis name">{{ a.displayName }}</span>
          <span class="spacer" />
          <span v-if="a.at" class="muted small nowrap">{{ fmt(a.at) }}</span>
          <StatusTag v-if="a.status" kind="publish" :status="a.status" class="st" />
        </div>
      </div>
    </template>
    <div class="cell" :class="{ targets: !fromTasks }" tabindex="0">
      <span v-for="a in shown" :key="a.id" class="chip">
        <PlatformIcon :platform="a.platform" :size="16" />
        <span class="ellipsis">@{{ a.handle }}</span>
      </span>
      <a-tag v-if="more > 0" class="more">+{{ more }}</a-tag>
    </div>
  </a-popover>
</template>

<style scoped>
.cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; cursor: default; }
.cell.targets { color: var(--cp-text-secondary); }
.chip { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
.chip .ellipsis { min-width: 0; }
.more { align-self: flex-start; margin: 0; font-size: 11px; line-height: 16px; padding-inline: 5px; }
.acc-list { display: flex; flex-direction: column; gap: 6px; max-width: min(420px, 80vw); max-height: 320px; overflow: auto; }
.acc-row { display: flex; align-items: center; gap: 6px; }
.acc-row .handle { white-space: nowrap; }
.acc-row .name { max-width: 120px; }
.acc-row .spacer { flex: 1; }
.acc-row .st { margin: 0; }
</style>
