<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import type { RiskDevice } from '../../api/types'
import { dateLocale } from '../../i18n'
import { confirmAction, TABLE_SIZE } from '../common/ui'
import PlatformTag from '../social/PlatformTag.vue'

/**
 * 风控 → 云手机状态: every phone the platform uses for automatic work (a platform's collector, the phone of an
 * account the automatic check covers) and every halted phone. A halted phone does nothing automatic until it
 * is resumed here (after someone has dealt with the challenge screen on it).
 */
const { t } = useI18n()
const devices = ref<RiskDevice[]>([])
const loading = ref(false)
const busy = ref<string | null>(null)
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')

async function load() {
  loading.value = true
  try { devices.value = (await api<{ devices: RiskDevice[] }>('GET', '/api/risk/devices')).devices } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
onMounted(load)

function resume(d: RiskDevice) {
  confirmAction({
    title: t('risk.devices.resumeConfirm', { name: d.name }),
    onOk: async () => {
      busy.value = d.id
      try { await api('POST', `/api/risk/devices/${d.id}/resume`); message.success(t('risk.devices.resumed')); await load() } catch (e) { message.error(errorText(e)) }
      finally { busy.value = null }
    },
  })
}

const columns = computed(() => [
  { title: t('risk.devices.colDevice'), key: 'device', width: 180 },
  { title: t('risk.devices.colUse'), key: 'use', width: 200 },
  { title: t('risk.devices.colState'), key: 'state', width: 280 },
  { title: t('risk.devices.colLastVisit'), key: 'last', width: 170 },
  { title: t('risk.devices.colHour'), key: 'hour', width: 110, align: 'right' as const },
  { title: '', key: 'ops', width: 100, fixed: 'right' as const },
])
</script>

<template>
  <a-typography-paragraph type="secondary">{{ t('risk.devices.hint') }}</a-typography-paragraph>
  <a-table :data-source="devices" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :pagination="false" :scroll="{ x: 1040 }"
    :locale="{ emptyText: t('risk.devices.empty') }">
    <template #bodyCell="{ column, record }">
      <template v-if="column.key === 'device'">
        <router-link :to="`/instances/${record.id}`">{{ record.name }}</router-link>
        <div><a-badge :status="record.online ? 'success' : 'default'" :text="record.online ? t('risk.devices.online') : t('risk.devices.offline')" /></div>
      </template>
      <template v-else-if="column.key === 'use'">
        <div v-for="p in record.collectorFor" :key="p"><PlatformTag :platform="p" /> <span class="small">{{ t('risk.devices.collector') }}</span></div>
        <div v-if="record.checkedAccounts" class="small">{{ t('risk.devices.accounts', { n: record.checkedAccounts }) }}</div>
      </template>
      <template v-else-if="column.key === 'state'">
        <template v-if="record.halted">
          <a-tag color="error">{{ t('risk.devices.halted') }}</a-tag>
          <div class="small">{{ codeText(record.halted.code, undefined, record.halted.code) }}</div>
          <div class="muted small">
            {{ fmt(record.halted.at) }} · {{ t(`risk.sources.${record.halted.source}`) }}
            <template v-if="record.halted.account"> · {{ record.halted.account.platform }} @{{ record.halted.account.handle }}</template>
          </div>
        </template>
        <a-tag v-else color="success">{{ t('risk.devices.normal') }}</a-tag>
      </template>
      <template v-else-if="column.key === 'last'">{{ fmt(record.lastVisitAt) }}</template>
      <template v-else-if="column.key === 'hour'">{{ record.visitsLastHour }}</template>
      <template v-else-if="column.key === 'ops'">
        <a-button v-if="record.halted" type="primary" size="small" :loading="busy === record.id" @click="resume(record as RiskDevice)">{{ t('risk.devices.resume') }}</a-button>
      </template>
    </template>
  </a-table>
  <div class="bar"><a-button size="small" :loading="loading" @click="load">{{ t('common.refresh') }}</a-button></div>
</template>

<style scoped>
.muted { color: var(--cp-text-tertiary); }
.small { font-size: 12px; }
.bar { margin-top: 12px; }
</style>
