<script setup lang="ts">
import { PlusOutlined, SyncOutlined } from '@ant-design/icons-vue'
import { message, type FormInstance } from 'ant-design-vue'
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { RequiredApp } from '../../api/types'
import { actionColumn, confirmDanger, MODAL_WIDTH } from '../common/ui'

/**
 * 必装应用 (应用库, admin only; owner 2026-11-20 「开机时侦测缺的就装」): packages every phone must have. Each time a
 * phone is attached / powered on, a `required-apps` task checks them over adb and asks BitBrowser to install missing
 * ones from its app store (by the store's app id). 立即检查 queues that check on every running phone.
 * API: GET/POST /api/library/required, PUT/DELETE …/:id, POST …/check.
 */
const { t } = useI18n()
const apps = ref<RequiredApp[]>([])
const loading = ref(false)
async function load() {
  loading.value = true
  try { apps.value = (await api<{ apps: RequiredApp[] }>('GET', '/api/library/required')).apps }
  catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
onMounted(load)

const columns = computed(() => [
  { title: t('library.required.name'), dataIndex: 'name', key: 'name', width: 180 },
  { title: t('library.package'), dataIndex: 'package', key: 'package', width: 260 },
  { title: t('library.required.appId'), dataIndex: 'bitbrowserAppId', key: 'appId', width: 160 },
  actionColumn(130),
])

// ---- 新增 / 编辑 (3 fields → Modal)
const formRef = ref<FormInstance>()
const editOpen = ref(false)
const editId = ref<string | null>(null)
const saving = ref(false)
const form = reactive({ name: '', package: '', bitbrowserAppId: '' })
const rules = computed(() => ({
  name: [{ required: true, whitespace: true, message: t('library.required.nameRequired') }],
  package: [
    { required: true, whitespace: true, message: t('library.required.packageRequired') },
    { pattern: /^\s*[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+\s*$/, message: t('library.required.packageInvalid') },
  ],
  bitbrowserAppId: [
    { required: true, whitespace: true, message: t('library.required.appIdRequired') },
    { pattern: /^\s*\d{1,30}\s*$/, message: t('library.required.appIdInvalid') },
  ],
}))
function openEdit(a?: RequiredApp) {
  editId.value = a?.id ?? null
  Object.assign(form, { name: a?.name ?? '', package: a?.package ?? '', bitbrowserAppId: a?.bitbrowserAppId ?? '' })
  editOpen.value = true
  formRef.value?.clearValidate()
}
async function save() {
  try { await formRef.value?.validate() } catch { return }
  saving.value = true
  try {
    const body = { name: form.name.trim(), package: form.package.trim(), bitbrowserAppId: form.bitbrowserAppId.trim() }
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
    <a-table :data-source="apps" :columns="columns" row-key="id" size="small" :loading="loading" :pagination="false" :scroll="{ x: 730 }"
      :locale="{ emptyText: t('library.required.empty') }">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'package' || column.key === 'appId'"><span class="mono">{{ column.key === 'package' ? record.package : record.bitbrowserAppId }}</span></template>
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
      <a-form-item :label="t('library.required.appId')" name="bitbrowserAppId" :extra="t('library.required.appIdHint')" style="margin-bottom: 0">
        <a-input v-model:value="form.bitbrowserAppId" :maxlength="30" placeholder="1760185069" />
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.hint { margin-bottom: 12px; }
</style>
