<script setup lang="ts">
import { message } from 'ant-design-vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { PlatformConnection, PlatformInfo } from '../../api/types'
import StatusTag from '../common/StatusTag.vue'
import { confirmDanger } from '../common/ui'

/** Official-API authorisation of one social account: status badge + connect / disconnect / API check. */
const props = defineProps<{ accountId: string; label: string; platform?: PlatformInfo; connection?: PlatformConnection }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const busy = ref(false)

const status = computed(() => props.connection?.status ?? null)
const tip = computed(() => {
  const c = props.connection
  if (!c) return props.platform?.configured ? t('platforms.notConnectedHint') : t('platforms.notConfiguredHint')
  const parts = [c.externalAccountName, c.externalAccountId].filter(Boolean).join(' · ')
  return [parts, c.lastError].filter(Boolean).join('\n') || undefined
})

async function connect() {
  busy.value = true
  try {
    const r = await api<{ url: string }>('POST', `/api/platforms/${props.platform!.id}/connect`, { socialAccountId: props.accountId })
    window.location.assign(r.url)
  } catch (e) { message.error(errorText(e)); busy.value = false }
}

function disconnect() {
  confirmDanger({
    title: t('platforms.confirmDisconnect', { name: props.label }), content: t('platforms.disconnectHint'), okText: t('platforms.disconnect'),
    onOk: async () => {
      try {
        const r = await api<{ revoked: boolean | null }>('DELETE', `/api/platforms/accounts/${props.accountId}/connection`)
        message.success(r.revoked === false ? t('platforms.disconnectedNoRevoke') : t('platforms.disconnected'))
        emit('changed')
      } catch (e) { message.error(errorText(e)) }
    },
  })
}

async function check() {
  busy.value = true
  try {
    await api('POST', `/api/platforms/accounts/${props.accountId}/check`)
    message.success(t('platforms.checkQueued'))
  } catch (e) { message.error(errorText(e)) }
  finally { busy.value = false }
}
</script>

<template>
  <span v-if="!platform" class="muted">—</span>
  <div v-else>
    <a-tooltip :title="tip" overlay-class-name="conn-tip">
      <StatusTag v-if="status" kind="connection" :status="status" />
      <a-tag v-else>{{ platform.configured ? t('platforms.status.none') : t('platforms.notConfigured') }}</a-tag>
    </a-tooltip>
    <div class="ops">
      <a-button v-if="platform.configured" type="link" size="small" :loading="busy" @click="connect">
        {{ connection ? t('platforms.reconnect') : t('platforms.connect') }}
      </a-button>
      <a-button v-if="connection" type="link" size="small" :disabled="busy" @click="check">{{ t('platforms.apiCheck') }}</a-button>
      <a-button v-if="connection" type="link" size="small" danger @click="disconnect">{{ t('platforms.disconnect') }}</a-button>
    </div>
  </div>
</template>

<style scoped>
.ops { display: flex; flex-wrap: wrap; margin-inline-start: -7px; }
.ops :deep(.ant-btn) { padding-inline: 7px; height: 22px; }
</style>
<style>
.conn-tip .ant-tooltip-inner { white-space: pre-line; }
</style>
