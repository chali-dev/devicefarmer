<script setup lang="ts">
import { DownOutlined, ExclamationCircleOutlined, MoreOutlined } from '@ant-design/icons-vue'
import { message, Modal } from 'ant-design-vue'
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { api } from '../api/client'
import { useRouter } from 'vue-router'
import { BUSY_STATUSES, TASK_TEXT, type Instance, type InstanceOwner, type Profile, type Task } from '../api/types'
import DeviceLogDrawer from '../components/DeviceLogDrawer.vue'
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

const columns = computed(() => [
  { title: '名称', dataIndex: 'name', key: 'name' },
  { title: '镜像', key: 'profile', width: 190 },
  { title: '状态', key: 'status', width: 110 },
  ...(auth.isAdmin ? [{ title: '所属用户', key: 'owners', width: 200 }] : []),
  { title: '设备', key: 'device', width: 220 },
  { title: '网络', key: 'net', width: 170 },
  { title: 'ADB 端口', dataIndex: 'adbPort', key: 'adbPort', width: 100 },
  { title: '分辨率', key: 'spec', width: 140 },
  { title: '', key: 'ops', width: 170, align: 'right' as const },
])

// ---- owner filter (admin only)
const ownerFilter = ref<InstanceOwner | null>(null)
const rows = computed(() => {
  const f = ownerFilter.value
  return f ? store.list.filter((i) => i.owners?.some((o) => o.id === f.id)) : store.list
})
function filterByOwner(o: InstanceOwner) {
  ownerFilter.value = o
  const visible = new Set(rows.value.map((i) => i.id))
  selectedKeys.value = selectedKeys.value.filter((k) => visible.has(k))
}
const ownerName = (o: InstanceOwner) => o.displayName ? `${o.username}（${o.displayName}）` : o.username

// ---- actions menu (row and batch)
type MenuKey = Action | 'install' | 'uninstall'
const isBusy = (i: Instance) => BUSY_STATUSES.includes(i.status)
/** Whether an action makes sense for this device's current status. */
function canDo(key: MenuKey, i: Instance) {
  if (isBusy(i)) return false
  if (key === 'start') return i.status !== 'running'
  if (key === 'stop' || key === 'restart') return i.status !== 'stopped'
  if (key === 'install' || key === 'uninstall') return i.status === 'running'
  return true
}
function onMenu(key: MenuKey, ids: string[]) {
  if (key === 'install' || key === 'uninstall') openApp(key, ids)
  else void run(key, ids)
}

async function run(action: Action, ids: string[]) {
  if (!ids.length) return
  const go = async () => {
    try {
      const r = await store.action(action, ids)
      if (r.accepted.length) message.success(`已提交 ${r.accepted.length} 个${ACTION_TEXT[action]}任务`)
      if (r.skipped.length) message.warning(`跳过 ${r.skipped.length} 个：${[...new Set(r.skipped.map((s) => s.reason))].join('，')}`)
      if (action === 'delete') selectedKeys.value = selectedKeys.value.filter((k) => !ids.includes(k))
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
const appIds = ref<string[]>([])
function openApp(mode: 'install' | 'uninstall', ids: string[]) {
  if (!ids.length) return
  appMode.value = mode; appIds.value = [...ids]; appFile.value = null; appPkg.value = ''; appOpen.value = true
}
function pickFile(f: File) { appFile.value = f; return false }
async function submitApp() {
  appBusy.value = true
  try {
    const r = appMode.value === 'install'
      ? await (appFile.value ? store.installApp(appIds.value, appFile.value) : Promise.reject(new Error('请选择安装包')))
      : await (appPkg.value ? store.uninstallApp(appIds.value, appPkg.value.trim()) : Promise.reject(new Error('请输入包名')))
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

// ---- per-device log drawer
const logOpen = ref(false)
const logId = ref<string | null>(null)
const logInstance = computed(() => (logId.value ? store.byId.get(logId.value) ?? null : null))
function openLog(id: string) { logId.value = id; logOpen.value = true }

// ---- failed tasks in the last 24 h (visible devices only)
const now = ref(Date.now())
const tick = setInterval(() => (now.value = Date.now()), 60_000)
onUnmounted(() => clearInterval(tick))
const failedTasks = computed(() => store.tasks.filter((t) =>
  t.status === 'failed' && t.instanceId && store.byId.has(t.instanceId) && now.value - Date.parse(t.createdAt) < 86_400_000))
const failedAt = (t: Task) => Date.parse(t.finishedAt ?? t.createdAt)
const newestFailure = computed(() => Math.max(0, ...failedTasks.value.map(failedAt)))
const SEEN_KEY = 'devicefarmer.failedTasksSeenAt'
function readSeen() { try { return Number(localStorage.getItem(SEEN_KEY)) || 0 } catch { return 0 } }
const seenAt = ref(readSeen())
const showFailed = computed(() => failedTasks.value.length > 0 && newestFailure.value > seenAt.value)
function dismissFailed() {
  seenAt.value = newestFailure.value
  try { localStorage.setItem(SEEN_KEY, String(seenAt.value)) } catch { /* private mode: hide for this session only */ }
}
const failedOpen = ref(false)
const failedColumns = [
  { title: '时间', key: 'time', width: 170 },
  { title: '设备', key: 'device', width: 120 },
  { title: '操作', key: 'type', width: 120 },
  { title: '错误', key: 'error' },
]
watch(showFailed, (v) => { if (!v) failedOpen.value = false })
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
          <a-dropdown :disabled="!selectedKeys.length" :trigger="['click']">
            <a-button :disabled="!selectedKeys.length">批量操作{{ selectedKeys.length ? `（${selectedKeys.length}）` : '' }} <DownOutlined /></a-button>
            <template #overlay>
              <a-menu @click="({ key }: any) => onMenu(key as MenuKey, selectedKeys)">
                <a-menu-item key="start">启动</a-menu-item>
                <a-menu-item key="stop">停止</a-menu-item>
                <a-menu-item key="restart">重启</a-menu-item>
                <a-menu-item key="install">安装应用</a-menu-item>
                <a-menu-item key="uninstall">卸载应用</a-menu-item>
                <template v-if="auth.isAdmin">
                  <a-menu-divider />
                  <a-menu-item key="delete" danger>删除</a-menu-item>
                </template>
              </a-menu>
            </template>
          </a-dropdown>
          <a-button v-if="auth.isAdmin" type="primary" @click="createOpen = true">创建设备</a-button>
          <a-button :loading="store.loading" @click="store.refresh()">刷新</a-button>
        </a-space>
      </template>

      <a-alert v-if="showFailed" type="error" show-icon style="margin-bottom: 12px">
        <template #icon><ExclamationCircleOutlined /></template>
        <template #message>最近 24 小时有 {{ failedTasks.length }} 个任务失败</template>
        <template #action>
          <a-space>
            <a-button size="small" type="link" @click="failedOpen = true">查看</a-button>
            <a-button size="small" type="text" @click="dismissFailed">忽略</a-button>
          </a-space>
        </template>
      </a-alert>
      <div v-if="ownerFilter" style="margin-bottom: 12px">
        <span style="color: #8c8c8c; margin-right: 8px">筛选：</span>
        <a-tag closable color="blue" @close="ownerFilter = null">所属用户 {{ ownerFilter.username }}</a-tag>
      </div>
      <a-table
        :data-source="rows"
        :columns="columns"
        row-key="id"
        size="middle"
        :pagination="false"
        :scroll="{ x: auth.isAdmin ? 1200 : 1000 }"
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
          <template v-else-if="column.key === 'owners'">
            <span v-if="!record.owners?.length" style="color: #bfbfbf">—</span>
            <a-tooltip v-else :title="record.owners.length > 3 ? record.owners.map(ownerName).join('、') : undefined">
              <span>
                <a-tag v-for="o in record.owners.slice(0, 3)" :key="o.id" style="cursor: pointer" @click="filterByOwner(o)">{{ o.username }}</a-tag>
                <a-tag v-if="record.owners.length > 3">+{{ record.owners.length - 3 }}</a-tag>
              </span>
            </a-tooltip>
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
            <a-space :size="0">
              <a-button size="small" type="link" :disabled="record.status !== 'running'" @click="router.push(`/instances/${record.id}`)">控制</a-button>
              <a-button size="small" type="link" @click="openLog(record.id)">日志</a-button>
              <a-dropdown :trigger="['click']" placement="bottomRight">
                <a-button size="small" type="text"><MoreOutlined /></a-button>
                <template #overlay>
                  <a-menu @click="({ key }: any) => onMenu(key as MenuKey, [record.id])">
                    <a-menu-item key="start" :disabled="!canDo('start', record as Instance)">启动</a-menu-item>
                    <a-menu-item key="stop" :disabled="!canDo('stop', record as Instance)">停止</a-menu-item>
                    <a-menu-item key="restart" :disabled="!canDo('restart', record as Instance)">重启</a-menu-item>
                    <a-menu-item key="install" :disabled="!canDo('install', record as Instance)">安装应用</a-menu-item>
                    <a-menu-item key="uninstall" :disabled="!canDo('uninstall', record as Instance)">卸载应用</a-menu-item>
                    <template v-if="auth.isAdmin">
                      <a-menu-divider />
                      <a-menu-item key="delete" danger :disabled="!canDo('delete', record as Instance)">删除</a-menu-item>
                    </template>
                  </a-menu>
                </template>
              </a-dropdown>
            </a-space>
          </template>
        </template>
      </a-table>
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
  <a-modal v-model:open="appOpen" :title="`${appMode === 'install' ? '安装/更新应用' : '卸载应用'}（${appIds.length === 1 ? store.byId.get(appIds[0]!)?.name : `${appIds.length} 台`}）`" :confirm-loading="appBusy" :ok-text="appMode === 'install' ? '安装' : '卸载'" :ok-button-props="{ danger: appMode === 'uninstall' }" @ok="submitApp">
    <template v-if="appMode === 'install'">
      <a-upload-dragger accept=".apk,.apks,.xapk,.apkm,.zip" :multiple="false" :show-upload-list="false" :before-upload="pickFile as any">
        <p style="margin: 12px 0">{{ appFile ? `${appFile.name}（${(appFile.size / 1048576).toFixed(1)} MB）` : '选择 .apk 或拆分包 .apks / .xapk / .apkm' }}</p>
      </a-upload-dragger>
      <div style="color: #8c8c8c; font-size: 12px; margin-top: 8px">仅安装到已运行的设备；同包名再次安装即为更新，应用数据保留。</div>
    </template>
    <a-input v-else v-model:value="appPkg" placeholder="包名，如 com.instagram.android" />
  </a-modal>

  <a-modal v-model:open="failedOpen" title="最近 24 小时失败的任务" :footer="null" :width="760">
    <a-table :data-source="failedTasks" :columns="failedColumns" row-key="id" size="small" :pagination="{ pageSize: 10, size: 'small', hideOnSinglePage: true }">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'time'">{{ new Date(record.createdAt).toLocaleString() }}</template>
        <template v-else-if="column.key === 'device'">
          <a @click="failedOpen = false; router.push(`/instances/${record.instanceId}`)">{{ store.byId.get(record.instanceId)?.name ?? record.instanceName }}</a>
        </template>
        <template v-else-if="column.key === 'type'">{{ TASK_TEXT[record.type] ?? record.type }}</template>
        <template v-else-if="column.key === 'error'">
          <a-typography-text type="danger" :ellipsis="{ tooltip: record.error }" :content="record.error ?? '—'" />
        </template>
      </template>
    </a-table>
  </a-modal>

  <DeviceLogDrawer v-model:open="logOpen" :instance="logInstance" />
</template>
