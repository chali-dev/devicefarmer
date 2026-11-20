<script setup lang="ts">
import { PlusOutlined, SyncOutlined } from '@ant-design/icons-vue'
import { message, type FormInstance } from 'ant-design-vue'
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { RequiredApp } from '../../api/types'
import { actionColumn, confirmDanger, MODAL_WIDTH } from '../common/ui'

/**
 * 必装应用 (应用库, admin only; owner 2026-11-20 「开机时侦测缺的就装」「必装应用要显示比特云，保持可扩性」): packages every
 * phone of a device source type must have, one tab per source type with an app store (API `sourceTypes`; only 比特云
 * today, another vendor = one more tab + its `library.required.stores.<type>` texts). Each time a phone is attached /
 * powered on, a `required-apps` task checks its type's list over adb and asks the source to install missing ones from
 * its app store (by the store's app id). 立即检查 queues that check on every running phone.
 * API: GET/POST /api/library/required, PUT/DELETE …/:id, POST …/check.
 */
const { t, te } = useI18n()
const apps = ref<RequiredApp[]>([])
const sourceTypes = ref<string[]>([])
const activeType = ref('bitbrowser')
const loading = ref(false)
/** Client-side format check of a store's app id (the API validates with the driver's own pattern). */
const STORE_ID_PATTERN: Record<string, RegExp> = { bitbrowser: /^\d{1,30}$/ }
const storeText = (type: string, key: 'label' | 'appId' | 'appIdHint') =>
  te(`library.required.stores.${type}.${key}`) ? t(`library.required.stores.${type}.${key}`) : key === 'label' ? type : key === 'appId' ? t('library.required.appId') : ''
const shown = computed(() => apps.value.filter((a) => a.sourceType === activeType.value))
async function load() {
  loading.value = true
  try {
    const r = await api<{ apps: RequiredApp[]; sourceTypes: string[] }>('GET', '/api/library/required')
    apps.value = r.apps
    sourceTypes.value = r.sourceTypes
    if (!r.sourceTypes.includes(activeType.value) && r.sourceTypes[0]) activeType.value = r.sourceTypes[0]
  }
  catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
onMounted(load)

const columns = computed(() => [
  { title: t('library.required.name'), dataIndex: 'name', key: 'name', width: 180 },
  { title: t('library.package'), dataIndex: 'package', key: 'package', width: 260 },
  { title: storeText(activeType.value, 'appId'), dataIndex: 'storeAppId', key: 'appId', width: 160 },
  actionColumn(130),
])

// ---- 新增 / 编辑 (3 fields → Modal)
const formRef = ref<FormInstance>()
const editOpen = ref(false)
const editId = ref<string | null>(null)
const saving = ref(false)
const form = reactive({ name: '', package: '', storeAppId: '' })
const rules = computed(() => ({
  name: [{ required: true, whitespace: true, message: t('library.required.nameRequired') }],
  package: [
    { required: true, whitespace: true, message: t('library.required.packageRequired') },
    { pattern: /^\s*[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+\s*$/, message: t('library.required.packageInvalid') },
  ],
  storeAppId: [
    { required: true, whitespace: true, message: t('library.required.appIdRequired') },
    { validator: async (_r: unknown, v: string) => {
      const re = STORE_ID_PATTERN[activeType.value]
      if (v && re && !re.test(v.trim())) throw new Error(t('library.required.appIdInvalid'))
    } },
  ],
}))
function openEdit(a?: RequiredApp) {
  editId.value = a?.id ?? null
  Object.assign(form, { name: a?.name ?? '', package: a?.package ?? '', storeAppId: a?.storeAppId ?? '' })
  editOpen.value = true
  formRef.value?.clearValidate()
}
async function save() {
  try { await formRef.value?.validate() } catch { return }
  saving.value = true
  try {
    const body = { sourceType: activeType.value, name: form.name.trim(), package: form.package.trim(), storeAppId: form.storeAppId.trim() }
    if (editId.value) await api('PUT', `/api/library/required/${editId.value}`, body)
    else await api('POST', '/api/library/required', body)
    message.success(t('library.required.saved'))
    editOpen.value = false
    await load()
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
function remove(a: RequiredApp) {
  confirmDanger({
    title: t('library.required.confirmDelete', { name: a.name }), content: t('library.required.deleteContent'),
    onOk: async () => { try { await api('DELETE', `/api/library/required/${a.id}`); await load() } catch (e) { message.error(errorText(e)) } },
  })
}

// ---- 立即检查: every running phone
const checking = ref(false)
async function checkNow() {
  checking.value = true
  try {
    const r = await api<{ taskIds: string[] }>('POST', '/api/library/required/check', {})
    if (r.taskIds.length) message.success(t('library.required.checkQueued', { n: r.taskIds.length }))
    else message.info(t('library.required.checkNone'))
  } catch (e) { message.error(errorText(e)) }
  finally { checking.value = false }
}
</script>

<template>
  <a-card :bordered="false" :title="t('library.required.title')">
    <template #extra>
      <a-space wrap>
        <a-button size="small" :loading="checking" :disabled="!apps.length" @click="checkNow"><template #icon><SyncOutlined /></template>{{ t('library.required.check') }}</a-button>
        <a-button size="small" type="primary" @click="openEdit()"><template #icon><PlusOutlined /></template>{{ t('library.required.add') }}</a-button>
      </a-space>
    </template>
    <div class="muted small hint">{{ t('library.required.hint') }}</div>
    <a-tabs v-model:active-key="activeType" size="small" class="tabs">
      <a-tab-pane v-for="type in sourceTypes" :key="type" :tab="`${storeText(type, 'label')} (${apps.filter((a) => a.sourceType === type).length})`" />
    </a-tabs>
    <a-table :data-source="shown" :columns="columns" row-key="id" size="small" :loading="loading" :pagination="false" :scroll="{ x: 730 }"
      :locale="{ emptyText: t('library.required.empty') }">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'package' || column.key === 'appId'"><span class="mono">{{ column.key === 'package' ? record.package : record.storeAppId }}</span></template>
        <template v-else-if="column.key === 'ops'">
          <a-space :size="0">
            <a-button type="link" size="small" @click="openEdit(record as RequiredApp)">{{ t('common.edit') }}</a-button>
            <a-button type="link" size="small" danger @click="remove(record as RequiredApp)">{{ t('common.delete') }}</a-button>
          </a-space>
        </template>
      </template>
    </a-table>
  </a-card>

  <a-modal v-model:open="editOpen" :title="editId ? t('library.required.editTitle') : t('library.required.addTitle')" :width="MODAL_WIDTH.sm"
    :confirm-loading="saving" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" @ok="save">
    <a-form ref="formRef" :model="form" :rules="rules" layout="vertical">
      <a-form-item :label="t('library.required.name')" name="name"><a-input v-model:value="form.name" :maxlength="80" placeholder="Instagram" /></a-form-item>
      <a-form-item :label="t('library.package')" name="package"><a-input v-model:value="form.package" :maxlength="150" placeholder="com.instagram.android" /></a-form-item>
      <a-form-item :label="t('devices.ext.source')"><a-input :value="storeText(activeType, 'label')" disabled /></a-form-item>
      <a-form-item :label="storeText(activeType, 'appId')" name="storeAppId" :extra="storeText(activeType, 'appIdHint')" style="margin-bottom: 0">
        <a-input v-model:value="form.storeAppId" :maxlength="30" placeholder="1760185069" />
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.hint { margin-bottom: 4px; }
.tabs :deep(.ant-tabs-nav) { margin-bottom: 8px; }
</style>
