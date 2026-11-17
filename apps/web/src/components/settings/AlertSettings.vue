<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { kindKey } from '../../api/alerts'
import { dateLocale } from '../../i18n'

/**
 * Settings → Alerts (admin): which alert kinds go to the in-app bell and to Telegram, cooldown, recipients,
 * "recovered" notices, notification retention, the periodic account check (号状态监控) and the Telegram bot
 * (token write-only: the API only says whether it is set).
 */
const { t } = useI18n()
type KindRule = { inApp: boolean; telegram: boolean }
interface Rules {
  kinds: Record<string, KindRule>; cooldownMinutes: number; notifyAdmins: boolean; recovered: boolean
  retentionDays: number; accountCheckHours: number | null; updatedAt: string | null
}
interface KindInfo { kind: string; severity: 'info' | 'warning' | 'error'; recoverable: boolean }
interface Telegram { enabled: boolean; chatId: string | null; tokenSet: boolean; language: 'zh-CN' | 'en'; updatedAt: string | null }

const kinds = ref<KindInfo[]>([])
const limits = ref({ cooldownMax: 10080, retentionMax: 365, accountCheckMax: 168 })
const rules = ref<Rules | null>(null)
const checkOff = ref(false)
const checkHours = ref(24)
const saving = ref(false)

const tg = ref<Telegram | null>(null)
const tgForm = reactive({ enabled: false, chatId: '', token: '', language: 'zh-CN' as Telegram['language'] })
const tgSaving = ref(false)
const testing = ref(false)

function setRules(r: Rules) {
  rules.value = r
  checkOff.value = r.accountCheckHours === null
  checkHours.value = r.accountCheckHours ?? 24
}
function setTelegram(s: Telegram) {
  tg.value = s
  Object.assign(tgForm, { enabled: s.enabled, chatId: s.chatId ?? '', token: '', language: s.language })
}
onMounted(async () => {
  try {
    const [a, b] = await Promise.all([
      api<{ rules: Rules; kinds: KindInfo[]; limits: typeof limits.value }>('GET', '/api/settings/alerts'),
      api<{ telegram: Telegram }>('GET', '/api/settings/telegram'),
    ])
    kinds.value = a.kinds
    limits.value = a.limits
    setRules(a.rules)
    setTelegram(b.telegram)
  } catch (e) { message.error(errorText(e)) }
})

async function saveRules() {
  if (!rules.value) return
  saving.value = true
  try {
    const r = rules.value
    setRules((await api<{ rules: Rules }>('PUT', '/api/settings/alerts', {
      kinds: r.kinds, cooldownMinutes: r.cooldownMinutes, notifyAdmins: r.notifyAdmins, recovered: r.recovered,
      retentionDays: r.retentionDays, accountCheckHours: checkOff.value ? null : checkHours.value,
    })).rules)
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}

async function saveTelegram(clearToken = false) {
  tgSaving.value = true
  try {
    const body: Record<string, unknown> = { enabled: clearToken ? false : tgForm.enabled, chatId: tgForm.chatId.trim() || null, language: tgForm.language }
    if (clearToken) body.token = null
    else if (tgForm.token.trim()) body.token = tgForm.token.trim()
    setTelegram((await api<{ telegram: Telegram }>('PUT', '/api/settings/telegram', body)).telegram)
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { tgSaving.value = false }
}
async function test() {
  testing.value = true
  try {
    await api('POST', '/api/settings/telegram/test')
    message.success(t('alerts.settings.testSent'))
  } catch (e) { message.error(errorText(e)) }
  finally { testing.value = false }
}
const kindColumns = [
  { key: 'kind', title: () => t('alerts.settings.kind') },
  { key: 'inApp', title: () => t('alerts.settings.inApp'), width: 110, align: 'center' as const },
  { key: 'telegram', title: () => t('alerts.settings.telegram'), width: 110, align: 'center' as const },
]
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="!rules">
      <h4>{{ t('alerts.settings.rulesTitle') }}</h4>
      <p class="muted">{{ t('alerts.settings.rulesHint') }}</p>
      <template v-if="rules">
        <a-table :data-source="kinds" :columns="kindColumns.map((c) => ({ ...c, title: c.title() }))" row-key="kind" size="small" :pagination="false" bordered>
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'kind'">
              {{ t(`alerts.kindNames.${kindKey(record.kind)}`) }}
              <a-tag v-if="record.severity === 'error'" color="error">{{ t('alerts.severity.error') }}</a-tag>
              <a-tag v-else color="warning">{{ t('alerts.severity.warning') }}</a-tag>
            </template>
            <a-switch v-else-if="column.key === 'inApp'" v-model:checked="rules.kinds[record.kind]!.inApp" size="small" />
            <a-switch v-else-if="column.key === 'telegram'" v-model:checked="rules.kinds[record.kind]!.telegram" size="small" />
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

      <a-divider />
      <h4>{{ t('alerts.settings.telegramTitle') }}</h4>
      <p class="muted">{{ t('alerts.settings.telegramHint') }}</p>
      <a-form v-if="tg" layout="vertical">
        <a-form-item>
          <a-checkbox v-model:checked="tgForm.enabled">{{ t('alerts.settings.telegramEnabled') }}</a-checkbox>
        </a-form-item>
        <a-form-item :label="t('alerts.settings.botToken')">
          <a-tag :color="tg.tokenSet ? 'success' : 'default'">{{ tg.tokenSet ? t('alerts.settings.tokenSet') : t('alerts.settings.tokenNotSet') }}</a-tag>
          <a-input-password v-model:value="tgForm.token" class="token" :placeholder="tg.tokenSet ? t('alerts.settings.tokenReplace') : '123456789:AA…'" autocomplete="off" :maxlength="100" />
        </a-form-item>
        <a-form-item :label="t('alerts.settings.chatId')" :extra="t('alerts.settings.chatIdHint')">
          <a-input v-model:value="tgForm.chatId" placeholder="-1001234567890" :maxlength="40" style="width: 260px" />
        </a-form-item>
        <a-form-item :label="t('alerts.settings.language')">
          <a-radio-group v-model:value="tgForm.language">
            <a-radio-button value="zh-CN">中文</a-radio-button>
            <a-radio-button value="en">English</a-radio-button>
          </a-radio-group>
        </a-form-item>
        <a-space wrap>
          <a-button type="primary" :loading="tgSaving" @click="saveTelegram(false)">{{ t('common.save') }}</a-button>
          <a-button :loading="testing" :disabled="!tg.tokenSet || !tg.chatId" @click="test">{{ t('alerts.settings.sendTest') }}</a-button>
          <a-button v-if="tg.tokenSet" danger :loading="tgSaving" @click="saveTelegram(true)">{{ t('alerts.settings.clearToken') }}</a-button>
          <span v-if="tg.updatedAt" class="muted small">{{ t('settings.updatedAt', { at: new Date(tg.updatedAt).toLocaleString(dateLocale()) }) }}</span>
        </a-space>
      </a-form>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 640px; }
.muted { color: var(--cp-text-tertiary); }
.small { font-size: 12px; }
.form { margin-top: 16px; }
.token { margin-top: 8px; }
</style>
