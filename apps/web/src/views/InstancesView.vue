<script setup lang="ts">
import { message, Modal } from 'ant-design-vue'
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api/client'
import { useRouter } from 'vue-router'
import { BUSY_STATUSES, type Instance, type Profile } from '../api/types'
import StatusTag from '../components/StatusTag.vue'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

const store = useInstancesStore()
const auth = useAuthStore()
const router = useRouter()
const selectedKeys = ref<string[]>([])

const ACTION_TEXT = { start: '启动', stop: '停止', restart: '重启', delete: '删除' } as const
type Action = keyof typeof ACTION_TEXT

const counts = computed(() => {
  const c = { total: store.list.length, running: 0, busy: 0, error: 0 }
  for (const i of store.list) {
    if (i.status === 'running') c.running++
    else if (BUSY_STATUSES.includes(i.status)) c.busy++
    else if (i.status === 'error') c.error++
  }
  return c
})

const columns = [
  { title: '名称', dataIndex: 'name', key: 'name' },
  { title: '镜像', key: 'profile', width: 190 },
  { title: '状态', key: 'status', width: 110 },
  { title: '设备', key: 'device', width: 220 },
  { title: '网络', key: 'net', width: 170 },
  { title: 'ADB 端口', dataIndex: 'adbPort', key: 'adbPort', width: 100 },
  { title: '分辨率', key: 'spec', width: 140 },
  { title: '', key: 'ops', width: 90, align: 'right' as const },
]

async function run(action: Action, ids: string[]) {
  if (!ids.length) return
  const go = async () => {
    try {
      const r = await store.action(action, ids)
      if (r.accepted.length) message.success(`已提交 ${r.accepted.length} 个${ACTION_TEXT[action]}任务`)
      if (r.skipped.length) message.warning(`跳过 ${r.skipped.length} 个：${[...new Set(r.skipped.map((s) => s.reason))].join('，')}`)
      if (action === 'delete') selectedKeys.value = []
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  if (action === 'delete' || action === 'restart' || action === 'stop') {
    const names = ids.map((id) => store.byId.get(id)?.name).filter(Boolean)
    Modal.confirm({
      title: `确认${ACTION_TEXT[action]} ${ids.length} 个设备？`,
      content: action === 'delete'
        ? `将删除容器和数据目录，无法恢复：${names.join('、')}`
        : names.join('、'),
      okType: action === 'delete' ? 'danger' : 'primary',
      okText: ACTION_TEXT[action],
      onOk: go,
    })
  } else {
    await go()
  }
}

// ---- batch app install / uninstall
const appOpen = ref(false)
const appMode = ref<'install' | 'uninstall'>('install')
const appFile = ref<File | null>(null)
const appPkg = ref('')
const appBusy = ref(false)
function openApp(mode: 'install' | 'uninstall') { appMode.value = mode; appFile.value = null; appPkg.value = ''; appOpen.value = true }
function pickFile(f: File) { appFile.value = f; return false }
async function submitApp() {
  appBusy.value = true
  try {
    const r = appMode.value === 'install'
      ? await (appFile.value ? store.installApp(selectedKeys.value, appFile.value) : Promise.reject(new Error('请选择安装包')))
      : await (appPkg.value ? store.uninstallApp(selectedKeys.value, appPkg.value.trim()) : Promise.reject(new Error('请输入包名')))
    message.success(`已提交 ${r.accepted.length} 个任务`)
    if (r.skipped.length) message.warning(`跳过 ${r.skipped.length} 个：${[...new Set(r.skipped.map((x) => x.reason))].join('，')}`)
    appOpen.value = false
  } catch (e) { message.error((e as Error).message) }
  finally { appBusy.value = false }
}

// ---- create
const createOpen = ref(false)
const creating = ref(false)
const PRESETS = { '720x1280@320': [720, 1280, 320], '1080x1920@480': [1080, 1920, 480], '540x960@240': [540, 960, 240] } as const
const profiles = ref<Profile[]>([])
const profileName = (id: string) => profiles.value.find((p) => p.id === id)?.label.split('（')[0] ?? id
onMounted(async () => {
  try { profiles.value = (await api<{ profiles: Profile[] }>('GET', '/api/profiles')).profiles } catch { /* shown on create */ }
})
const TIMEZONES = Intl.supportedValuesOf('timeZone')
const LOCALES = ['zh-CN', 'zh-TW', 'zh-HK', 'en-US', 'en-GB', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES', 'pt-BR', 'ru-RU', 'ar-SA', 'th-TH', 'vi-VN', 'id-ID']
const form = reactive({ locale: undefined as string | undefined, timezone: undefined as string | undefined, deviceName: '', profile: 'redroid-13-gapps', count: 1, namePrefix: 'phone', preset: '720x1280@320' as keyof typeof PRESETS, memoryMb: undefined as number | undefined })
async function submitCreate() {
  creating.value = true
  try {
    const [width, height, dpi] = PRESETS[form.preset]
    const r = await store.create({
      ...(form.locale ? { locale: form.locale } : {}), ...(form.timezone ? { timezone: form.timezone } : {}), ...(form.deviceName ? { deviceName: form.deviceName } : {}),
      profile: form.profile, count: form.count, namePrefix: form.namePrefix, width, height, dpi, ...(form.memoryMb ? { memoryMb: form.memoryMb } : {}) })
    message.success(`已提交创建：${r.instances.map((i) => i.name).join('、')}`)
    createOpen.value = false
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    creating.value = false
  }
}

function netTitle(i: Instance) {
  if (!i.proxy) return ''
  const egress = i.proxyStatus?.egressIp ? ` · 出口 ${i.proxyStatus.egressIp}` : ''
  return `${i.proxy.type}://${i.proxy.host}:${i.proxy.port}${egress}`
}

function deviceText(i: Instance) {
  if (i.status !== 'running') return null
  return [
    { ok: i.bootCompleted, text: '系统' },
    { ok: i.adbState === 'device', text: 'ADB' },
    { ok: i.stfReady, text: 'STF' },
  ]
}

const TASK_TEXT: Record<string, string> = { create: '创建', start: '启动', stop: '停止', restart: '重启', delete: '删除', 'install-apk': '安装/更新应用', 'uninstall-app': '卸载应用', 'apply-settings': '应用设备参数', 'set-proxy': '设置代理', 'import-app': '导入应用库', 'push-asset': '推送素材' }
const TASK_STATUS: Record<string, { color: string; text: string }> = {
  queued: { color: 'default', text: '排队' }, running: { color: 'processing', text: '执行中' },
  succeeded: { color: 'success', text: '成功' }, failed: { color: 'error', text: '失败' },
}
</script>

<template>
  <a-space direction="vertical" size="middle" style="width: 100%">
    <a-row :gutter="[16, 16]">
      <a-col :xs="12" :md="6"><a-card size="small"><a-statistic title="设备总数" :value="counts.total" /></a-card></a-col>
      <a-col :xs="12" :md="6"><a-card size="small"><a-statistic title="运行中" :value="counts.running" /></a-card></a-col>
      <a-col :xs="12" :md="6"><a-card size="small"><a-statistic title="处理中" :value="counts.busy" /></a-card></a-col>
      <a-col :xs="12" :md="6"><a-card size="small"><a-statistic title="异常" :value="counts.error" /></a-card></a-col>
    </a-row>

    <a-card title="设备列表" size="small">
      <template #extra>
        <a-space wrap>
          <a-button :disabled="!selectedKeys.length" @click="run('start', selectedKeys)">启动</a-button>
          <a-button :disabled="!selectedKeys.length" @click="run('stop', selectedKeys)">停止</a-button>
          <a-button :disabled="!selectedKeys.length" @click="run('restart', selectedKeys)">重启</a-button>
          <a-button :disabled="!selectedKeys.length" @click="openApp('install')">安装应用</a-button>
          <a-button :disabled="!selectedKeys.length" @click="openApp('uninstall')">卸载应用</a-button>
          <template v-if="auth.isAdmin">
            <a-button danger :disabled="!selectedKeys.length" @click="run('delete', selectedKeys)">删除</a-button>
            <a-button type="primary" @click="createOpen = true">创建设备</a-button>
          </template>
          <a-button :loading="store.loading" @click="store.refresh()">刷新</a-button>
        </a-space>
      </template>

      <a-table
        :data-source="store.list"
        :columns="columns"
        row-key="id"
        size="middle"
        :pagination="false"
        :scroll="{ x: 760 }"
        :row-selection="{ selectedRowKeys: selectedKeys, onChange: (k: any[]) => (selectedKeys = k as string[]) }"
        :locale="{ emptyText: auth.isAdmin ? '还没有设备，点击右上角「创建设备」' : '暂无可访问的设备，请联系管理员授权' }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <a @click="router.push(`/instances/${record.id}`)">{{ record.name }}</a>
          </template>
          <template v-else-if="column.key === 'profile'">
            <a-space :size="4">
              <span>{{ profileName(record.profile) }}</span>
              <a-tag v-if="record.google" :color="record.google.gms.running ? 'green' : 'orange'">GMS</a-tag>
            </a-space>
          </template>
          <template v-else-if="column.key === 'status'">
            <StatusTag :status="record.status" />
          </template>
          <template v-else-if="column.key === 'device'">
            <a-tooltip v-if="record.lastError" :title="record.lastError">
              <a-typography-text type="danger" :ellipsis="true" style="max-width: 200px">{{ record.lastError }}</a-typography-text>
            </a-tooltip>
            <a-space v-else-if="deviceText(record)" :size="4">
              <a-tag v-for="d in deviceText(record)" :key="d.text" :color="d.ok ? 'green' : 'orange'">{{ d.text }}</a-tag>
            </a-space>
            <span v-else style="color: #bfbfbf">—</span>
          </template>
          <template v-else-if="column.key === 'net'">
            <a-tooltip v-if="record.proxy" :title="netTitle(record)">
              <a-tag :color="record.proxyStatus ? (record.proxyStatus.ok ? 'green' : 'red') : 'default'">{{ record.proxy.type.toUpperCase() }} {{ record.proxy.host }}</a-tag>
            </a-tooltip>
            <span v-else style="color: #8c8c8c">直连</span>
          </template>
          <template v-else-if="column.key === 'spec'">
            {{ record.spec.width }}×{{ record.spec.height }}
          </template>
          <template v-else-if="column.key === 'ops'">
            <a-button size="small" type="link" :disabled="record.status !== 'running'" @click="router.push(`/instances/${record.id}`)">控制</a-button>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-card title="最近任务" size="small">
      <a-list :data-source="store.tasks.slice(0, 15)" size="small" :locale="{ emptyText: '暂无任务' }">
        <template #renderItem="{ item }">
          <a-list-item>
            <a-space wrap>
              <a-tag :color="TASK_STATUS[item.status]?.color">{{ TASK_STATUS[item.status]?.text }}</a-tag>
              <span>{{ TASK_TEXT[item.type] ?? item.type }} · {{ item.instanceName }}</span>
              <a-typography-text v-if="item.error" type="danger">{{ item.error }}</a-typography-text>
            </a-space>
            <template #extra>
              <span style="color: #8c8c8c; font-size: 12px">{{ new Date(item.createdAt).toLocaleTimeString() }}</span>
            </template>
          </a-list-item>
        </template>
      </a-list>
    </a-card>
  </a-space>

  <a-modal v-model:open="createOpen" title="创建设备" :confirm-loading="creating" ok-text="创建" @ok="submitCreate">
    <a-form layout="vertical">
      <a-form-item label="镜像">
        <a-select v-model:value="form.profile">
          <a-select-option v-for="p in profiles" :key="p.id" :value="p.id" :disabled="!p.available">
            {{ p.label }}<span v-if="!p.available" style="color: #8c8c8c">（不可用：{{ p.reason }}）</span>
          </a-select-option>
        </a-select>
      </a-form-item>
      <a-form-item label="数量" extra="一次最多 20 台；当前宿主机（4 GiB）建议总数不超过 2–3 台，Google 服务镜像每台约 1 GiB 内存">
        <a-input-number v-model:value="form.count" :min="1" :max="20" style="width: 100%" />
      </a-form-item>
      <a-form-item label="名称前缀" extra="设备名为「前缀-序号」，仅小写字母、数字、短横线">
        <a-input v-model:value="form.namePrefix" />
      </a-form-item>
      <a-form-item label="分辨率">
        <a-select v-model:value="form.preset">
          <a-select-option v-for="(_, k) in PRESETS" :key="k" :value="k">{{ k }}</a-select-option>
        </a-select>
      </a-form-item>
      <a-row :gutter="12">
        <a-col :span="8"><a-form-item label="系统语言"><a-select v-model:value="form.locale" allow-clear show-search placeholder="默认" :options="LOCALES.map((l) => ({ value: l, label: l }))" /></a-form-item></a-col>
        <a-col :span="8"><a-form-item label="时区"><a-select v-model:value="form.timezone" allow-clear show-search placeholder="默认" :options="TIMEZONES.map((z) => ({ value: z, label: z }))" /></a-form-item></a-col>
        <a-col :span="8"><a-form-item label="设备名称"><a-input v-model:value="form.deviceName" placeholder="可选" :maxlength="40" /></a-form-item></a-col>
      </a-row>
      <a-form-item label="内存上限（MiB，可选）">
        <a-input-number v-model:value="form.memoryMb" :min="1024" :max="16384" :step="512" placeholder="不限制" style="width: 100%" />
      </a-form-item>
    </a-form>
  </a-modal>
  <a-modal v-model:open="appOpen" :title="`${appMode === 'install' ? '批量安装/更新应用' : '批量卸载应用'}（${selectedKeys.length} 台）`" :confirm-loading="appBusy" :ok-text="appMode === 'install' ? '安装' : '卸载'" :ok-button-props="{ danger: appMode === 'uninstall' }" @ok="submitApp">
    <template v-if="appMode === 'install'">
      <a-upload-dragger accept=".apk,.apks,.xapk,.apkm,.zip" :multiple="false" :show-upload-list="false" :before-upload="pickFile as any">
        <p style="margin: 12px 0">{{ appFile ? `${appFile.name}（${(appFile.size / 1048576).toFixed(1)} MB）` : '选择 .apk 或拆分包 .apks / .xapk / .apkm' }}</p>
      </a-upload-dragger>
      <div style="color: #8c8c8c; font-size: 12px; margin-top: 8px">仅安装到已运行的设备；同包名再次安装即为更新，应用数据保留。</div>
    </template>
    <a-input v-else v-model:value="appPkg" placeholder="包名，如 com.instagram.android" />
  </a-modal>
</template>
