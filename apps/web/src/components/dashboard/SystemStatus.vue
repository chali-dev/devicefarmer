<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ReloadOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { SystemInfo } from '../../api/types'

/**
 * Dashboard → 系统状态 (admin only, read-only; moved here from the settings page): dependency health (real
 * checks shared with /api/health), versions, host capacity, STF. Loads GET /api/settings/system on its own
 * (on mount + its refresh button), so the heavier health checks never slow down or join the dashboard's
 * 30 s polling. Since the dashboard simplification (2026-11-19) it is one line (health, free memory, STF, uptime);
 * 详情 unfolds the full tables.
 */
const { t } = useI18n()
const info = ref<SystemInfo | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
async function load() {
  loading.value = true
  error.value = null
  try { info.value = await api<SystemInfo>('GET', '/api/settings/system') } catch (e) { error.value = errorText(e) }
  finally { loading.value = false }
}
onMounted(load)
const expanded = ref(false)
const failing = computed(() => Object.entries(info.value?.health.checks ?? {}).filter(([, v]) => v !== 'ok').map(([k]) => k))
const uptime = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`)
</script>

<template>
  <a-card size="small" :bordered="false" class="sys">
    <div class="line">
      <span class="label">{{ t('dashboard.system.title') }}</span>
      <a-alert v-if="error" type="error" :message="error" banner />
      <template v-if="info">
        <a-tooltip :title="failing.join(', ') || undefined">
          <a-tag :color="info.health.ok ? 'success' : 'error'">{{ info.health.ok ? t('dashboard.system.allOk') : t('dashboard.system.degradedList', { list: failing.join(', ') }) }}</a-tag>
        </a-tooltip>
        <span class="muted small">{{ t('dashboard.system.freeMem') }} {{ info.capacity.freeMb ?? '—' }} MiB</span>
        <span class="muted small">STF <a-badge :status="info.stf.reachable ? 'success' : 'error'" /></span>
        <span class="muted small">{{ t('dashboard.system.uptime', { v: uptime(info.uptimeSec) }) }} · {{ info.env }}</span>
      </template>
      <span class="grow" />
      <a-button size="small" type="link" @click="expanded = !expanded">{{ expanded ? t('dashboard.system.less') : t('dashboard.system.more') }}</a-button>
      <a-button size="small" :loading="loading" @click="load"><template #icon><ReloadOutlined /></template></a-button>
    </div>
    <a-spin v-if="expanded" :spinning="loading && !info">
      <a-row v-if="info" :gutter="[16, 16]" class="detail">
        <a-col :xs="24" :lg="12">
          <a-card size="small" type="inner" :title="t('dashboard.system.health')">
            <template #extra>
              <a-tag :color="info.health.ok ? 'success' : 'error'">{{ info.health.ok ? t('dashboard.system.allOk') : t('dashboard.system.degraded') }}</a-tag>
            </template>
            <a-descriptions size="small" :column="1">
              <a-descriptions-item v-for="(v, k) in info.health.checks" :key="k" :label="k">
                <a-badge :status="v === 'ok' ? 'success' : 'error'" :text="v === 'ok' ? 'OK' : v" />
              </a-descriptions-item>
              <a-descriptions-item label="KVM">{{ info.health.capabilities.kvm ? t('common.yes') : t('common.no') }}</a-descriptions-item>
            </a-descriptions>
          </a-card>
        </a-col>
        <a-col :xs="24" :lg="12">
          <a-card size="small" type="inner" :title="t('dashboard.system.versions')">
            <a-descriptions size="small" :column="1">
              <a-descriptions-item label="Node.js">{{ info.versions.node }}</a-descriptions-item>
              <a-descriptions-item label="PostgreSQL">{{ info.versions.postgres ?? '—' }}</a-descriptions-item>
              <a-descriptions-item label="Redis">{{ info.versions.redis ?? '—' }}</a-descriptions-item>
              <a-descriptions-item :label="t('dashboard.system.dockerHost')">
                <template v-if="info.versions.docker">{{ info.versions.docker.version }} · {{ info.versions.docker.os }}/{{ info.versions.docker.arch }} · {{ info.versions.docker.kernel ?? '' }}</template>
                <template v-else>—</template>
              </a-descriptions-item>
            </a-descriptions>
          </a-card>
        </a-col>
        <a-col :xs="24" :lg="12">
          <a-card size="small" type="inner" :title="t('dashboard.system.capacity')">
            <a-alert v-if="info.capacity.error" type="warning" show-icon :message="info.capacity.error" />
            <a-descriptions v-else size="small" :column="1">
              <a-descriptions-item :label="t('dashboard.system.freeMem')">{{ info.capacity.freeMb }} MiB</a-descriptions-item>
              <a-descriptions-item v-for="f in info.capacity.fits" :key="f.profile" :label="f.profile">
                {{ t('dashboard.system.fits', { n: f.count, mb: f.memEstimateMb }) }}
              </a-descriptions-item>
            </a-descriptions>
          </a-card>
        </a-col>
        <a-col :xs="24" :lg="12">
          <a-card size="small" type="inner" title="STF">
            <a-descriptions size="small" :column="1">
              <a-descriptions-item :label="t('dashboard.system.reachable')">
                <a-badge :status="info.stf.reachable ? 'success' : 'error'" :text="info.stf.reachable ? t('common.yes') : t('common.no')" />
              </a-descriptions-item>
              <a-descriptions-item :label="t('dashboard.system.stfDevices')">{{ info.stf.devices }}</a-descriptions-item>
              <a-descriptions-item :label="t('dashboard.system.stfPresent')">{{ info.stf.present }}</a-descriptions-item>
              <a-descriptions-item :label="t('dashboard.system.stfReady')">{{ info.stf.ready }}</a-descriptions-item>
            </a-descriptions>
          </a-card>
        </a-col>
      </a-row>
    </a-spin>
  </a-card>
</template>

<style scoped>
.line { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
.label { font-weight: 600; }
.grow { flex: 1; }
.detail { margin-top: 12px; }
</style>
