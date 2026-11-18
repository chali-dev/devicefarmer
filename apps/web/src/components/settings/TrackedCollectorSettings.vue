<script setup lang="ts">
import { dateLocale } from '../../i18n'
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import PlatformTag from '../social/PlatformTag.vue'

/**
 * Settings → Tracked accounts (admin): the collector device per platform (Instagram). Its app is read for
 * tracked accounts (navigation + screen reads only). A challenge screen pauses collection until resumed here.
 */
const { t } = useI18n()
interface Collector {
  platform: string; instanceId: string | null
  device: { id: string; name: string; status: string; adbState: string | null; external: boolean } | null
  halted: { at: string; code: string | null } | null
  visitsLastHour: number; lastVisitAt: string | null
}
interface State { collectors: Collector[]; pace: { minIntervalSec: number; maxPerHour: number; busyRetrySec: number }; updatedAt: string | null }
const state = ref<State | null>(null)
const devices = ref<{ id: string; name: string; status: string }[]>([])
const saving = ref(false)

async function load() {
  try {
    const [s, d] = await Promise.all([
      api<State>('GET', '/api/settings/tracked-collectors'),
      api<{ instances: { id: string; name: string; status: string }[] }>('GET', '/api/instances'),
    ])
    state.value = s
    devices.value = d.instances
  } catch (e) { message.error(errorText(e)) }
}
onMounted(load)
const options = computed(() => devices.value.map((d) => ({ value: d.id, label: `${d.name} (${d.status})` })))
const online = (c: Collector) => c.device?.status === 'running' && c.device.adbState === 'device'
const when = (s: string) => new Date(s).toLocaleString(dateLocale())

async function save(c: Collector, body: { instanceId?: string | null; resume?: boolean }) {
  saving.value = true
  try {
    state.value = await api<State>('PUT', `/api/settings/tracked-collectors/${c.platform}`, body)
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="!state">
      <a-typography-title :level="5">{{ t('tracked.collector.title') }}</a-typography-title>
      <a-typography-paragraph type="secondary">{{ t('tracked.collector.hint') }}</a-typography-paragraph>
      <a-typography-paragraph v-if="state" type="secondary" class="small">
        {{ t('tracked.collector.pace', { sec: state.pace.minIntervalSec, max: state.pace.maxPerHour, busy: state.pace.busyRetrySec }) }}
      </a-typography-paragraph>
      <a-form v-for="c in state?.collectors ?? []" :key="c.platform" layout="vertical" class="block">
        <a-form-item>
          <template #label><PlatformTag :platform="c.platform" /></template>
          <a-select :value="c.instanceId ?? undefined" :options="options" :placeholder="t('tracked.collector.pick')" allow-clear show-search
            option-filter-prop="label" style="max-width: 360px; width: 100%" :disabled="saving"
            @change="(v: any) => save(c, { instanceId: (v as string | undefined) ?? null })" />
        </a-form-item>
        <a-form-item :label="t('tracked.collector.state')">
          <a-space wrap>
            <a-tag v-if="!c.device">{{ t('tracked.collector.none') }}</a-tag>
            <a-tag v-else-if="c.halted" color="error">{{ t('tracked.collector.halted', { time: when(c.halted.at) }) }}</a-tag>
            <a-tag v-else-if="online(c)" color="success">{{ t('tracked.collector.ready') }}</a-tag>
            <a-tag v-else color="warning">{{ t('tracked.collector.offline') }}</a-tag>
            <span v-if="c.device" class="muted small">{{ t('tracked.collector.visits', { n: c.visitsLastHour }) }}</span>
            <span v-if="c.lastVisitAt" class="muted small">{{ t('tracked.collector.lastVisit', { time: when(c.lastVisitAt) }) }}</span>
          </a-space>
        </a-form-item>
        <template v-if="c.halted">
          <a-alert type="error" show-icon :message="codeText(c.halted.code, undefined, c.halted.code ?? '')" :description="t('tracked.collector.haltedHint')" class="block" />
          <a-button type="primary" :loading="saving" @click="save(c, { resume: true })">{{ t('tracked.collector.resume') }}</a-button>
        </template>
      </a-form>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 640px; }
.block { margin-bottom: 12px; }
</style>
