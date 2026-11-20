<script setup lang="ts">
import { QuestionCircleOutlined, UploadOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import type { LibraryApp } from '../api/types'
import PageContainer from '../components/common/PageContainer.vue'
import { actionColumn, confirmDanger, pagination, TABLE_SIZE } from '../components/common/ui'
import LibraryInstallModal from '../components/library/LibraryInstallModal.vue'
import LibraryLogDrawer from '../components/library/LibraryLogDrawer.vue'
import RequiredAppsCard from '../components/library/RequiredAppsCard.vue'
import { useInstancesStore } from '../stores/instances'

/**
 * 应用库 (admin only since 2026-11-18, page and API): 必装应用 (apps every phone must have, installed from BitBrowser's
 * app store when missing) on top, then the APK library: upload / update APKs in bulk, install to devices.
 */
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
// No refresh button: the list reloads after own changes and when an import into the library finishes.
const off = useInstancesStore().onTaskEvent((ev) => {
  if (ev.type === 'task.updated' && ev.task.type === 'import-app' && ev.task.status === 'success') void load()
})
onBeforeUnmount(off)

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

function remove(a: LibraryApp) {
  confirmDanger({
    title: t('library.confirmDelete', { name: `${a.package} ${a.versionName ?? ''}`.trim() }), content: t('library.deleteContent'),
    onOk: async () => { try { await api('DELETE', `/api/library/${a.id}`); await load() } catch (e) { message.error(errorText(e)) } },
  })
}

/** Install modal (one batch request for the picked devices) and install log drawer. */
const target = ref<LibraryApp | null>(null)
const logsOf = ref<LibraryApp | null>(null)

const columns = computed(() => [
  { title: t('library.package'), dataIndex: 'package', key: 'package', width: 260 },
  { title: t('library.version'), key: 'version', width: 200 },
  { title: t('library.files'), key: 'files', width: 140 },
  { title: t('library.source'), dataIndex: 'sourceInstance', key: 'source', width: 160 },
  actionColumn(190),
])
</script>

<template>
  <PageContainer>
    <template #title-suffix>
      <a-tooltip :title="t('library.howToBody')"><QuestionCircleOutlined class="muted" /></a-tooltip>
    </template>
    <RequiredAppsCard />
    <a-card :bordered="false" :title="t('library.listTitle')">
      <template #extra>
        <a-tooltip :title="t('library.uploadTip')">
          <a-upload :accept="UPLOAD_ACCEPT" :show-upload-list="false" :before-upload="upload" :disabled="uploading">
            <a-button type="primary" size="small" :loading="uploading"><template #icon><UploadOutlined /></template>{{ t('library.upload') }}</a-button>
          </a-upload>
        </a-tooltip>
      </template>
      <a-table :data-source="apps" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :pagination="pagination({ defaultPageSize: 50 })" :scroll="{ x: 930 }"
        :locale="{ emptyText: t('library.empty') }">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'package'"><span class="mono">{{ record.package }}</span></template>
          <template v-else-if="column.key === 'version'">{{ record.versionName ?? '—' }} <span class="muted">({{ record.versionCode }})</span></template>
          <template v-else-if="column.key === 'files'">{{ t('library.apkCount', { n: record.files.length, size: size(record) }) }}</template>
          <template v-else-if="column.key === 'source'">{{ sourceText(record.sourceInstance) }}</template>
          <template v-else-if="column.key === 'ops'">
            <a-space :size="0">
              <a-button type="link" size="small" @click="target = record">{{ t('common.install') }}</a-button>
              <a-button type="link" size="small" @click="logsOf = record">{{ t('library.logs') }}</a-button>
              <a-button type="link" size="small" danger @click="remove(record)">{{ t('common.delete') }}</a-button>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-card>
  </PageContainer>

  <LibraryInstallModal :app="target" @close="target = null" @submitted="target = null" />
  <LibraryLogDrawer :app="logsOf" @close="logsOf = null" />
</template>
