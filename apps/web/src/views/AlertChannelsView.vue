<script setup lang="ts">
import { PlusOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Rule } from 'ant-design-vue/es/form'
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { kindKey } from '../api/alerts'
import { api, codeText, errorText } from '../api/client'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import StatusTag from '../components/common/StatusTag.vue'
import { actionColumn, confirmDanger, DRAWER_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'
import { dateLocale } from '../i18n'

/**
 * 告警通道 (admin): external alert destinations. Each channel has a type (Telegram today), the alert kinds it
 * receives (none = all) and an optional minimum severity. Secrets are write-only: the API only says
 * `botTokenSet`, and an empty token field on edit keeps the stored one.
 */
type Severity = 'warning' | 'error'
interface Channel {
  id: string; name: string; type: string; enabled: boolean; kinds: string[]; minSeverity: Severity | null
  config: { chatId?: string; threadId?: number | null; language?: 'zh-CN' | 'en'; botTokenSet?: boolean }
  lastResult: { ok: boolean; at: string; test?: boolean; code?: string | null } | null
  createdAt: string; updatedAt: string
}
interface KindInfo { kind: string; severity: Severity }

const { t } = useI18n()
const channels = ref<Channel[]>([])
const kinds = ref<KindInfo[]>([])
const types = ref<string[]>(['telegram'])
const loading = ref(false)
const testing = ref(new Set<string>())

async function load() {
  loading.value = true
  try {
    const r = await api<{ channels: Channel[]; kinds: KindInfo[]; types: string[] }>('GET', '/api/alert-channels')
    channels.value = r.channels
    kinds.value = r.kinds
    types.value = r.types
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
onMounted(load)

const kindName = (k: string) => t(`alerts.kindNames.${kindKey(k)}`)
const replace = (row: Channel) => { channels.value = channels.value.map((c) => (c.id === row.id ? row : c)) }
const resultStatus = (c: Channel) => (c.lastResult ? (c.lastResult.ok ? 'ok' : 'failed') : 'never')
const resultTip = (c: Channel) => c.lastResult
  ? [new Date(c.lastResult.at).toLocaleString(dateLocale()), c.lastResult.test ? t('alertChannels.resultTest') : null,
      c.lastResult.code ? codeText(c.lastResult.code, { error: '', status: '', type: '' }, c.lastResult.code) : null].filter(Boolean).join(' · ')
  : null

const columns = computed(() => [
  { title: t('alertChannels.colName'), key: 'name', width: 200 },
  { title: t('alertChannels.type'), key: 'type', width: 100 },
  { title: t('alertChannels.colTarget'), key: 'target', width: 220 },
  { title: t('alertChannels.colKinds'), key: 'kinds', width: 260 },
  { title: t('alertChannels.colEnabled'), key: 'enabled', width: 80 },
  { title: t('alertChannels.colLast'), key: 'last', width: 120 },
  actionColumn(170),
])

async function toggle(c: Channel, enabled: boolean) {
  try { replace((await api<{ channel: Channel }>('PATCH', `/api/alert-channels/${c.id}`, { enabled })).channel) }
  catch (e) { message.error(errorText(e)) }
}
async function test(c: Channel) {
  testing.value.add(c.id)
  try { await api('POST', `/api/alert-channels/${c.id}/test`); message.success(t('alertChannels.testSent')) }
  catch (e) { message.error(errorText(e)) }
  finally { testing.value.delete(c.id); await load() }
}
function remove(c: Channel) {
  confirmDanger({
    title: t('alertChannels.confirmDelete', { name: c.name }), content: t('alertChannels.deleteContent'),
    onOk: async () => {
      try { await api('DELETE', `/api/alert-channels/${c.id}`); message.success(t('common.deleted')) }
      catch (e) { message.error(errorText(e)) }
      finally { await load() }
    },
  })
}

// ---- create / edit (drawer)
const open = ref(false)
const saving = ref(false)
const editing = ref<Channel | null>(null)
const formRef = ref<FormInstance>()
const blank = () => ({
  name: '', type: 'telegram', enabled: true, botToken: '', chatId: '', threadId: null as number | null, language: 'zh-CN' as 'zh-CN' | 'en',
  // A new channel starts with the kinds that are on by default (everything except "other task failed").
  kinds: kinds.value.filter((k) => k.kind !== 'task.failed').map((k) => k.kind), minSeverity: null as Severity | null,
})
const form = reactive(blank())
const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/
const rules = computed<Record<string, Rule[]>>(() => ({
  name: [{ required: true, whitespace: true, message: t('alertChannels.nameRequired') }],
  botToken: editing.value?.config.botTokenSet ? [] : [{ required: true, whitespace: true, message: t('alertChannels.tokenRequired') }],
  chatId: [{ required: true, whitespace: true, message: t('alertChannels.chatIdRequired') }, { pattern: CHAT_RE, message: t('alertChannels.chatIdInvalid') }],
}))
function openAdd() { editing.value = null; Object.assign(form, blank()); formRef.value?.clearValidate(); open.value = true }
function openEdit(c: Channel) {
  editing.value = c
  Object.assign(form, {
    ...blank(), name: c.name, type: c.type, enabled: c.enabled, chatId: c.config.chatId ?? '', threadId: c.config.threadId ?? null,
    language: c.config.language ?? 'zh-CN', kinds: [...c.kinds], minSeverity: c.minSeverity,
  })
  formRef.value?.clearValidate()
  open.value = true
}
async function save() {
  try { await formRef.value?.validate() } catch { return }
  saving.value = true
  try {
    const config: Record<string, unknown> = { chatId: form.chatId.trim(), threadId: form.threadId || null, language: form.language }
    if (form.botToken.trim()) config.botToken = form.botToken.trim()
    const body = { name: form.name.trim(), enabled: form.enabled, kinds: form.kinds, minSeverity: form.minSeverity, config }
    if (editing.value) await api('PATCH', `/api/alert-channels/${editing.value.id}`, body)
    else await api('POST', '/api/alert-channels', { ...body, type: form.type })
    message.success(t(editing.value ? 'common.saved' : 'common.created'))
    open.value = false
    await load()
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
</script>

<template>
  <PageContainer :subtitle="t('alertChannels.subtitle')">
    <template #extra>
      <a-button type="primary" @click="openAdd"><template #icon><PlusOutlined /></template>{{ t('alertChannels.add') }}</a-button>
    </template>
    <a-card :bordered="false">
      <SearchBar :loading="loading" @refresh="load">
        <span class="muted">{{ t('alertChannels.rulesLink') }} · <router-link :to="{ path: '/settings', query: { tab: 'alerts' } }">{{ t('nav.settings') }}</router-link></span>
      </SearchBar>
      <a-table
        :data-source="channels" :columns="columns" row-key="id" :loading="loading" :size="TABLE_SIZE"
        :pagination="pagination({ hideOnSinglePage: true })" :scroll="{ x: 1150 }"
      >
        <template #emptyText>
          <a-empty :description="t('alertChannels.empty')">
            <a-button type="primary" @click="openAdd"><template #icon><PlusOutlined /></template>{{ t('alertChannels.add') }}</a-button>
          </a-empty>
        </template>
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <a-typography-text :content="record.name" :ellipsis="{ tooltip: record.name }" style="display: block" />
          </template>
          <template v-else-if="column.key === 'type'">
            <a-tag>{{ t(`alertChannels.types.${record.type}`) }}</a-tag>
          </template>
          <template v-else-if="column.key === 'target'">
            <span class="mono">{{ record.config.chatId ?? '—' }}</span>
            <span v-if="record.config.threadId" class="muted small"> #{{ record.config.threadId }}</span>
            <span class="muted small"> · {{ record.config.language === 'en' ? 'English' : '中文' }}</span>
          </template>
          <template v-else-if="column.key === 'kinds'">
            <a-space :size="[4, 4]" wrap>
              <a-tag v-if="!record.kinds.length" color="blue">{{ t('alertChannels.allKinds') }}</a-tag>
              <a-tag v-for="k in record.kinds" :key="k">{{ kindName(k) }}</a-tag>
              <a-tag v-if="record.minSeverity" color="orange">{{ t(`alertChannels.sev.${record.minSeverity}`) }}</a-tag>
            </a-space>
          </template>
          <template v-else-if="column.key === 'enabled'">
            <a-switch :checked="record.enabled" size="small" @change="(v: any) => toggle(record, Boolean(v))" />
          </template>
          <template v-else-if="column.key === 'last'">
            <a-tooltip :title="resultTip(record)"><StatusTag kind="alertChannel" :status="resultStatus(record)" /></a-tooltip>
          </template>
          <template v-else-if="column.key === 'ops'">
            <a-space :size="0">
              <a-button type="link" size="small" @click="openEdit(record)">{{ t('common.edit') }}</a-button>
              <a-button type="link" size="small" :loading="testing.has(record.id)" @click="test(record)">{{ t('alertChannels.test') }}</a-button>
              <a-button type="link" size="small" danger @click="remove(record)">{{ t('common.delete') }}</a-button>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-card>
  </PageContainer>

  <a-drawer v-model:open="open" :title="editing ? t('alertChannels.edit') : t('alertChannels.add')" :width="DRAWER_WIDTH.md" destroy-on-close>
    <a-form ref="formRef" :model="form" :rules="rules" layout="vertical">
      <a-row :gutter="12">
        <a-col :xs="24" :sm="16">
          <a-form-item :label="t('alertChannels.name')" name="name"><a-input v-model:value="form.name" :maxlength="60" /></a-form-item>
        </a-col>
        <a-col :xs="24" :sm="8">
          <a-form-item :label="t('alertChannels.type')">
            <a-select v-model:value="form.type" :disabled="!!editing" :options="types.map((x) => ({ value: x, label: t(`alertChannels.types.${x}`) }))" />
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item name="enabled"><a-checkbox v-model:checked="form.enabled">{{ t('alertChannels.enabled') }}</a-checkbox></a-form-item>
      <a-form-item :label="t('alertChannels.botToken')" name="botToken" :extra="editing?.config.botTokenSet ? t('alertChannels.tokenKeep') : t('alertChannels.tokenHint')">
        <a-input-password v-model:value="form.botToken" autocomplete="new-password" :maxlength="100" :placeholder="editing?.config.botTokenSet ? '••••••••' : '123456789:AA…'" />
      </a-form-item>
      <a-row :gutter="12">
        <a-col :xs="24" :sm="14">
          <a-form-item :label="t('alertChannels.chatId')" name="chatId" :extra="t('alertChannels.chatIdHint')">
            <a-input v-model:value="form.chatId" placeholder="-1001234567890" :maxlength="40" />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="10">
          <a-form-item :label="t('alertChannels.threadId')" name="threadId" :extra="t('alertChannels.threadIdHint')">
            <a-input-number v-model:value="form.threadId" :min="1" :precision="0" style="width: 100%" />
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item :label="t('alertChannels.language')">
        <a-radio-group v-model:value="form.language">
          <a-radio-button value="zh-CN">中文</a-radio-button>
          <a-radio-button value="en">English</a-radio-button>
        </a-radio-group>
      </a-form-item>
      <a-form-item :label="t('alertChannels.kinds')" :extra="t('alertChannels.kindsHint')">
        <a-select
          v-model:value="form.kinds" mode="multiple" allow-clear :placeholder="t('alertChannels.allKinds')"
          :options="kinds.map((k) => ({ value: k.kind, label: kindName(k.kind) }))"
        />
      </a-form-item>
      <a-form-item :label="t('alertChannels.minSeverity')" :extra="t('alertChannels.minSeverityHint')">
        <a-select
          v-model:value="form.minSeverity"
          :options="[{ value: null, label: t('alertChannels.anySeverity') }, { value: 'warning', label: t('alertChannels.sev.warning') }, { value: 'error', label: t('alertChannels.sev.error') }]"
        />
      </a-form-item>
    </a-form>
    <template #footer>
      <a-space>
        <a-button @click="open = false">{{ t('common.cancel') }}</a-button>
        <a-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</a-button>
      </a-space>
    </template>
  </a-drawer>
</template>
