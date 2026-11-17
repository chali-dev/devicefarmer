<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ReloadOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { SystemInfo } from '../../api/types'

/** Settings → System (admin, read-only): dependency health (real checks), versions, host capacity, STF. */
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
const uptime = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`)
</script>

<template>
  <div>
    <div class="toolbar"><a-space wrap>
      <a-button :loading="loading" @click="load"><template #icon><ReloadOutlined /></template>{{ t('common.refresh') }}</a-button>
      <span v-if="info" class="muted small">{{ t('settings.system.uptime', { v: uptime(info.uptimeSec) }) }} · {{ info.env }}</span>
    </a-space></div>
    <a-alert v-if="error" type="error" show-icon :message="error" class="toolbar" />
    <a-spin :spinning="loading && !info">
      <a-row v-if="info" :gutter="[16, 16]">
        <a-col :xs="24" :lg="12">
          <a-card size="small" :title="t('settings.system.health')">
            <template #extra>
              <a-tag :color="info.health.ok ? 'success' : 'error'">{{ info.health.ok ? t('settings.system.allOk') : t('settings.system.degraded') }}</a-tag>
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
          <a-card size="small" :title="t('settings.system.versions')">
            <a-descriptions size="small" :column="1">
              <a-descriptions-item label="Node.js">{{ info.versions.node }}</a-descriptions-item>
              <a-descriptions-item label="PostgreSQL">{{ info.versions.postgres ?? '—' }}</a-descriptions-item>
              <a-descriptions-item label="Redis">{{ info.versions.redis ?? '—' }}</a-descriptions-item>
              <a-descriptions-item :label="t('settings.system.dockerHost')">
                <template v-if="info.versions.docker">{{ info.versions.docker.version }} · {{ info.versions.docker.os }}/{{ info.versions.docker.arch }} · {{ info.versions.docker.kernel ?? '' }}</template>
                <template v-else>—</template>
              </a-descriptions-item>
            </a-descriptions>
          </a-card>
        </a-col>
        <a-col :xs="24" :lg="12">
          <a-card size="small" :title="t('settings.system.capacity')">
            <a-alert v-if="info.capacity.error" type="warning" show-icon :message="info.capacity.error" />
            <a-descriptions v-else size="small" :column="1">
              <a-descriptions-item :label="t('settings.system.freeMem')">{{ info.capacity.freeMb }} MiB</a-descriptions-item>
              <a-descriptions-item v-for="f in info.capacity.fits" :key="f.profile" :label="f.profile">
                {{ t('settings.system.fits', { n: f.count, mb: f.memEstimateMb }) }}
              </a-descriptions-item>
            </a-descriptions>
          </a-card>
        </a-col>
        <a-col :xs="24" :lg="12">
          <a-card size="small" title="STF">
            <a-descriptions size="small" :column="1">
              <a-descriptions-item :label="t('settings.system.reachable')">
                <a-badge :status="info.stf.reachable ? 'success' : 'error'" :text="info.stf.reachable ? t('common.yes') : t('common.no')" />
              </a-descriptions-item>
              <a-descriptions-item :label="t('settings.system.stfDevices')">{{ info.stf.devices }}</a-descriptions-item>
              <a-descriptions-item :label="t('settings.system.stfPresent')">{{ info.stf.present }}</a-descriptions-item>
              <a-descriptions-item :label="t('settings.system.stfReady')">{{ info.stf.ready }}</a-descriptions-item>
            </a-descriptions>
          </a-card>
        </a-col>
      </a-row>
    </a-spin>
  </div>
</template>

<style scoped>
.toolbar { margin-bottom: var(--cp-gap); }
</style>
