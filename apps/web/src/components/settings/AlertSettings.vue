<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { kindKey } from '../../api/alerts'
import { dateLocale } from '../../i18n'

/**
 * Settings → Alerts (admin): which alert kinds go to the in-app bell, cooldown, recipients, "recovered"
 * notices, notification retention and the periodic account check (号状态监控). External channels
 * (Telegram…) and the kinds each receives live on their own page (/alert-channels).
 */
const { t } = useI18n()
type KindRule = { inApp: boolean }
interface Rules {
  kinds: Record<string, KindRule>; cooldownMinutes: number; notifyAdmins: boolean; recovered: boolean
  retentionDays: number; accountCheckHours: number | null; updatedAt: string | null
}
interface KindInfo { kind: string; severity: 'info' | 'warning' | 'error'; recoverable: boolean }

const kinds = ref<KindInfo[]>([])
const limits = ref({ cooldownMax: 10080, retentionMax: 365, accountCheckMax: 168 })
const rules = ref<Rules | null>(null)
const checkOff = ref(false)
const checkHours = ref(24)
const saving = ref(false)

function setRules(r: Rules) {
  rules.value = r
  checkOff.value = r.accountCheckHours === null
  checkHours.value = r.accountCheckHours ?? 24
}
onMounted(async () => {
  try {
    const a = await api<{ rules: Rules; kinds: KindInfo[]; limits: typeof limits.value }>('GET', '/api/settings/alerts')
    kinds.value = a.kinds
    limits.value = a.limits
    setRules(a.rules)
  } catch (e) { message.error(errorText(e)) }
})

async function saveRules() {
  if (!rules.value) return
  saving.value = true
  try {
    const r = rules.value
    setRules((await api<{ rules: Rules }>('PUT', '/api/settings/alerts', {
      kinds: Object.fromEntries(Object.entries(r.kinds).map(([k, v]) => [k, { inApp: v.inApp }])),
      cooldownMinutes: r.cooldownMinutes, notifyAdmins: r.notifyAdmins, recovered: r.recovered,
      retentionDays: r.retentionDays, accountCheckHours: checkOff.value ? null : checkHours.value,
    })).rules)
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
const kindColumns = [
  { key: 'kind', title: () => t('alerts.settings.kind') },
  { key: 'inApp', title: () => t('alerts.settings.inApp'), width: 110, align: 'center' as const },
]
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="!rules">
      <h4>{{ t('alerts.settings.rulesTitle') }}</h4>
      <p class="muted">{{ t('alerts.settings.rulesHint') }}</p>
      <a-alert type="info" show-icon class="channels">
        <template #message>
          {{ t('alerts.settings.channelsHint') }}
          <router-link to="/alert-channels">{{ t('alerts.settings.channelsLink') }}</router-link>
        </template>
      </a-alert>
      <template v-if="rules">
        <a-table :data-source="kinds" :columns="kindColumns.map((c) => ({ ...c, title: c.title() }))" row-key="kind" size="small" :pagination="false" bordered>
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'kind'">
              {{ t(`alerts.kindNames.${kindKey(record.kind)}`) }}
              <a-tag v-if="record.severity === 'error'" color="error">{{ t('alerts.severity.error') }}</a-tag>
              <a-tag v-else color="warning">{{ t('alerts.severity.warning') }}</a-tag>
            </template>
            <a-switch v-else-if="column.key === 'inApp'" v-model:checked="rules.kinds[record.kind]!.inApp" size="small" />
          </template>
        </a-table>
        <a-form layout="vertical" class="form">
          <a-form-item :label="t('alerts.settings.cooldown')" :extra="t('alerts.settings.cooldownHint')">
            <a-input-number v-model:value="rules.cooldownMinutes" :min="0" :max="limits.cooldownMax" :precision="0" :addon-after="t('alerts.settings.minutes')" style="width: 200px" />
          </a-form-item>
          <a-form-item>
            <a-checkbox v-model:checked="rules.notifyAdmins">{{ t('alerts.settings.notifyAdmins') }}</a-checkbox>
            <div class="muted small">{{ t('alerts.settings.notifyAdminsHint') }}</div>
          </a-form-item>
          <a-form-item>
            <a-checkbox v-model:checked="rules.recovered">{{ t('alerts.settings.recovered') }}</a-checkbox>
          </a-form-item>
          <a-form-item :label="t('alerts.settings.retention')" :extra="t('alerts.settings.retentionHint')">
            <a-input-number v-model:value="rules.retentionDays" :min="1" :max="limits.retentionMax" :precision="0" :addon-after="t('settings.retention.dayUnit')" style="width: 200px" />
          </a-form-item>
          <h4>{{ t('alerts.settings.accountCheckTitle') }}</h4>
          <p class="muted">{{ t('alerts.settings.accountCheckHint') }}</p>
          <a-form-item>
            <a-checkbox v-model:checked="checkOff">{{ t('alerts.settings.accountCheckOff') }}</a-checkbox>
          </a-form-item>
          <a-form-item v-if="!checkOff" :label="t('alerts.settings.accountCheckEvery')">
            <a-input-number v-model:value="checkHours" :min="1" :max="limits.accountCheckMax" :precision="0" :addon-after="t('alerts.settings.hours')" style="width: 200px" />
          </a-form-item>
          <a-space wrap>
            <a-button type="primary" :loading="saving" @click="saveRules">{{ t('common.save') }}</a-button>
            <span v-if="rules.updatedAt" class="muted small">{{ t('settings.updatedAt', { at: new Date(rules.updatedAt).toLocaleString(dateLocale()) }) }}</span>
          </a-space>
        </a-form>
      </template>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 640px; }
.form { margin-top: 16px; }
.channels { margin-bottom: 16px; }
</style>
