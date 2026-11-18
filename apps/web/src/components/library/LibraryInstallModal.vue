<script setup lang="ts">
import { message } from 'ant-design-vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import type { LibraryApp, LibraryInstallTarget } from '../../api/types'
import { statusLabel } from '../common/status'
import { MODAL_WIDTH } from '../common/ui'

/**
 * Install one library entry on several devices at once: lists every device the viewer may install on
 * (admin: all devices with their granted users), hides those that already have this version or newer,
 * marks older versions as 可更新, and devices that are off/busy as not selectable.
 */
const props = defineProps<{ app: LibraryApp | null }>()
const emit = defineEmits<{ close: []; submitted: [] }>()
const { t } = useI18n()

const devices = ref<LibraryInstallTarget[]>([])
const loading = ref(false)
const submitting = ref(false)
const picked = ref<string[]>([])
const q = ref('')

watch(() => props.app, async (a) => {
  devices.value = []; picked.value = []; q.value = ''
  if (!a) return
  loading.value = true
  try { devices.value = (await api<{ devices: LibraryInstallTarget[] }>('GET', `/api/library/${a.id}/targets`)).devices }
  catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}, { immediate: true })

const selectable = (d: LibraryInstallTarget) => d.state === 'installable' || d.state === 'update'
const label = (d: LibraryInstallTarget) => (d.users ? `${d.name} - ${d.users.length ? d.users.join(t('common.listSep')) : t('library.unassigned')}` : d.name)
const hiddenCount = computed(() => devices.value.filter((d) => d.state === 'installed').length)
const shown = computed(() => {
  const s = q.value.trim().toLowerCase()
  // Pickable devices first (API order = by name within each group).
  return devices.value.filter((d) => d.state !== 'installed' && (!s || label(d).toLowerCase().includes(s)))
    .sort((a, b) => Number(selectable(b)) - Number(selectable(a)))
})
const shownSelectable = computed(() => shown.value.filter(selectable).map((d) => d.id))
const allChecked = computed(() => shownSelectable.value.length > 0 && shownSelectable.value.every((id) => picked.value.includes(id)))
const someChecked = computed(() => !allChecked.value && shownSelectable.value.some((id) => picked.value.includes(id)))
function toggleAll(on: boolean) {
  const ids = new Set(shownSelectable.value)
  picked.value = on ? [...new Set([...picked.value, ...ids])] : picked.value.filter((id) => !ids.has(id))
}
function toggle(id: string, on: boolean) {
  picked.value = on ? [...picked.value, id] : picked.value.filter((x) => x !== id)
}
const version = (v: { versionName: string | null; versionCode: string }) => v.versionName ?? v.versionCode

/** Why a device can't be picked: its status (离线/忙), adb not attached, or the version read failed. */
function note(d: LibraryInstallTarget): string {
  if (d.state === 'installing') return t('library.state.installing')
  if (d.state === 'offline' || d.state === 'busy') {
    const why = d.reason === 'adb' ? t('library.reason.adb') : d.reason === 'probe' ? t('library.reason.probe') : d.reason ? statusLabel('instance', d.reason) : ''
    return `${t(`library.state.${d.state}`)}${why ? ` · ${why}` : ''}`
  }
  return ''
}

async function submit() {
  if (!props.app || !picked.value.length) return
  submitting.value = true
  try {
    const r = await api<{ accepted: unknown[]; skipped: { reason: string; code?: string }[] }>('POST', `/api/library/${props.app.id}/install`, { instanceIds: picked.value })
    if (r.accepted.length) message.success(t('library.submitted', { n: r.accepted.length }))
    if (r.skipped.length) message.warning(t('common.skipped', { n: r.skipped.length, reasons: [...new Set(r.skipped.map((s) => codeText(s.code, undefined, s.reason)))].join(t('common.reasonSep')) }))
    emit('submitted')
  } catch (e) { message.error(errorText(e)) }
  finally { submitting.value = false }
}
</script>

<template>
  <a-modal :open="!!app" :width="MODAL_WIDTH.md" :title="t('library.installTitle', { pkg: app?.package ?? '', version: app ? version(app) : '' })"
    :ok-text="picked.length ? t('library.installN', { n: picked.length }) : t('common.install')" :cancel-text="t('common.cancel')"
    :ok-button-props="{ disabled: !picked.length }" :confirm-loading="submitting" @ok="submit" @cancel="emit('close')">
    <a-spin :spinning="loading" :tip="t('library.checking')">
      <div class="bar">
        <a-checkbox :checked="allChecked" :indeterminate="someChecked" :disabled="!shownSelectable.length" @change="(e: any) => toggleAll(e.target.checked)">{{ t('library.selectAll') }}</a-checkbox>
        <a-input-search v-model:value="q" allow-clear :placeholder="t('library.searchDevices')" style="flex: 1" />
        <span class="muted">{{ t('library.selected', { n: picked.length }) }}</span>
      </div>
      <div class="list">
        <div v-for="d in shown" :key="d.id" class="row" :class="{ off: !selectable(d) }">
          <a-checkbox :checked="picked.includes(d.id)" :disabled="!selectable(d)" @change="(e: any) => toggle(d.id, e.target.checked)">{{ label(d) }}</a-checkbox>
          <span class="tags">
            <a-tag v-if="d.state === 'update'" color="blue">{{ t('library.state.update') }} · {{ t('library.installedVersion', { version: version(d.installed!) }) }}</a-tag>
            <span v-else-if="note(d)" class="muted">{{ note(d) }}</span>
          </span>
        </div>
        <a-empty v-if="!loading && !shown.length" :image-style="{ height: '40px' }" :description="t('library.noTargets')" />
      </div>
      <div v-if="hiddenCount" class="muted small">{{ t('library.hiddenInstalled', { n: hiddenCount }) }}</div>
    </a-spin>
  </a-modal>
</template>

<style scoped>
.bar { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.list { max-height: 360px; overflow-y: auto; border: 1px solid var(--cp-border); border-radius: var(--cp-radius); padding: 4px 8px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--cp-border-secondary); }
.row:last-child { border-bottom: none; }
.tags { flex-shrink: 0; text-align: right; }
.small { font-size: 12px; margin-top: 6px; }
</style>
