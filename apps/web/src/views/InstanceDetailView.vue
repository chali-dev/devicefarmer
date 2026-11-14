<script setup lang="ts">
import { message, Modal } from 'ant-design-vue'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { api, getToken } from '../api/client'
import type { InstalledApp } from '../api/types'
import { useRouter } from 'vue-router'
import DevicePlayer from '../components/DevicePlayer.vue'
import StatusTag from '../components/StatusTag.vue'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

const props = defineProps<{ id: string }>()
const store = useInstancesStore()
const auth = useAuthStore()
const router = useRouter()
const player = ref<InstanceType<typeof DevicePlayer> | null>(null)

const inst = computed(() => store.byId.get(props.id))
const tasks = computed(() => store.tasks.filter((t) => t.instanceId === props.id).slice(0, 10))
const text = ref('')
const secure = ref(false)
const uploading = ref(false)
const checking = ref(false)
const google = computed(() => inst.value?.google ?? null)

function sendText() {
  if (!text.value) return
  // Secure mode: per-character key events, nothing on the device clipboard, nothing stored.
  if (secure.value) player.value?.typeSecure(text.value)
  else player.value?.paste(text.value)
  text.value = ''
}

async function checkGoogle() {
  checking.value = true
  try { await store.googleCheck(props.id) } catch (e) { message.error((e as Error).message) } finally { checking.value = false }
}

async function copyGsf() {
  if (!google.value?.gsf.gsfId) return
  try { await navigator.clipboard.writeText(google.value.gsf.gsfId); message.success('已复制 GSF ID') }
  catch { message.warning('复制失败，请手动选择复制') }
}

async function upload(opt: { file: File; onSuccess?: (r: unknown) => void; onError?: (e: Error) => void }) {
  uploading.value = true
  try {
    const r = await store.installApp([props.id], opt.file)
    message.success(`已上传 ${opt.file.name}（${r.apks} 个 APK），正在安装`)
    opt.onSuccess?.(r)
  } catch (e) {
    message.error((e as Error).message)
    opt.onError?.(e as Error)
  } finally {
    uploading.value = false
  }
}

// ---- installed apps
const appsList = ref<InstalledApp[]>([])
const appsLoading = ref(false)
async function loadApps() {
  if (inst.value?.status !== 'running') return
  appsLoading.value = true
  try { appsList.value = (await api<{ apps: InstalledApp[] }>('GET', `/api/instances/${props.id}/apps`)).apps }
  catch (e) { message.error((e as Error).message) }
  finally { appsLoading.value = false }
}
function uninstall(pkg: string) {
  Modal.confirm({
    title: `卸载 ${pkg}？`, content: '应用及其数据将从该设备删除。', okType: 'danger', okText: '卸载',
    onOk: async () => {
      try { await store.uninstallApp([props.id], pkg); message.success('已提交卸载任务') }
      catch (e) { message.error((e as Error).message) }
    },
  })
}
// refresh the list when an install/uninstall task for this instance finishes
watch(() => tasks.value.filter((t) => (t.type === 'install-apk' || t.type === 'uninstall-app') && t.status === 'succeeded').length, () => void loadApps())
watch(() => inst.value?.status, (s) => { if (s === 'running') void loadApps() }, { immediate: true })

// ---- device settings (system settings only; hardware identity is not configurable)
const settingsForm = reactive({ locale: '', timezone: '', deviceName: '' })
const actual = ref<Record<string, string> | null>(null)
const savingSettings = ref(false)
const TIMEZONES = Intl.supportedValuesOf('timeZone')
const LOCALES = ['zh-CN', 'zh-TW', 'zh-HK', 'en-US', 'en-GB', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES', 'pt-BR', 'ru-RU', 'ar-SA', 'th-TH', 'vi-VN', 'id-ID']
async function loadSettings() {
  try {
    const r = await api<{ configured: Record<string, string | undefined>; actual: Record<string, string> | null }>('GET', `/api/instances/${props.id}/settings`)
    actual.value = r.actual
    settingsForm.locale = r.configured.locale ?? r.actual?.locale ?? ''
    settingsForm.timezone = r.configured.timezone ?? r.actual?.timezone ?? ''
    settingsForm.deviceName = r.configured.deviceName ?? ''
  } catch { /* shown as empty */ }
}
async function saveSettings() {
  savingSettings.value = true
  try {
    const body = Object.fromEntries(Object.entries(settingsForm).filter(([, v]) => v)) as Record<string, string>
    const r = await store.updateSettings(props.id, body)
    message.success(r.taskId ? '已提交，正在应用（修改语言会重启 Android 界面，约 30 秒）' : '已保存，下次启动时生效')
  } catch (e) { message.error((e as Error).message) }
  finally { savingSettings.value = false }
}
watch(() => tasks.value.find((t) => t.type === 'apply-settings')?.status, (s) => { if (s === 'succeeded') void loadSettings() })
onMounted(loadSettings)

// ---- screenshot (full resolution PNG from the device)
const shooting = ref(false)
async function screenshot() {
  shooting.value = true
  try {
    const res = await fetch(`/api/instances/${props.id}/screenshot`, { headers: { authorization: `Bearer ${getToken()}` } })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `截图失败 (${res.status})`)
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = `${inst.value?.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) { message.error((e as Error).message) }
  finally { shooting.value = false }
}

async function act(a: 'start' | 'stop' | 'restart') {
  try {
    const r = await store.action(a, [props.id])
    if (r.skipped.length) message.warning(r.skipped[0]!.reason)
  } catch (e) {
    message.error((e as Error).message)
  }
}

const TASK_TEXT: Record<string, string> = { create: '创建', start: '启动', stop: '停止', restart: '重启', delete: '删除', 'install-apk': '安装/更新应用', 'uninstall-app': '卸载应用', 'apply-settings': '应用设备参数' }
const TASK_COLOR: Record<string, string> = { queued: 'default', running: 'processing', succeeded: 'success', failed: 'error' }
</script>

<template>
  <a-result v-if="!inst && !store.loading" status="404" title="实例不存在或无权访问">
    <template #extra><a-button @click="router.push('/instances')">返回列表</a-button></template>
  </a-result>

  <a-row v-else-if="inst" :gutter="[24, 24]">
    <a-col :xs="24" :lg="11" :xl="9">
      <a-card size="small" :body-style="{ padding: '20px 12px' }">
        <DevicePlayer
          v-if="inst.status === 'running'"
          ref="player"
          :key="`${inst.id}-${inst.containerId}`"
          :instance-id="inst.id"
          :width="inst.spec.width"
          :height="inst.spec.height"
        />
        <a-empty v-else :description="`实例当前状态：${inst.status}，运行后才能远程控制`" />
      </a-card>
    </a-col>

    <a-col :xs="24" :lg="13" :xl="15">
      <a-space direction="vertical" size="middle" style="width: 100%">
        <a-card size="small">
          <template #title>
            <a-space><a @click="router.push('/instances')">实例</a><span>/</span><span>{{ inst.name }}</span></a-space>
          </template>
          <template #extra>
            <a-space>
              <a-button size="small" :loading="shooting" :disabled="inst.status !== 'running'" @click="screenshot">截图</a-button>
              <template v-if="auth.canOperate">
              <a-button size="small" :disabled="inst.status === 'running'" @click="act('start')">启动</a-button>
              <a-button size="small" :disabled="inst.status !== 'running'" @click="act('stop')">停止</a-button>
              <a-button size="small" @click="act('restart')">重启</a-button>
              </template>
            </a-space>
          </template>
          <a-descriptions :column="{ xs: 1, sm: 2 }" size="small">
            <a-descriptions-item label="状态"><StatusTag :status="inst.status" /></a-descriptions-item>
            <a-descriptions-item label="引擎">{{ inst.engine }} · {{ inst.profile }}</a-descriptions-item>
            <a-descriptions-item label="系统启动">{{ inst.bootCompleted ? '完成' : '未完成' }}</a-descriptions-item>
            <a-descriptions-item label="ADB">{{ inst.adbState ?? '—' }}</a-descriptions-item>
            <a-descriptions-item label="STF">{{ inst.stfReady ? '就绪' : '未就绪' }}</a-descriptions-item>
            <a-descriptions-item label="ADB 端口">{{ inst.adbPort }}</a-descriptions-item>
            <a-descriptions-item label="分辨率">{{ inst.spec.width }}×{{ inst.spec.height }} @ {{ inst.spec.dpi }}dpi</a-descriptions-item>
            <a-descriptions-item label="镜像"><a-typography-text :ellipsis="true" style="max-width: 260px">{{ inst.image }}</a-typography-text></a-descriptions-item>
          </a-descriptions>
          <a-alert v-if="inst.lastError" type="error" :message="inst.lastError" show-icon style="margin-top: 8px" />
        </a-card>

        <a-card v-if="inst.google || inst.profile.includes('gapps') || inst.engine === 'emulator'" size="small" title="Google 服务">
          <template #extra>
            <a-space>
              <a-button size="small" :loading="checking" :disabled="inst.status !== 'running'" @click="checkGoogle">立即检查</a-button>
            </a-space>
          </template>
          <template v-if="google">
            <a-space wrap style="margin-bottom: 8px">
              <a-tag :color="google.gms.running ? 'green' : google.gms.installed ? 'orange' : 'red'">GMS {{ google.gms.version?.split(' ')[0] ?? '未安装' }}{{ google.gms.installed && !google.gms.running ? '（未运行）' : '' }}</a-tag>
              <a-tag :color="google.gsf.installed ? 'green' : 'red'">GSF {{ google.gsf.installed ? '已安装' : '未安装' }}</a-tag>
              <a-tooltip title="不用于安装应用，仅作为 Google Play 服务的后台更新通道"><a-tag :color="google.playStore.installed ? 'default' : 'orange'">GMS 更新通道 {{ google.playStore.installed ? '正常' : '缺失' }}</a-tag></a-tooltip>
              <a-tag :color="google.youtube.installed ? 'green' : 'default'">YouTube {{ google.youtube.installed ? google.youtube.version : '未安装' }}</a-tag>
              <a-tag v-if="google.youtube.playing" color="blue">YouTube 播放中</a-tag>
              <a-tag :color="google.googleAccounts ? 'green' : 'default'">{{ google.googleAccounts ? `已登录 ${google.googleAccounts} 个 Google 账号` : '未登录 Google 账号' }}</a-tag>
            </a-space>
            <a-descriptions :column="1" size="small">
              <a-descriptions-item label="GSF ID">
                <template v-if="google.gsf.gsfId">
                  <a-typography-text code>{{ google.gsf.gsfId }}</a-typography-text>
                  <a-button type="link" size="small" @click="copyGsf">复制</a-button>
                </template>
                <span v-else style="color: #8c8c8c">尚未生成（GMS 联网完成签到后出现）</span>
              </a-descriptions-item>
              <a-descriptions-item label="检查时间">{{ new Date(google.checkedAt).toLocaleString() }}</a-descriptions-item>
            </a-descriptions>
            <a-alert v-if="!google.googleAccounts" type="info" show-icon style="margin-top: 8px">
              <template #message>登录 Google 账号前</template>
              <template #description>
                本设备未经 Google 认证。请先用你自己的 Google 账号在
                <a href="https://www.google.com/android/uncertified" target="_blank" rel="noopener noreferrer">google.com/android/uncertified</a>
                登记上面的 GSF ID，等待几分钟后再在左侧画面中登录。输入密码时请打开下方「安全输入」。
              </template>
            </a-alert>
          </template>
          <a-empty v-else description="尚未检查，启动后约 1 分钟内自动检查" />
        </a-card>

        <a-card size="small" title="输入文本">
          <template #extra>
            <a-tooltip title="逐字符发送按键，不经过设备剪贴板，平台不记录内容。用于输入密码。">
              <a-space :size="4"><a-switch v-model:checked="secure" size="small" />安全输入</a-space>
            </a-tooltip>
          </template>
          <a-input-password v-if="secure" v-model:value="text" placeholder="先在画面中点选密码框，再在此输入并发送" :disabled="inst.status !== 'running'" autocomplete="off" @press-enter="sendText">
            <template #addonAfter><a @click="sendText">发送</a></template>
          </a-input-password>
          <a-input-search
            v-else
            v-model:value="text"
            placeholder="先在画面中点选输入框，再在此输入并发送（通过剪贴板粘贴，支持中文）"
            enter-button="发送"
            :disabled="inst.status !== 'running'"
            @search="sendText"
          />
          <div class="hint">{{ secure ? '安全输入：逐字符发送（较慢，仅支持键盘可输入的字符）。' : '也可以点击画面后直接用键盘输入；右键画面 = 返回键。注意：普通发送会经过设备剪贴板，不要用它输入密码。' }}</div>
        </a-card>

        <a-card size="small" title="应用管理">
          <template #extra>
            <a-button size="small" :loading="appsLoading" :disabled="inst.status !== 'running'" @click="loadApps">刷新</a-button>
          </template>
          <a-upload-dragger
            v-if="auth.canOperate"
            accept=".apk,.apks,.xapk,.apkm,.zip"
            :show-upload-list="false"
            :custom-request="upload as any"
            :disabled="inst.status !== 'running' || uploading"
            style="margin-bottom: 12px"
          >
            <p style="margin: 8px 0">{{ uploading ? '上传中…' : '安装 / 更新：拖拽 .apk 或拆分包（.apks / .xapk / .apkm）到此处' }}</p>
            <p class="hint" style="margin: 0 0 8px">YouTube、Instagram、Facebook、Chrome 等请使用官方来源的安装包；同包名再次上传即为更新</p>
          </a-upload-dragger>
          <a-table :data-source="appsList" row-key="package" size="small" :pagination="false" :loading="appsLoading"
            :locale="{ emptyText: inst.status === 'running' ? '没有用户安装的应用' : '实例未运行' }"
            :columns="[{ title: '包名', dataIndex: 'package', key: 'package' }, { title: '版本', key: 'version', width: 160 }, { title: '', key: 'ops', width: 90 }]">
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'version'">{{ record.versionName ?? '—' }}</template>
              <template v-else-if="column.key === 'ops'">
                <a-tag v-if="record.protected">平台组件</a-tag>
                <a-button v-else-if="auth.canOperate" type="link" size="small" danger @click="uninstall(record.package)">卸载</a-button>
              </template>
            </template>
          </a-table>
        </a-card>

        <a-card size="small" title="设备参数">
          <a-form layout="vertical" :disabled="!auth.canOperate || ['creating', 'starting', 'stopping', 'restarting', 'deleting'].includes(inst.status)">
            <a-row :gutter="12">
              <a-col :xs="24" :sm="8">
                <a-form-item label="系统语言">
                  <a-select v-model:value="settingsForm.locale" show-search allow-clear placeholder="默认" :options="LOCALES.map((l) => ({ value: l, label: l }))" />
                </a-form-item>
              </a-col>
              <a-col :xs="24" :sm="8">
                <a-form-item label="时区">
                  <a-select v-model:value="settingsForm.timezone" show-search allow-clear placeholder="默认" :options="TIMEZONES.map((z) => ({ value: z, label: z }))" />
                </a-form-item>
              </a-col>
              <a-col :xs="24" :sm="8">
                <a-form-item label="设备名称">
                  <a-input v-model:value="settingsForm.deviceName" placeholder="如 Phone-01" :maxlength="40" />
                </a-form-item>
              </a-col>
            </a-row>
            <a-space wrap>
              <a-button v-if="auth.canOperate" type="primary" size="small" :loading="savingSettings" @click="saveSettings">保存并应用</a-button>
              <span v-if="actual" class="hint">当前：{{ actual.locale || '默认语言' }} · {{ actual.timezone }} · Android {{ actual.release }} · 型号 {{ actual.model }}（型号/IMEI 等硬件标识不可修改）</span>
            </a-space>
          </a-form>
        </a-card>

        <a-card size="small" title="任务记录">
          <a-list :data-source="tasks" size="small" :locale="{ emptyText: '暂无任务' }">
            <template #renderItem="{ item }">
              <a-list-item>
                <a-space wrap>
                  <a-badge :status="TASK_COLOR[item.status] as any" :text="TASK_TEXT[item.type] ?? item.type" />
                  <a-typography-text v-if="item.error" type="danger">{{ item.error }}</a-typography-text>
                </a-space>
                <template #extra><span class="time">{{ new Date(item.createdAt).toLocaleString() }}</span></template>
              </a-list-item>
            </template>
          </a-list>
        </a-card>
      </a-space>
    </a-col>
  </a-row>
</template>

<style scoped>
.hint { color: #8c8c8c; font-size: 12px; margin-top: 8px; }
.time { color: #8c8c8c; font-size: 12px; }
</style>
