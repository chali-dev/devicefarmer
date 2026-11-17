<script setup lang="ts">
import { dateLocale } from '../../i18n'
import { CheckOutlined, CopyOutlined, MinusOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { PlatformAppSettings, PlatformCapabilities } from '../../api/types'
import { usePlatformsStore } from '../../stores/platforms'
import { confirmDanger } from '../common/ui'
import PlatformTag from '../social/PlatformTag.vue'

/** Settings → 平台接入 (admin): official API app credentials per platform. The client secret is write-only. */
const { t } = useI18n()
const apps = ref<PlatformAppSettings[]>([])
const platforms = usePlatformsStore()
const caps = (id: string) => platforms.scope.platforms.find((p) => p.id === id)?.capabilities
const loading = ref(false)
const saving = ref<string | null>(null)
const forms = reactive<Record<string, { clientId: string; clientSecret: string; directPost: boolean; accountStats: boolean }>>({})

const CAPS: (keyof PlatformCapabilities)[] = ['publishVideo', 'publishImage', 'publishCarousel', 'commentsRead', 'commentsReply', 'profileStats']

function fill(a: PlatformAppSettings) {
  forms[a.platform] = { clientId: a.clientId ?? '', clientSecret: '', directPost: Boolean(a.options.directPost), accountStats: Boolean(a.options.accountStats) }
}

async function load() {
  loading.value = true
  try {
    const [a] = await Promise.all([api<{ apps: PlatformAppSettings[] }>('GET', '/api/settings/platforms'), platforms.load(true)])
    apps.value = a.apps
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
    await platforms.load(true)
    message.success(done)
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = null }
}

function save(a: PlatformAppSettings) {
  const f = forms[a.platform]!
  const body: Record<string, unknown> = { clientId: f.clientId.trim() }
  if (f.clientSecret.trim()) body.clientSecret = f.clientSecret.trim()
  const options: Record<string, boolean> = {}
  if (a.platform === 'tiktok') options.directPost = f.directPost
  if (platforms.statsPlatforms.includes(a.platform)) options.accountStats = f.accountStats
  if (Object.keys(options).length) body.options = options
  void put(a, body, t('common.saved'))
}

function clearSecret(a: PlatformAppSettings) {
  confirmDanger({
    title: t('platforms.confirmClearSecret', { name: a.name }), okText: t('common.ok'),
    onOk: () => put(a, { clientSecret: null }, t('platforms.secretCleared')),
  })
}

function removeApp(a: PlatformAppSettings) {
  confirmDanger({
    title: t('platforms.confirmRemove', { name: a.name }), content: t('platforms.removeHint'),
    onOk: () => put(a, { clientId: null }, t('common.deleted')),
  })
}

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); message.success(t('platforms.copied')) } catch { message.info(text) }
}
</script>

<template>
  <a-spin :spinning="loading">
    <a-row :gutter="[16, 16]">
      <a-col v-for="a in apps" :key="a.platform" :xs="24" :lg="12" :xxl="8">
        <a-card size="small" class="app-card">
          <template #title>
            <a-space>
              <PlatformTag :platform="a.platform" :name="a.name" />
              <a-tag :color="a.configured ? 'green' : 'default'">{{ a.configured ? t('platforms.configured') : t('platforms.notConfigured') }}</a-tag>
            </a-space>
          </template>
          <a-typography-paragraph type="secondary" class="small">{{ t(`platforms.hint.${a.platform}`) }}</a-typography-paragraph>
          <a-form v-if="forms[a.platform]" layout="vertical">
            <a-form-item :label="a.platform === 'tiktok' ? 'Client Key' : 'Client ID'">
              <a-input v-model:value="forms[a.platform]!.clientId" autocomplete="off" />
            </a-form-item>
            <a-form-item label="Client Secret">
              <a-input-password
                v-model:value="forms[a.platform]!.clientSecret" autocomplete="new-password"
                :placeholder="a.clientSecretSet ? t('platforms.secretKeep') : t('platforms.secretEnter')"
              />
            </a-form-item>
            <a-form-item :label="t('platforms.redirectUri')" :extra="t('platforms.redirectHint')">
              <a-space-compact block>
                <a-input :value="a.redirectUri" readonly />
                <a-button @click="copy(a.redirectUri)"><template #icon><CopyOutlined /></template>{{ t('platforms.copy') }}</a-button>
              </a-space-compact>
            </a-form-item>
            <a-form-item v-if="a.platform === 'tiktok'" :extra="t('platforms.directPostHint')">
              <a-checkbox v-model:checked="forms[a.platform]!.directPost">{{ t('platforms.directPost') }}</a-checkbox>
            </a-form-item>
            <a-form-item v-if="platforms.statsPlatforms.includes(a.platform)" :extra="t('platforms.accountStatsHint')">
              <a-checkbox v-model:checked="forms[a.platform]!.accountStats">{{ t('platforms.accountStats') }}</a-checkbox>
            </a-form-item>
            <a-form-item :label="t('platforms.scopes')">
              <a-tag v-for="s in a.scopes" :key="s" class="scope mono">{{ s.replace('https://www.googleapis.com/auth/', '') }}</a-tag>
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
              <span v-if="a.updatedAt" class="muted small">{{ t('platforms.updatedAt', { at: new Date(a.updatedAt).toLocaleString(dateLocale()) }) }}</span>
            </a-space>
          </a-form>
        </a-card>
      </a-col>
    </a-row>
  </a-spin>
</template>

<style scoped>
.app-card { height: 100%; }
.scope { margin-bottom: 4px; font-size: 12px; }
.caps { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.cap { color: var(--cp-text); white-space: nowrap; }
.cap.off { color: var(--cp-text-quaternary); }
</style>
