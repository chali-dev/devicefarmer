<script setup lang="ts">
import { message, Modal } from 'ant-design-vue'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import type { LibraryApp } from '../api/types'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

const auth = useAuthStore()
const store = useInstancesStore()
const { t } = useI18n()
const apps = ref<LibraryApp[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try { apps.value = (await api<{ apps: LibraryApp[] }>('GET', '/api/library')).apps }
  catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
onMounted(load)

/** Admin upload: .apk or split bundle; package/version are read from the manifests by the API. */
const UPLOAD_ACCEPT = '.apk,.apks,.xapk,.apkm,.zip'
const uploading = ref(false)
async function upload(file: File) {
  uploading.value = true
  const hide = message.loading(t('library.uploading'), 0)
  try {
    const body = new FormData()
    body.append('file', file)
    const r = await api<{ app: LibraryApp }>('POST', '/api/library/upload', body)
    message.success(t('library.uploaded', { pkg: r.app.package, version: r.app.versionName ?? r.app.versionCode }))
    await load()
  } catch (e) { message.error(errorText(e)) }
  finally { hide(); uploading.value = false }
  return false // handled here, not by a-upload
}
const sourceText = (s: string | null) => (s?.startsWith('upload:') ? t('library.uploadedBy', { user: s.slice('upload:'.length) }) : s ?? '—')

const size = (a: LibraryApp) => `${(a.files.reduce((s, f) => s + f.size, 0) / 1048576).toFixed(1)} MB`

async function setPreinstall(a: LibraryApp, v: boolean) {
  try { await api('PATCH', `/api/library/${a.id}`, { preinstall: v }); await load() }
  catch (e) { message.error(errorText(e)) }
}

function remove(a: LibraryApp) {
  Modal.confirm({
    title: t('library.confirmDelete', { name: `${a.package} ${a.versionName ?? ''}`.trim() }), content: t('library.deleteContent'), okType: 'danger',
    okText: t('common.delete'), cancelText: t('common.cancel'),
    onOk: async () => { try { await api('DELETE', `/api/library/${a.id}`); await load() } catch (e) { message.error(errorText(e)) } },
  })
}

const target = ref<LibraryApp | null>(null)
const targetIds = ref<string[]>([])
async function install() {
  if (!target.value || !targetIds.value.length) return
  try {
    const r = await api<{ accepted: unknown[]; skipped: { reason: string }[] }>('POST', `/api/library/${target.value.id}/install`, { instanceIds: targetIds.value })
    message.success(t('library.submitted', { n: r.accepted.length }))
    if (r.skipped.length) message.warning(t('common.skipped', { n: r.skipped.length, reasons: [...new Set(r.skipped.map((s) => s.reason))].join(t('common.reasonSep')) }))
    target.value = null
  } catch (e) { message.error(errorText(e)) }
}

const columns = computed(() => [
  { title: t('library.package'), dataIndex: 'package', key: 'package' },
  { title: t('library.version'), key: 'version', width: 200 },
  { title: t('library.files'), key: 'files', width: 140 },
  { title: t('library.source'), dataIndex: 'sourceInstance', key: 'source', width: 120 },
  { title: t('library.preinstall'), key: 'preinstall', width: 110 },
  { title: '', key: 'ops', width: 160, align: 'right' as const },
])
</script>

<template>
  <a-card :title="t('library.title')" size="small">
    <template #extra>
      <a-space>
        <a-tooltip v-if="auth.isAdmin" :title="t('library.uploadTip')">
          <a-upload :accept="UPLOAD_ACCEPT" :show-upload-list="false" :before-upload="upload" :disabled="uploading">
            <a-button size="small" type="primary" :loading="uploading">{{ t('library.upload') }}</a-button>
          </a-upload>
        </a-tooltip>
        <a-button size="small" :loading="loading" @click="load">{{ t('common.refresh') }}</a-button>
      </a-space>
    </template>
    <a-alert type="info" show-icon style="margin-bottom: 12px">
      <template #message>{{ t('library.howTo') }}</template>
      <template #description>{{ t('library.howToBody') }}</template>
    </a-alert>
    <a-table :data-source="apps" :columns="columns" row-key="id" size="middle" :loading="loading" :pagination="false" :scroll="{ x: 820 }"
      :locale="{ emptyText: t('library.empty') }">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'version'">{{ record.versionName ?? '—' }} <span class="muted">({{ record.versionCode }})</span></template>
        <template v-else-if="column.key === 'files'">{{ t('library.apkCount', { n: record.files.length, size: size(record) }) }}</template>
        <template v-else-if="column.key === 'source'">{{ sourceText(record.sourceInstance) }}</template>
        <template v-else-if="column.key === 'preinstall'">
          <a-switch v-if="auth.isAdmin" :checked="record.preinstall" size="small" @change="(v: any) => setPreinstall(record, v)" />
          <span v-else>{{ record.preinstall ? t('common.yes') : '—' }}</span>
        </template>
        <template v-else-if="column.key === 'ops'">
          <a-button type="link" size="small" @click="target = record; targetIds = []">{{ t('library.installTo') }}</a-button>
          <a-button v-if="auth.isAdmin" type="link" size="small" danger @click="remove(record)">{{ t('common.delete') }}</a-button>
        </template>
      </template>
    </a-table>
  </a-card>

  <a-modal :open="!!target" :title="t('library.installTitle', { pkg: target?.package ?? '' })" :ok-text="t('common.install')" :cancel-text="t('common.cancel')" @ok="install" @cancel="target = null">
    <a-select v-model:value="targetIds" mode="multiple" style="width: 100%" :placeholder="t('library.pickRunning')"
      :options="store.list.filter((i) => i.status === 'running').map((i) => ({ value: i.id, label: i.name }))" />
  </a-modal>
</template>

<style scoped>
.muted { color: var(--cp-text-tertiary); }
</style>
