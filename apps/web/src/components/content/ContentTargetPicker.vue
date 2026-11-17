<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { SocialAccount } from '../../api/types'
import { usePlatformsStore } from '../../stores/platforms'
import PlatformIcon from '../social/PlatformIcon.vue'

/**
 * 发布目标 of a content: the owner's accounts on enabled platforms, picked one by one or added in bulk by 人设 (账号人设).
 * A bulk pick is expanded to the concrete accounts at that moment (only ids are stored, never the persona rule).
 * Emits the selected accounts in order (`accounts`) so the editor can use the first one (preview, template persona).
 */
const props = defineProps<{ ownerId: string | undefined }>()
const ids = defineModel<string[]>({ required: true })
const emit = defineEmits<{ accounts: [SocialAccount[]] }>()
const { t } = useI18n()
const platforms = usePlatformsStore()

const all = ref<SocialAccount[]>([])
const loading = ref(false)

async function load() {
  if (!props.ownerId) return
  loading.value = true
  try {
    await platforms.load().catch(() => undefined)
    all.value = (await api<{ items: SocialAccount[] }>('GET', `/api/social/accounts?pageSize=200&ownerId=${props.ownerId}`)).items
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
watch(() => props.ownerId, () => { void load() }, { immediate: true })

/** Selectable: enabled platforms only (the API refuses the others). */
const accounts = computed(() => all.value.filter((a) => platforms.isEnabled(a.platform)))
const byId = computed(() => new Map(all.value.map((a) => [a.id, a])))
watch([ids, byId], () => emit('accounts', ids.value.map((id) => byId.value.get(id)).filter((a): a is SocialAccount => !!a)), { immediate: true })

/** Bulk source: a persona id (personas used by the owner's selectable accounts). */
const bulk = ref<string | undefined>()
const personas = computed(() => [...new Map(accounts.value.filter((a) => a.personaId).map((a) => [a.personaId!, a.personaName ?? a.personaId!])).entries()]
  .sort((a, b) => a[1].localeCompare(b[1])))
const membersOf = (personaId: string) => accounts.value.filter((a) => a.personaId === personaId)
const bulkNew = computed(() => (bulk.value ? membersOf(bulk.value).filter((a) => !ids.value.includes(a.id)) : []))
const count = (key: string) => membersOf(key).length
function addBulk() {
  ids.value = [...ids.value, ...bulkNew.value.map((a) => a.id)]
  bulk.value = undefined
}
const unknownIds = computed(() => ids.value.filter((id) => !accounts.value.some((a) => a.id === id)))
</script>

<template>
  <div class="targets">
    <a-select v-model:value="ids" mode="multiple" :loading="loading" :placeholder="t('content.targets.placeholder')" option-label-prop="label"
      option-filter-prop="search" allow-clear style="width: 100%">
      <a-select-option v-for="a in accounts" :key="a.id" :value="a.id" :label="`@${a.handle}`" :search="`${a.handle} ${a.displayName ?? ''} ${a.instance?.name ?? ''}`">
        <span class="opt">
          <PlatformIcon :platform="a.platform" labelled />
          <span><span :class="{ muted: !a.instance }">{{ a.instance?.name ?? t('content.targets.noDevice') }}</span> · @{{ a.handle }}</span>
          <span v-if="a.personaName" class="muted small">· {{ a.personaName }}</span>
        </span>
      </a-select-option>
      <!-- ids no longer selectable (e.g. platform disabled) stay visible so saving does not drop them silently -->
      <a-select-option v-for="id in unknownIds" :key="id" :value="id" :label="byId.get(id) ? `@${byId.get(id)!.handle}` : id.slice(0, 8)" disabled>
        {{ byId.get(id) ? `@${byId.get(id)!.handle}` : id.slice(0, 8) }}
      </a-select-option>
    </a-select>
    <div class="bulk">
      <a-select v-model:value="bulk" size="small" allow-clear show-search option-filter-prop="label" :placeholder="t('content.targets.bulk')"
        :dropdown-match-select-width="false" style="width: 200px" :not-found-content="t('content.targets.noPersonas')"
        :options="personas.map(([id, name]) => ({ value: id, label: `${name} (${count(id)})` }))" />
      <template v-if="bulk">
        <span class="muted small">{{ t('content.targets.willAdd', { n: bulkNew.length }) }}</span>
        <a-button size="small" type="primary" :disabled="!bulkNew.length" @click="addBulk">{{ t('content.targets.add') }}</a-button>
      </template>
      <span v-if="ids.some((id) => byId.get(id) && !byId.get(id)!.instance)" class="muted small">{{ t('content.targets.manualOnly') }}</span>
    </div>
  </div>
</template>

<style scoped>
.opt { display: inline-flex; align-items: center; gap: 6px; }
.bulk { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
</style>
