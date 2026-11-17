<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import dayjs, { type Dayjs } from 'dayjs'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { POST_TYPES, type Content, type MediaRule, type PostType, type PublishPlatform, type PublishTaskItem, type SocialAccount } from '../../api/types'
import { useInstancesStore } from '../../stores/instances'
import StatusTag from '../common/StatusTag.vue'
import { MODAL_WIDTH } from '../common/ui'
import PlatformTag from '../social/PlatformTag.vue'
import PlatformTextTabs, { type TextTab } from './PlatformTextTabs.vue'

/**
 * Publishing step (立即发布 / 定时发布): pick the post type and the target accounts (grouped by platform, with
 * device + login status), optional per-account title/caption/hashtags/privacy/time, and the schedule.
 * `mode` presets the schedule: now, or a time (default: the next full hour at least 30 min ahead).
 */
const props = defineProps<{ open: boolean; content: Content | null; mode?: 'now' | 'at' }>()
const emit = defineEmits<{ 'update:open': [boolean]; done: [] }>()
const { t } = useI18n()
const store = useInstancesStore()

const accounts = ref<SocialAccount[]>([])
const platforms = ref<PublishPlatform[]>([])
const loading = ref(false)
const saving = ref(false)
const selected = ref<string[]>([])
interface Override { title: string; hashtags: string[]; privacy: string | undefined; at: Dayjs | null }
const overrides = reactive<Record<string, Override>>({})
/** Per-account caption (empty = the content's text for that platform); one tab per selected account. */
const captions = reactive<Record<string, string>>({})
const accountTab = ref('')
const form = reactive({ when: 'now' as 'now' | 'at', at: null as Dayjs | null, maxAttempts: 3, republish: false, postType: 'feed' as PostType })
const defaultAt = () => dayjs().add(90, 'minute').startOf('hour')
const pastDay = (d: Dayjs) => d.isBefore(dayjs(), 'day')
function onWhen() { if (form.when === 'at' && !form.at) form.at = defaultAt() }

watch(() => props.open, async (o) => {
  if (!o || !props.content) return
  selected.value = []
  for (const k of Object.keys(overrides)) delete overrides[k]
  for (const k of Object.keys(captions)) delete captions[k]
  const when = props.mode ?? 'now'
  Object.assign(form, { when, at: when === 'at' ? defaultAt() : null, maxAttempts: 3, republish: false, postType: 'feed' })
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

/** Rule of the chosen post type on a platform (null: the platform has no such type). */
function ruleOf(platformId: string): { media: MediaRule; caption: boolean } | null {
  const cap = platforms.value.find((p) => p.id === platformId)?.capability
  if (!cap) return null
  return form.postType === 'feed' ? { media: cap.media, caption: true } : cap.postTypes?.[form.postType] ?? null
}
const hasCaption = (accountId: string) => ruleOf(accountById(accountId)?.platform ?? '')?.caption !== false

/** Client-side pre-check against the capability table (the API checks again). */
function incompatible(platformId: string): string | null {
  if (!platforms.value.some((p) => p.id === platformId)) return null
  const media = props.content?.media ?? []
  const rule = ruleOf(platformId)
  if (!rule) return t('distribute.typeNotSupported', { type: t(`publish.type.${form.postType}`) })
  const r = rule.media
  if (media.length < r.min || media.length > r.max) return t('distribute.needCount', { min: r.min, max: r.max, n: media.length })
  if (media.some((m) => !r.kinds.includes(m.fileType))) return t('distribute.needKinds', { kinds: r.kinds.map((k) => t(`media.${k}`)).join(' / ') })
  if (!r.mixed && new Set(media.map((m) => m.fileType)).size > 1) return t('errors.publish.media_mixed')
  if (r.maxVideoSec && media.some((m) => m.fileType === 'video' && (m.duration ?? 0) > r.maxVideoSec!)) return t('distribute.needVideoMax', { max: r.maxVideoSec })
  if (media.some((m) => m.status !== 'ready')) return t('distribute.notReady')
  return null
}

const groups = computed(() => {
  // Only platforms the API lists (enabled ones); accounts of disabled platforms can't be targets.
  const ids = [...new Set(accounts.value.map((a) => a.platform))].filter((id) => platforms.value.some((p) => p.id === id))
  return ids.map((id) => ({ id, name: platforms.value.find((p) => p.id === id)?.name ?? id, reason: incompatible(id), accounts: accounts.value.filter((a) => a.platform === id) }))
})
/** Post types offered: those of the platforms the owner has accounts on. */
const postTypes = computed(() => {
  const ids = new Set(accounts.value.map((a) => a.platform))
  return POST_TYPES.filter((pt) => platforms.value.some((p) => ids.has(p.id) && p.postTypes.includes(pt)))
})
const accountById = (id: string) => accounts.value.find((a) => a.id === id)
const noCaption = computed(() => selected.value.some((id) => !hasCaption(id)))
// Changing the type drops accounts whose platform no longer fits.
watch(() => form.postType, () => { selected.value = selected.value.filter((id) => !incompatible(accountById(id)?.platform ?? '')) })
const capOf = (platform: string) => platforms.value.find((p) => p.id === platform)?.capability
function online(a: SocialAccount): boolean {
  if (!a.instance) return false
  const live = store.byId.get(a.instance.id)
  return live ? live.status === 'running' && live.adbState === 'device' : a.instance.status === 'running'
}

function toggle(id: string, on: boolean) {
  if (on && !selected.value.includes(id)) {
    selected.value = [...selected.value, id]
    overrides[id] ??= { title: '', hashtags: [], privacy: undefined, at: null }
    captions[id] ??= ''
    accountTab.value = id
  } else if (!on) selected.value = selected.value.filter((x) => x !== id)
}
watch(selected, (ids) => { if (!ids.includes(accountTab.value)) accountTab.value = ids[0] ?? '' })
const accountTabs = computed<TextTab[]>(() => selected.value.map((id) => {
  const platform = accountById(id)?.platform ?? ''
  return { key: id, platform, label: `@${accountById(id)?.handle ?? ''}`, max: capOf(platform)?.captionMax ?? 5000, placeholder: defaultCaption(platform), text: hasCaption(id) }
}))

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
      const text = hasCaption(id)
      return {
        accountId: id,
        ...(o.title.trim() ? { title: o.title.trim() } : {}),
        ...(text && captions[id]?.trim() ? { caption: captions[id] } : {}),
        ...(text && o.hashtags.length ? { hashtags: o.hashtags } : {}),
        ...(o.privacy ? { options: { privacy: o.privacy } } : {}),
        scheduledAt: at ? at.toISOString() : null,
        ...(form.postType !== 'feed' ? { postType: form.postType } : {}),
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
  <a-modal :open="open" :title="t(form.when === 'at' ? 'distribute.titleLater' : 'distribute.titleNow', { title: content?.title ?? '' })" :width="MODAL_WIDTH.lg" :confirm-loading="saving"
    :ok-text="t('distribute.submit', { n: selected.length })" :ok-button-props="{ disabled: !selected.length }" :cancel-text="t('common.cancel')"
    @ok="submit" @cancel="emit('update:open', false)">
    <a-spin :spinning="loading">
      <a-divider orientation="left" plain>{{ t('distribute.schedule') }}</a-divider>
      <a-space wrap>
        <a-radio-group v-model:value="form.when" @change="onWhen">
          <a-radio value="now">{{ t('distribute.now') }}</a-radio>
          <a-radio value="at">{{ t('distribute.at') }}</a-radio>
        </a-radio-group>
        <a-date-picker v-if="form.when === 'at'" v-model:value="form.at" show-time format="YYYY-MM-DD HH:mm" :disabled-date="pastDay" />
        <span>{{ t('distribute.maxAttempts') }}</span>
        <a-input-number v-model:value="form.maxAttempts" :min="1" :max="10" style="width: 70px" />
        <a-checkbox v-model:checked="form.republish">
          <a-tooltip :title="t('distribute.republishHint')">{{ t('distribute.republish') }}</a-tooltip>
        </a-checkbox>
      </a-space>

      <template v-if="postTypes.length > 1">
        <a-divider orientation="left" plain>{{ t('distribute.postType') }}</a-divider>
        <a-radio-group v-model:value="form.postType" button-style="solid">
          <a-radio-button v-for="pt in postTypes" :key="pt" :value="pt">{{ t(`publish.type.${pt}`) }}</a-radio-button>
        </a-radio-group>
        <a-alert v-if="form.postType === 'story' || noCaption" type="info" show-icon :message="t('distribute.storyNoCaption')" style="margin-top: 8px" />
      </template>

      <a-divider orientation="left" plain>{{ t('publish.colAccount') }}</a-divider>
      <a-empty v-if="!loading && !accounts.length" :description="t('distribute.noAccounts')" />
      <div v-for="g in groups" :key="g.id" class="group">
        <div class="group-head">
          <PlatformTag :platform="g.id" :name="g.name" />
          <a-typography-text v-if="g.reason" type="warning" class="small">{{ g.reason }}</a-typography-text>
        </div>
        <div v-for="a in g.accounts" :key="a.id" class="acc">
          <a-checkbox :checked="selected.includes(a.id)" :disabled="!!g.reason" @change="(e: any) => toggle(a.id, e.target.checked)">
            <b>@{{ a.handle }}</b><span v-if="a.displayName" class="muted"> · {{ a.displayName }}</span>
          </a-checkbox>
          <a-space :size="4" wrap>
            <StatusTag kind="socialLogin" :status="a.loginStatus" />
            <StatusTag v-if="a.accountStatus !== 'active'" kind="socialAccount" :status="a.accountStatus" />
            <a-badge v-if="a.instance" :status="online(a) ? 'success' : 'default'" :text="`${a.instance.name} · ${online(a) ? t('distribute.online') : t('distribute.offline')}`" />
            <span v-else class="muted">{{ t('distribute.noDevice') }}</span>
          </a-space>
        </div>
      </div>

      <template v-if="selected.length">
        <a-divider orientation="left" plain>{{ t('distribute.overrides') }}</a-divider>
        <PlatformTextTabs v-model:active="accountTab" :tabs="accountTabs" :values="captions" :rows="4">
          <template #default="{ tab }">
            <a-form layout="vertical" class="tab-form">
              <a-form-item v-if="capOf(tab.platform ?? '')?.title" :label="t('distribute.titleOverride')">
                <a-input v-model:value="overrides[tab.key]!.title" :maxlength="capOf(tab.platform ?? '')!.title!.max" :placeholder="defaultTitle(tab.platform ?? '')" />
              </a-form-item>
              <a-form-item v-if="tab.text !== false" :label="t('distribute.hashtags')">
                <a-select v-model:value="overrides[tab.key]!.hashtags" mode="tags" :placeholder="t('distribute.hashtagsPlaceholder')" :token-separators="[',', ' ']" />
              </a-form-item>
              <a-row :gutter="12">
                <a-col v-if="capOf(tab.platform ?? '')?.privacy" :xs="24" :sm="12">
                  <a-form-item :label="t('distribute.privacy')">
                    <a-select v-model:value="overrides[tab.key]!.privacy" allow-clear :placeholder="t('common.default')"
                      :options="capOf(tab.platform ?? '')!.privacy!.map((p) => ({ value: p, label: t(`distribute.privacyOpt.${p}`) }))" />
                  </a-form-item>
                </a-col>
                <a-col :xs="24" :sm="12">
                  <a-form-item :label="t('distribute.timeOverride')">
                    <a-date-picker v-model:value="overrides[tab.key]!.at" show-time format="YYYY-MM-DD HH:mm" allow-clear :disabled-date="pastDay" :placeholder="t('distribute.useCommonTime')" style="width: 100%" />
                  </a-form-item>
                </a-col>
              </a-row>
            </a-form>
          </template>
        </PlatformTextTabs>
      </template>
    </a-spin>
  </a-modal>
</template>

<style scoped>
.group { margin-bottom: 12px; }
.group-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.acc { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; padding: 4px 8px; border-radius: var(--cp-radius); }
.acc:hover { background: var(--cp-bg-hover); }
.tab-form { margin-top: 16px; }
</style>
