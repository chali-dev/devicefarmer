<script setup lang="ts">
import { computed, h, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import dayjs, { type Dayjs } from 'dayjs'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { langName } from '../../api/lang'
import { POST_TYPES, type Content, type ContentTranslation, type MediaRule, type PostType, type PublishPlatform, type PublishTaskItem, type SocialAccount } from '../../api/types'
import { useInstancesStore } from '../../stores/instances'
import StatusTag from '../common/StatusTag.vue'
import { MODAL_WIDTH } from '../common/ui'
import PlatformTag from '../social/PlatformTag.vue'
import PhonePreview from './PhonePreview.vue'
import PlatformTextTabs, { type TextTab } from './PlatformTextTabs.vue'

/**
 * Publishing step (立即发布 / 排程发布): pick the post type and the target accounts (grouped by platform, with
 * device + login status), the schedule (one time for every account: 立即 / 排程 at the top; the per-account
 * 本账号发布时间 was removed on 2026-11-18, the API still takes a per-target `scheduledAt` from an older page), and
 * per-account fine-tuning: each account's title/caption/privacy start as the values the task would get anyway
 * (content texts for its platform) and follow them until edited; only edited fields are sent as overrides, so an
 * untouched account publishes exactly as without them.
 * No separate hashtags field (owner 2026-11-18): hashtags are written in the caption text itself; the API still accepts
 * `hashtags` from an older page, this one never sends them.
 * `mode` presets the schedule: now, or a time (default: the next full hour at least 30 min ahead).
 * The content's 发布目标 (default target accounts) are preselected, except accounts this content was already
 * published to (tagged 已发布); checking one of those re-publishes (`republish` is sent only then).
 * Languages: each account publishes the content's translation in its 账号语言, else the Chinese source (shown per
 * account, with a warning when its language has no translation); its inherited title/caption follow that language.
 * Nothing is queued until the person presses 发布 / 排程发布 here (draft first, 2026-11-18): the phone preview shows the
 * selected account's post as it will be shared, and the notice says the cloud phone really posts it (no test mode).
 * 编辑后重新发布: `accountIds` (+ `postType`) preselect exactly those accounts instead of the 发布目标 (the account
 * of a failed publish task; publishing creates a new task with the content's current texts and media).
 */
const props = defineProps<{ open: boolean; content: Content | null; mode?: 'now' | 'at'; accountIds?: string[]; postType?: PostType }>()
const emit = defineEmits<{ 'update:open': [boolean]; done: [] }>()
const { t } = useI18n()
const store = useInstancesStore()

const accounts = ref<SocialAccount[]>([])
const translations = ref<ContentTranslation[]>([])
const platforms = ref<PublishPlatform[]>([])
const loading = ref(false)
const saving = ref(false)
const selected = ref<string[]>([])
interface Override { title: string; privacy: string | undefined }
const overrides = reactive<Record<string, Override>>({})
/** Per-account caption (starts as the content's text for that platform); one tab per selected account. */
const captions = reactive<Record<string, string>>({})
const accountTab = ref('')
/** How many of the content's targets were preselected (of how many). */
const prefilled = ref({ n: 0, of: 0 })
/** Accounts this content was already published to (checking one = re-publish). */
const published = ref(new Set<string>())
const form = reactive({ when: 'now' as 'now' | 'at', at: null as Dayjs | null, postType: 'feed' as PostType })
const defaultAt = () => dayjs().add(90, 'minute').startOf('hour')
const pastDay = (d: Dayjs) => d.isBefore(dayjs(), 'day')
function onWhen() { if (form.when === 'at' && !form.at) form.at = defaultAt() }
/** The unified time (null = now). */
const commonAt = computed(() => (form.when === 'at' ? form.at : null))

watch(() => props.open, async (o) => {
  if (!o || !props.content) return
  selected.value = []
  for (const k of Object.keys(overrides)) delete overrides[k]
  for (const k of Object.keys(captions)) delete captions[k]
  const when = props.mode ?? 'now'
  Object.assign(form, { when, at: when === 'at' ? defaultAt() : null, postType: props.postType ?? 'feed' })
  published.value = new Set()
  loading.value = true
  try {
    const owner = props.content.userId
    const [a, p, done, tr] = await Promise.all([
      api<{ items: SocialAccount[] }>('GET', `/api/social/accounts?pageSize=200&ownerId=${owner}`),
      api<{ platforms: PublishPlatform[] }>('GET', '/api/publish/platforms'),
      api<{ items: PublishTaskItem[] }>('GET', `/api/publish/tasks?contentId=${props.content.id}&status=published&limit=500`),
      api<{ translations: ContentTranslation[] }>('GET', `/api/contents/${props.content.id}/translations`),
    ])
    translations.value = tr.translations
    accounts.value = a.items
    platforms.value = p.platforms
    published.value = new Set(done.items.map((x) => x.accountId))
    // 发布目标: preselect the content's targets that can take this post (enabled platform, media fit)
    // (编辑后重新发布: exactly the given accounts)
    const targetIds = props.accountIds ?? (props.content.targets ?? []).map((x) => x.id)
    for (const id of targetIds) {
      const acc = accountById(id)
      if (acc && (props.accountIds || !published.value.has(id)) && groups.value.some((g) => g.id === acc.platform && !g.reason)) toggle(id, true)
    }
    prefilled.value = { n: selected.value.length, of: targetIds.length }
    if (selected.value.length) accountTab.value = selected.value[0]!
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
/** Phone preview of the account tab shown below: its caption (stories: none), starting at the chosen post type. */
const previewType = ref<PostType>('feed')
watch(() => form.postType, (v) => { previewType.value = v }, { immediate: true })
const previewText = computed(() => {
  const id = accountTab.value
  if (!id || !hasCaption(id)) return ''
  return captions[id] ?? ''
})
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
    const platform = accountById(id)?.platform ?? ''
    overrides[id] ??= { title: defaultTitle(id), privacy: defaultPrivacy(platform) }
    captions[id] ??= defaultCaption(id)
    accountTab.value = id
  } else if (!on) selected.value = selected.value.filter((x) => x !== id)
}
watch(selected, (ids) => { if (!ids.includes(accountTab.value)) accountTab.value = ids[0] ?? '' })
const accountTabs = computed<TextTab[]>(() => selected.value.map((id) => {
  const platform = accountById(id)?.platform ?? ''
  return { key: id, platform, label: `@${accountById(id)?.handle ?? ''}`, max: capOf(platform)?.captionMax ?? 5000, text: hasCaption(id) }
}))

type Hints = Record<string, Record<string, unknown> | undefined>
/**
 * The texts an account publishes, mirroring the API's textsForAccount(): the content when the account has no language
 * or the content is written in it; else its translation in the account's language; else the source (`missing`).
 */
function textsOf(id: string): { lang: string | null; translated: boolean; missing: boolean; noLang: boolean; title: string; body: string; hints: Hints } {
  const c = props.content
  const acc = accountById(id)
  const source = { lang: c?.lang ?? null, translated: false, missing: false, noLang: !acc?.lang, title: c?.title ?? '', body: c?.body ?? '', hints: (c?.platformHints ?? {}) as Hints }
  if (!acc?.lang || acc.lang === c?.lang) return source
  const tr = translations.value.find((x) => x.lang === acc.lang)
  if (!tr) return { ...source, missing: true }
  return { lang: tr.lang, translated: true, missing: false, noLang: false, title: tr.title, body: tr.body, hints: (tr.platformHints ?? {}) as Hints }
}
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)
// Inherited values, mirroring the API's postFor(): platform hint of the account's language (if not blank), else that
// language's text. The content has no hashtag list of its own (hashtags in the text stay in the caption), so none.
function defaultCaption(id: string) {
  const x = textsOf(id)
  const h = x.hints[accountById(id)?.platform ?? ''] ?? {}
  return str(h.description) ?? str(h.caption) ?? x.body
}
function defaultTitle(id: string) {
  const platform = accountById(id)?.platform ?? ''
  const x = textsOf(id)
  return capOf(platform)?.title ? str(x.hints[platform]?.title) ?? x.title : ''
}
/** Options (privacy) always come from the content itself. */
const defaultPrivacy = (platform: string) => (capOf(platform)?.privacy ? str((props.content?.platformHints as Hints | undefined)?.[platform]?.privacy) ?? 'private' : undefined)
/** Selected accounts whose language has no translation (they get the source text). */
const missingLangAccounts = computed(() => selected.value.filter((id) => textsOf(id).missing))
const langLabel = (l: string | null) => (l ? `${langName(l)} (${l})` : t('distribute.lang.unknown'))

type Field = 'title' | 'caption' | 'privacy'
/** Which fields of an account differ from what it inherits (only those are sent). */
function edited(id: string): Record<Field, boolean> {
  const o = overrides[id]!
  const platform = accountById(id)?.platform ?? ''
  return {
    title: !!o.title.trim() && o.title.trim() !== defaultTitle(id).trim(),
    caption: (captions[id] ?? '') !== defaultCaption(id),
    privacy: o.privacy !== defaultPrivacy(platform),
  }
}
function restore(id: string, field: Field) {
  const o = overrides[id]!
  const platform = accountById(id)?.platform ?? ''
  if (field === 'title') o.title = defaultTitle(id)
  else if (field === 'caption') captions[id] = defaultCaption(id)
  else o.privacy = defaultPrivacy(platform)
}
/** 已修改 · 恢复 next to an edited field. */
const EditedMark = (p: { show: boolean; onRestore?: () => void }) => (p.show
  ? h('span', { class: 'small', style: 'margin-left: 8px; font-weight: normal; color: var(--cp-warning)' }, [
    t('distribute.edited'), ' · ',
    h('a', { onClick: (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); p.onRestore?.() } }, t('distribute.restore')),
  ])
  : null)

async function submit() {
  if (!props.content || !selected.value.length) return
  if (form.when === 'at' && !form.at) { message.warning(t('distribute.pickTime')); return }
  saving.value = true
  try {
    const targets = selected.value.map((id) => {
      const o = overrides[id]!
      const at = commonAt.value
      const text = hasCaption(id)
      const e = edited(id)
      return {
        accountId: id,
        ...(e.title ? { title: o.title.trim() } : {}),
        ...(text && e.caption ? { caption: captions[id] } : {}),
        ...(e.privacy && o.privacy ? { options: { privacy: o.privacy } } : {}),
        scheduledAt: at ? at.toISOString() : null,
        ...(form.postType !== 'feed' ? { postType: form.postType } : {}),
      }
    })
    const r = await api<{ created: PublishTaskItem[]; existing: PublishTaskItem[] }>('POST', `/api/contents/${props.content.id}/distribute`, {
      // Re-publish only when the person checked an account that already has this content (else a 409, never a silent duplicate).
      targets, republish: selected.value.some((id) => published.value.has(id)) || undefined,
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
      </a-space>

      <template v-if="postTypes.length > 1">
        <a-divider orientation="left" plain>{{ t('distribute.postType') }}</a-divider>
        <a-radio-group v-model:value="form.postType" button-style="solid">
          <a-radio-button v-for="pt in postTypes" :key="pt" :value="pt">{{ t(`publish.type.${pt}`) }}</a-radio-button>
        </a-radio-group>
        <a-alert v-if="form.postType === 'story' || noCaption" type="info" show-icon :message="t('distribute.storyNoCaption')" style="margin-top: 8px" />
      </template>

      <a-divider orientation="left" plain>{{ t('publish.colAccount') }}</a-divider>
      <div v-if="prefilled.of" class="muted small prefill">{{ t('distribute.prefilled', prefilled) }}</div>
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
            <a-tooltip v-if="published.has(a.id)" :title="t('distribute.publishedHint')"><a-tag color="success">{{ t('distribute.published') }}</a-tag></a-tooltip>
            <a-tooltip :title="textsOf(a.id).missing ? t('distribute.lang.missingHint', { lang: langLabel(a.lang) }) : textsOf(a.id).noLang ? t('distribute.lang.noLangHint') : undefined">
              <a-tag :color="textsOf(a.id).missing ? 'warning' : undefined">{{ t(textsOf(a.id).translated ? 'distribute.lang.translation' : 'distribute.lang.source', { lang: langLabel(textsOf(a.id).lang) }) }}</a-tag>
            </a-tooltip>
            <a-badge v-if="a.instance" :status="online(a) ? 'success' : 'default'" :text="`${a.instance.name} · ${online(a) ? t('distribute.online') : t('distribute.offline')}`" />
            <span v-else class="muted">{{ t('distribute.noDevice') }}</span>
          </a-space>
        </div>
      </div>

      <template v-if="selected.length">
        <a-divider orientation="left" plain>{{ t('distribute.preview') }}</a-divider>
        <a-alert type="warning" show-icon class="prefill" :message="t('distribute.liveNotice')" />
        <div class="preview"><PhonePreview v-model:mode="previewType" :media="content?.media ?? []" :text="previewText" :handle="accountById(accountTab)?.handle ?? null" /></div>
        <a-divider orientation="left" plain>{{ t('distribute.overrides') }}</a-divider>
        <div class="muted small prefill">{{ t('distribute.overridesHint') }}</div>
        <a-alert v-if="missingLangAccounts.length" type="warning" show-icon class="prefill"
          :message="t('distribute.lang.missing', { accounts: missingLangAccounts.map((id) => `@${accountById(id)?.handle} (${accountById(id)?.lang})`).join('、') })" />
        <PlatformTextTabs v-model:active="accountTab" :tabs="accountTabs" :values="captions" :rows="4">
          <template #default="{ tab }">
            <div class="small muted caption-mark">{{ t(textsOf(tab.key).translated ? 'distribute.lang.translation' : 'distribute.lang.source', { lang: langLabel(textsOf(tab.key).lang) }) }}</div>
            <div v-if="tab.text !== false && edited(tab.key).caption" class="small caption-mark">
              {{ t('distribute.caption') }}<EditedMark :show="true" @restore="restore(tab.key, 'caption')" />
            </div>
            <a-form layout="vertical" class="tab-form">
              <a-form-item v-if="capOf(tab.platform ?? '')?.title">
                <template #label>{{ t('distribute.titleOverride') }}<EditedMark :show="edited(tab.key).title" @restore="restore(tab.key, 'title')" /></template>
                <a-input v-model:value="overrides[tab.key]!.title" :maxlength="capOf(tab.platform ?? '')!.title!.max" :placeholder="defaultTitle(tab.key)" />
              </a-form-item>
              <a-row :gutter="12">
                <a-col v-if="capOf(tab.platform ?? '')?.privacy" :xs="24" :sm="12">
                  <a-form-item>
                    <template #label>{{ t('distribute.privacy') }}<EditedMark :show="edited(tab.key).privacy" @restore="restore(tab.key, 'privacy')" /></template>
                    <a-select v-model:value="overrides[tab.key]!.privacy"
                      :options="capOf(tab.platform ?? '')!.privacy!.map((p) => ({ value: p, label: t(`distribute.privacyOpt.${p}`) }))" />
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
.preview { display: flex; justify-content: center; }
.group-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.acc { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; padding: 4px 8px; border-radius: var(--cp-radius); }
.acc:hover { background: var(--cp-bg-hover); }
.tab-form { margin-top: 16px; }
.prefill { margin-bottom: 8px; }
.caption-mark { margin-top: 4px; }
</style>
