<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { Dayjs } from 'dayjs'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { SOCIAL_LOGIN_COLOR, type Content, type PublishPlatform, type PublishTaskItem, type SocialAccount } from '../../api/types'
import { useInstancesStore } from '../../stores/instances'
import PlatformTag from '../social/PlatformTag.vue'

/**
 * Distribution step (分发): pick target accounts (grouped by platform, with device + login status),
 * optional per-account title/caption/hashtags/privacy/time, and the schedule (now or a time).
 */
const props = defineProps<{ open: boolean; content: Content | null }>()
const emit = defineEmits<{ 'update:open': [boolean]; done: [] }>()
const { t } = useI18n()
const store = useInstancesStore()

const accounts = ref<SocialAccount[]>([])
const platforms = ref<PublishPlatform[]>([])
const loading = ref(false)
const saving = ref(false)
const selected = ref<string[]>([])
interface Override { title: string; caption: string; hashtags: string[]; privacy: string | undefined; at: Dayjs | null }
const overrides = reactive<Record<string, Override>>({})
const form = reactive({ when: 'now' as 'now' | 'at', at: null as Dayjs | null, maxAttempts: 3, republish: false })

watch(() => props.open, async (o) => {
  if (!o || !props.content) return
  selected.value = []
  for (const k of Object.keys(overrides)) delete overrides[k]
  Object.assign(form, { when: 'now', at: null, maxAttempts: 3, republish: false })
  loading.value = true
  try {
    const owner = props.content.userId
    const [a, p] = await Promise.all([
      api<{ items: SocialAccount[] }>('GET', `/api/social/accounts?pageSize=200&ownerId=${owner}`),
      api<{ platforms: PublishPlatform[] }>('GET', '/api/publish/platforms'),
    ])
    accounts.value = a.items
    platforms.value = p.platforms
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
})

/** Client-side pre-check against the capability table (the API checks again). */
function incompatible(platformId: string): string | null {
  const cap = platforms.value.find((p) => p.id === platformId)?.capability
  const media = props.content?.media ?? []
  if (!cap) return null
  if (media.length < cap.media.min || media.length > cap.media.max) return t('distribute.needCount', { min: cap.media.min, max: cap.media.max, n: media.length })
  if (media.some((m) => !cap.media.kinds.includes(m.fileType))) return t('distribute.needKinds', { kinds: cap.media.kinds.map((k) => t(`media.${k}`)).join(' / ') })
  if (media.some((m) => m.status !== 'ready')) return t('distribute.notReady')
  return null
}

const groups = computed(() => {
  // Only platforms the API lists (enabled ones); accounts of disabled platforms can't be targets.
  const ids = [...new Set(accounts.value.map((a) => a.platform))].filter((id) => platforms.value.some((p) => p.id === id))
  return ids.map((id) => ({ id, name: platforms.value.find((p) => p.id === id)?.name ?? id, reason: incompatible(id), accounts: accounts.value.filter((a) => a.platform === id) }))
})
const accountById = (id: string) => accounts.value.find((a) => a.id === id)
const capOf = (platform: string) => platforms.value.find((p) => p.id === platform)?.capability
function online(a: SocialAccount): boolean {
  if (!a.instance) return false
  const live = store.byId.get(a.instance.id)
  return live ? live.status === 'running' && live.adbState === 'device' : a.instance.status === 'running'
}

function toggle(id: string, on: boolean) {
  if (on && !selected.value.includes(id)) {
    selected.value = [...selected.value, id]
    overrides[id] ??= { title: '', caption: '', hashtags: [], privacy: undefined, at: null }
  } else if (!on) selected.value = selected.value.filter((x) => x !== id)
}

const defaultCaption = (platform: string) => {
  const h = (props.content?.platformHints ?? {}) as Record<string, Record<string, string> | undefined>
  return h[platform]?.description || h[platform]?.caption || props.content?.body || ''
}
const defaultTitle = (platform: string) => (props.content?.platformHints as Record<string, Record<string, string> | undefined>)?.[platform]?.title || props.content?.title || ''

async function submit() {
  if (!props.content || !selected.value.length) return
  if (form.when === 'at' && !form.at) { message.warning(t('distribute.pickTime')); return }
  saving.value = true
  try {
    const targets = selected.value.map((id) => {
      const o = overrides[id]!
      const at = o.at ?? (form.when === 'at' ? form.at : null)
      return {
        accountId: id,
        ...(o.title.trim() ? { title: o.title.trim() } : {}),
        ...(o.caption.trim() ? { caption: o.caption } : {}),
        ...(o.hashtags.length ? { hashtags: o.hashtags } : {}),
        ...(o.privacy ? { options: { privacy: o.privacy } } : {}),
        scheduledAt: at ? at.toISOString() : null,
      }
    })
    const r = await api<{ created: PublishTaskItem[]; existing: PublishTaskItem[] }>('POST', `/api/contents/${props.content.id}/distribute`, {
      targets, maxAttempts: form.maxAttempts, republish: form.republish || undefined,
    })
    message.success(t('distribute.created', { n: r.created.length }))
    if (r.existing.length) message.info(t('distribute.existing', { n: r.existing.length }))
    emit('done')
    emit('update:open', false)
  } catch (e) { message.error(errorText(e)) } finally { saving.value = false }
}
</script>

<template>
  <a-modal :open="open" :title="t('distribute.title', { title: content?.title ?? '' })" width="860px" :confirm-loading="saving"
    :ok-text="t('distribute.submit', { n: selected.length })" :ok-button-props="{ disabled: !selected.length }" :cancel-text="t('common.cancel')"
    @ok="submit" @cancel="emit('update:open', false)">
    <a-spin :spinning="loading">
      <a-alert type="info" show-icon :message="t('distribute.methodHint')" style="margin-bottom: 12px" />
      <a-empty v-if="!loading && !accounts.length" :description="t('distribute.noAccounts')" />
      <div v-for="g in groups" :key="g.id" class="group">
        <div class="group-head">
          <PlatformTag :platform="g.id" :name="g.name" />
          <span v-if="g.reason" class="warn">{{ g.reason }}</span>
        </div>
        <div v-for="a in g.accounts" :key="a.id" class="acc">
          <a-checkbox :checked="selected.includes(a.id)" :disabled="!!g.reason" @change="(e: any) => toggle(a.id, e.target.checked)">
            <b>@{{ a.handle }}</b><span v-if="a.displayName" class="muted"> · {{ a.displayName }}</span>
          </a-checkbox>
          <a-space size="small" wrap>
            <a-tag :color="SOCIAL_LOGIN_COLOR[a.loginStatus]">{{ t(`social.login.${a.loginStatus}`) }}</a-tag>
            <a-tag v-if="a.accountStatus !== 'active'" color="error">{{ t(`social.account.${a.accountStatus}`) }}</a-tag>
            <span v-if="a.instance"><a-badge :status="online(a) ? 'success' : 'default'" />{{ a.instance.name }} · {{ online(a) ? t('distribute.online') : t('distribute.offline') }}</span>
            <span v-else class="muted">{{ t('distribute.noDevice') }}</span>
          </a-space>
        </div>
      </div>

      <template v-if="selected.length">
        <a-divider orientation="left" plain>{{ t('distribute.overrides') }}</a-divider>
        <a-collapse>
          <a-collapse-panel v-for="id in selected" :key="id">
            <template #header>
              <PlatformTag :platform="accountById(id)?.platform ?? ''" /> @{{ accountById(id)?.handle }}
            </template>
            <a-form layout="vertical">
              <a-form-item v-if="capOf(accountById(id)?.platform ?? '')?.title" :label="t('distribute.titleOverride')">
                <a-input v-model:value="overrides[id]!.title" :maxlength="capOf(accountById(id)!.platform)!.title!.max" :placeholder="defaultTitle(accountById(id)!.platform)" />
              </a-form-item>
              <a-form-item :label="t('distribute.captionOverride')" :extra="t('distribute.captionHint')">
                <a-textarea v-model:value="overrides[id]!.caption" :rows="3" :maxlength="capOf(accountById(id)?.platform ?? '')?.captionMax" show-count
                  :placeholder="defaultCaption(accountById(id)?.platform ?? '')" />
              </a-form-item>
              <a-form-item :label="t('distribute.hashtags')">
                <a-select v-model:value="overrides[id]!.hashtags" mode="tags" :placeholder="t('distribute.hashtagsPlaceholder')" :token-separators="[',', ' ']" />
              </a-form-item>
              <a-form-item v-if="capOf(accountById(id)?.platform ?? '')?.privacy" :label="t('distribute.privacy')">
                <a-select v-model:value="overrides[id]!.privacy" allow-clear :placeholder="t('common.default')" style="width: 200px"
                  :options="capOf(accountById(id)!.platform)!.privacy!.map((p) => ({ value: p, label: t(`distribute.privacyOpt.${p}`) }))" />
              </a-form-item>
              <a-form-item :label="t('distribute.timeOverride')">
                <a-date-picker v-model:value="overrides[id]!.at" show-time allow-clear :placeholder="t('distribute.useCommonTime')" />
              </a-form-item>
            </a-form>
          </a-collapse-panel>
        </a-collapse>
      </template>

      <a-divider orientation="left" plain>{{ t('distribute.schedule') }}</a-divider>
      <a-space wrap>
        <a-radio-group v-model:value="form.when">
          <a-radio value="now">{{ t('distribute.now') }}</a-radio>
          <a-radio value="at">{{ t('distribute.at') }}</a-radio>
        </a-radio-group>
        <a-date-picker v-if="form.when === 'at'" v-model:value="form.at" show-time />
        <span>{{ t('distribute.maxAttempts') }}</span>
        <a-input-number v-model:value="form.maxAttempts" :min="1" :max="10" style="width: 70px" />
        <a-checkbox v-model:checked="form.republish">
          <a-tooltip :title="t('distribute.republishHint')">{{ t('distribute.republish') }}</a-tooltip>
        </a-checkbox>
      </a-space>
    </a-spin>
  </a-modal>
</template>

<style scoped>
.group { margin-bottom: 12px; }
.group-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.acc { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; padding: 4px 8px; border-radius: 4px; }
.acc:hover { background: var(--cp-bg-hover); }
.muted { color: var(--cp-text-tertiary); }
.warn { color: var(--cp-warning); font-size: 12px; }
</style>
