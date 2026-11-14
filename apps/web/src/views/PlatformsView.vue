<script setup lang="ts">
import { CheckOutlined, MinusOutlined } from '@ant-design/icons-vue'
import { message, Modal } from 'ant-design-vue'
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import type { PlatformAppSettings, PlatformCapabilities, PlatformInfo } from '../api/types'
import PlatformTag from '../components/social/PlatformTag.vue'

/** 平台接入 (admin): official API app credentials per platform. The client secret is write-only. */
const { t } = useI18n()
const apps = ref<PlatformAppSettings[]>([])
const infos = ref<PlatformInfo[]>([])
const caps = (id: string) => infos.value.find((p) => p.id === id)?.capabilities
const loading = ref(false)
const saving = ref<string | null>(null)
const forms = reactive<Record<string, { clientId: string; clientSecret: string; directPost: boolean }>>({})

const CAPS: (keyof PlatformCapabilities)[] = ['publishVideo', 'publishImage', 'publishCarousel', 'commentsRead', 'commentsReply', 'profileStats']

function fill(a: PlatformAppSettings) {
  forms[a.platform] = { clientId: a.clientId ?? '', clientSecret: '', directPost: Boolean(a.options.directPost) }
}

async function load() {
  loading.value = true
  try {
    const [a, p] = await Promise.all([
      api<{ apps: PlatformAppSettings[] }>('GET', '/api/settings/platforms'),
      api<{ platforms: PlatformInfo[] }>('GET', '/api/platforms'),
    ])
    apps.value = a.apps
    infos.value = p.platforms
    apps.value.forEach(fill)
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
onMounted(load)

async function put(a: PlatformAppSettings, body: Record<string, unknown>, done: string) {
  saving.value = a.platform
  try {
    const r = await api<{ app: PlatformAppSettings }>('PUT', `/api/settings/platforms/${a.platform}`, body)
    apps.value = apps.value.map((x) => (x.platform === a.platform ? r.app : x))
    fill(r.app)
    infos.value = (await api<{ platforms: PlatformInfo[] }>('GET', '/api/platforms')).platforms
    message.success(done)
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = null }
}

function save(a: PlatformAppSettings) {
  const f = forms[a.platform]!
  const body: Record<string, unknown> = { clientId: f.clientId.trim() }
  if (f.clientSecret.trim()) body.clientSecret = f.clientSecret.trim()
  if (a.platform === 'tiktok') body.options = { directPost: f.directPost }
  void put(a, body, t('common.saved'))
}

function clearSecret(a: PlatformAppSettings) {
  Modal.confirm({
    title: t('platforms.confirmClearSecret', { name: a.name }), okType: 'danger', okText: t('common.ok'), cancelText: t('common.cancel'),
    onOk: () => put(a, { clientSecret: null }, t('platforms.secretCleared')),
  })
}

function removeApp(a: PlatformAppSettings) {
  Modal.confirm({
    title: t('platforms.confirmRemove', { name: a.name }), content: t('platforms.removeHint'), okType: 'danger', okText: t('common.delete'), cancelText: t('common.cancel'),
    onOk: () => put(a, { clientId: null }, t('common.deleted')),
  })
}

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); message.success(t('platforms.copied')) } catch { message.info(text) }
}
</script>

<template>
  <a-card :title="t('platforms.title')" size="small" :loading="loading">
    <a-alert type="info" show-icon style="margin-bottom: 16px" :message="t('platforms.intro')" :description="t('platforms.introDetail')" />
    <a-row :gutter="[16, 16]">
      <a-col v-for="a in apps" :key="a.platform" :xs="24" :lg="12" :xxl="8">
        <a-card size="small" class="app-card">
          <template #title>
            <a-space>
              <PlatformTag :platform="a.platform" :name="a.name" />
              <a-tag :color="a.configured ? 'green' : 'default'">{{ a.configured ? t('platforms.configured') : t('platforms.notConfigured') }}</a-tag>
            </a-space>
          </template>
          <p class="muted small">{{ t(`platforms.hint.${a.platform}`) }}</p>
          <a-form v-if="forms[a.platform]" layout="vertical" size="small">
            <a-form-item :label="a.platform === 'tiktok' ? 'Client Key' : 'Client ID'">
              <a-input v-model:value="forms[a.platform]!.clientId" autocomplete="off" />
            </a-form-item>
            <a-form-item label="Client Secret" :extra="t('platforms.secretHint')">
              <a-input-password
                v-model:value="forms[a.platform]!.clientSecret" autocomplete="new-password"
                :placeholder="a.clientSecretSet ? t('platforms.secretKeep') : t('platforms.secretEnter')"
              />
            </a-form-item>
            <a-form-item :label="t('platforms.redirectUri')" :extra="t('platforms.redirectHint')">
              <a-input-group compact style="display: flex">
                <a-input :value="a.redirectUri" readonly style="flex: 1" />
                <a-button @click="copy(a.redirectUri)">{{ t('platforms.copy') }}</a-button>
              </a-input-group>
            </a-form-item>
            <a-form-item v-if="a.platform === 'tiktok'" :extra="t('platforms.directPostHint')">
              <a-checkbox v-model:checked="forms[a.platform]!.directPost">{{ t('platforms.directPost') }}</a-checkbox>
            </a-form-item>
            <a-form-item :label="t('platforms.scopes')">
              <a-tag v-for="s in a.scopes" :key="s" class="scope">{{ s.replace('https://www.googleapis.com/auth/', '') }}</a-tag>
            </a-form-item>
            <a-form-item :label="t('platforms.capabilities')">
              <div class="caps">
                <span v-for="c in CAPS" :key="c" :class="['cap', { off: !caps(a.platform)?.[c] }]">
                  <CheckOutlined v-if="caps(a.platform)?.[c]" />
                  <MinusOutlined v-else />
                  {{ t(`platforms.cap.${c}`) }}
                </span>
              </div>
              <div v-if="a.platform === 'tiktok'" class="muted small">{{ forms[a.platform]!.directPost ? t('platforms.tiktokDirect') : t('platforms.tiktokInbox') }}</div>
              <div v-if="a.platform === 'instagram'" class="muted small">{{ t('platforms.instagramMedia') }}</div>
            </a-form-item>
            <a-space wrap>
              <a-button type="primary" :loading="saving === a.platform" :disabled="!forms[a.platform]!.clientId.trim()" @click="save(a)">{{ t('common.save') }}</a-button>
              <a-button v-if="a.clientSecretSet" @click="clearSecret(a)">{{ t('platforms.clearSecret') }}</a-button>
              <a-button v-if="a.clientId" danger @click="removeApp(a)">{{ t('common.delete') }}</a-button>
              <span v-if="a.updatedAt" class="muted small">{{ t('platforms.updatedAt', { at: new Date(a.updatedAt).toLocaleString() }) }}</span>
            </a-space>
          </a-form>
        </a-card>
      </a-col>
    </a-row>
  </a-card>
</template>

<style scoped>
.muted { color: var(--cp-text-secondary); }
.small { font-size: 12px; }
.app-card { height: 100%; }
.scope { margin-bottom: 4px; font-family: monospace; font-size: 12px; }
.caps { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.cap { color: var(--cp-text); white-space: nowrap; }
.cap.off { color: var(--cp-text-quaternary); }
</style>
