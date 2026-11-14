<script setup lang="ts">
import { message, Modal } from 'ant-design-vue'
import { onMounted, ref } from 'vue'
import { api } from '../api/client'
import type { LibraryApp } from '../api/types'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

const auth = useAuthStore()
const store = useInstancesStore()
const apps = ref<LibraryApp[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try { apps.value = (await api<{ apps: LibraryApp[] }>('GET', '/api/library')).apps }
  catch (e) { message.error((e as Error).message) }
  finally { loading.value = false }
}
onMounted(load)

const size = (a: LibraryApp) => `${(a.files.reduce((s, f) => s + f.size, 0) / 1048576).toFixed(1)} MB`

async function setPreinstall(a: LibraryApp, v: boolean) {
  try { await api('PATCH', `/api/library/${a.id}`, { preinstall: v }); await load() }
  catch (e) { message.error((e as Error).message) }
}

function remove(a: LibraryApp) {
  Modal.confirm({
    title: `从应用库删除 ${a.package} ${a.versionName ?? ''}？`, content: '不影响已安装到实例上的应用。', okType: 'danger', okText: '删除',
    onOk: async () => { try { await api('DELETE', `/api/library/${a.id}`); await load() } catch (e) { message.error((e as Error).message) } },
  })
}

const target = ref<LibraryApp | null>(null)
const targetIds = ref<string[]>([])
async function install() {
  if (!target.value || !targetIds.value.length) return
  try {
    const r = await api<{ accepted: unknown[]; skipped: { reason: string }[] }>('POST', `/api/library/${target.value.id}/install`, { instanceIds: targetIds.value })
    message.success(`已提交 ${r.accepted.length} 个安装任务`)
    if (r.skipped.length) message.warning(`跳过 ${r.skipped.length} 个：${[...new Set(r.skipped.map((s) => s.reason))].join('，')}`)
    target.value = null
  } catch (e) { message.error((e as Error).message) }
}

const columns = [
  { title: '包名', dataIndex: 'package', key: 'package' },
  { title: '版本', key: 'version', width: 200 },
  { title: '文件', key: 'files', width: 140 },
  { title: '来源', dataIndex: 'sourceInstance', key: 'source', width: 120 },
  { title: '新实例预装', key: 'preinstall', width: 110 },
  { title: '', key: 'ops', width: 160, align: 'right' as const },
]
</script>

<template>
  <a-card title="应用库" size="small">
    <template #extra><a-button size="small" :loading="loading" @click="load">刷新</a-button></template>
    <a-alert type="info" show-icon style="margin-bottom: 12px">
      <template #message>如何添加 YouTube / Instagram / Chrome</template>
      <template #description>
        在任一实例登录 Google 账号，从 Play 商店安装应用；然后在该实例详情页「应用管理」中点击「加入应用库」。
        之后可一键安装到其他实例，或开启「新实例预装」让新建实例自动安装（不需要再登录 Play 商店）。
        更新：在来源实例更新后再次「加入应用库」，新版本会自动接管预装。
      </template>
    </a-alert>
    <a-table :data-source="apps" :columns="columns" row-key="id" size="middle" :loading="loading" :pagination="false" :scroll="{ x: 820 }"
      :locale="{ emptyText: '应用库为空' }">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'version'">{{ record.versionName ?? '—' }} <span style="color: #8c8c8c">({{ record.versionCode }})</span></template>
        <template v-else-if="column.key === 'files'">{{ record.files.length }} 个 APK · {{ size(record) }}</template>
        <template v-else-if="column.key === 'preinstall'">
          <a-switch :checked="record.preinstall" size="small" :disabled="!auth.canOperate" @change="(v: any) => setPreinstall(record, v)" />
        </template>
        <template v-else-if="column.key === 'ops'">
          <a-button v-if="auth.canOperate" type="link" size="small" @click="target = record; targetIds = []">安装到实例</a-button>
          <a-button v-if="auth.isAdmin" type="link" size="small" danger @click="remove(record)">删除</a-button>
        </template>
      </template>
    </a-table>
  </a-card>

  <a-modal :open="!!target" :title="`安装 ${target?.package} 到实例`" ok-text="安装" @ok="install" @cancel="target = null">
    <a-select v-model:value="targetIds" mode="multiple" style="width: 100%" placeholder="选择运行中的实例"
      :options="store.list.filter((i) => i.status === 'running').map((i) => ({ value: i.id, label: i.name }))" />
  </a-modal>
</template>
