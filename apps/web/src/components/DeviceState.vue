<script setup lang="ts">
import { computed, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../api/client'
import type { DeviceAutomation, Instance } from '../api/types'
import { dateLocale } from '../i18n'
import { confirmDanger } from './common/ui'
import { INSTANCE_STATUS_COLOR } from './common/status'

/**
 * The ONE status of a device on 云机管理 (owner decision 2026-11-18, moved from the 风控 page and simplified), by
 * priority: 风控暂停 (red; tooltip: reason + time; admins get 恢复) > not running (the lifecycle status: stopped grey,
 * starting/stopping blue, error red with the last error) > 离线 (running but adb doesn't see it, grey) > 忙 (an
 * automatic operation holds the device: collect / check / feed / reply / publish, blue) > 正常 (green). System / ADB /
 * STF readiness is in the tooltip instead of separate tags. A stopped external phone (BitBrowser) of a non-admin says
 * 「未开机，请联系管理员」: only admins power those (billed).
 */
const props = defineProps<{ instance: Instance; automation?: DeviceAutomation | null; resumable?: boolean; admin?: boolean }>()
const emit = defineEmits<{ resumed: [] }>()
const { t } = useI18n()
const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')

const state = computed(() => {
  const i = props.instance
  const a = props.automation
  const ready = [
    `${t('devices.sys')} ${i.bootCompleted ? '✓' : '✗'}`, `ADB ${i.adbState === 'device' ? '✓' : '✗'}`, `STF ${i.stfReady ? '✓' : '✗'}`,
  ].join(' · ')
  if (a?.halted) {
    return { key: 'halted', badge: 'error' as const, label: t('devices.state.halted'),
      tip: t('devices.state.haltedTip', { reason: codeText(a.halted.code, undefined, a.halted.code), source: t(`risk.sources.${a.halted.source}`), time: fmt(a.halted.at) }) }
  }
  if (i.status !== 'running') {
    if (i.sourceId && !props.admin && (i.status === 'stopped' || i.status === 'error')) {
      return { key: i.status, badge: 'default' as const, label: t('devices.state.askAdmin'), tip: i.lastError ?? null }
    }
    const color = INSTANCE_STATUS_COLOR[i.status] ?? 'default'
    return { key: i.status, badge: color as 'success' | 'processing' | 'default' | 'error' | 'warning', label: t(`status.${i.status}`), tip: i.lastError ?? null }
  }
  if (i.adbState !== 'device') return { key: 'offline', badge: 'default' as const, label: t('devices.state.offline'), tip: i.lastError ?? ready }
  if (a?.busy) {
    return { key: 'busy', badge: 'processing' as const, label: t('devices.state.busy'),
      tip: t('devices.state.busyTip', { what: t(`devices.state.ops.${a.busy.what}`), time: fmt(a.busy.since) }) }
  }
  return { key: 'ok', badge: 'success' as const, label: t('devices.state.ok'), tip: ready }
})

const busy = ref(false)
function resume() {
  confirmDanger({
    title: t('devices.state.resumeConfirm', { name: props.instance.name }), okText: t('devices.state.resume'),
    onOk: async () => {
      busy.value = true
      try { await api('POST', `/api/risk/devices/${props.instance.id}/resume`); message.success(t('devices.state.resumed')); emit('resumed') }
      catch (e) { message.error(errorText(e)) } finally { busy.value = false }
    },
  })
}
</script>

<template>
  <span class="ds">
    <a-tooltip :title="state.tip ?? undefined">
      <a-badge :status="state.badge" :text="state.label" />
    </a-tooltip>
    <a-button v-if="resumable && state.key === 'halted'" size="small" type="primary" danger :loading="busy" @click.stop="resume">{{ t('devices.state.resume') }}</a-button>
  </span>
</template>

<style scoped>
.ds { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
</style>
