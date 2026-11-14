<script setup lang="ts">
import { message } from 'ant-design-vue'
import { computed, ref } from 'vue'
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
    const r = await store.installApk(props.id, opt.file)
    message.success(`已上传 ${opt.file.name}，正在安装`)
    opt.onSuccess?.(r)
  } catch (e) {
    message.error((e as Error).message)
    opt.onError?.(e as Error)
  } finally {
    uploading.value = false
  }
}

async function act(a: 'start' | 'stop' | 'restart') {
  try {
    const r = await store.action(a, [props.id])
    if (r.skipped.length) message.warning(r.skipped[0]!.reason)
  } catch (e) {
    message.error((e as Error).message)
  }
}

const TASK_TEXT: Record<string, string> = { create: '创建', start: '启动', stop: '停止', restart: '重启', delete: '删除', 'install-apk': '安装 APK' }
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
            <a-space v-if="auth.canOperate">
              <a-button size="small" :disabled="inst.status === 'running'" @click="act('start')">启动</a-button>
              <a-button size="small" :disabled="inst.status !== 'running'" @click="act('stop')">停止</a-button>
              <a-button size="small" @click="act('restart')">重启</a-button>
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

        <a-card v-if="auth.canOperate" size="small" title="安装 APK（YouTube / Instagram / Chrome 等）">
          <a-upload-dragger
            accept=".apk"
            :show-upload-list="false"
            :custom-request="upload as any"
            :disabled="inst.status !== 'running' || uploading"
          >
            <p style="margin: 8px 0">{{ uploading ? '上传中…' : '点击或拖拽 .apk 文件到此处（请使用官方来源的 APK）' }}</p>
          </a-upload-dragger>
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
