<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { CloseOutlined } from '@ant-design/icons-vue'
import { useAuthStore } from '../../stores/auth'
import { navLabel, useMenuLocation } from './menu'

/**
 * 历史路由 bar under the header (owner 2026-11-19): the last MAX pages this user opened in this browser.
 * One tag per path (query kept from the latest visit, so `?tab=` survives); a path with a param (e.g. /instances/:id,
 * /social/accounts/:id) is its own tag. Only pages the router actually landed on are recorded: redirects and the
 * catch-all never land, the login page is outside the layout. Tags keep their place; over MAX the least recently
 * visited one goes. Stored per user in localStorage (best effort), removed on logout / another user's login.
 * `label` = the header breadcrumb's last label (device name, an override on a detail page), used for param pages.
 */
const props = defineProps<{ label?: string }>()

const MAX = 10
const PREFIX = 'cp.visited.'
interface Visit { path: string; fullPath: string; key: string; sub?: string; at: number }

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const loc = useMenuLocation()
const { t } = useI18n()
const visits = ref<Visit[]>([])
const bar = ref<HTMLElement>()

const storageKey = (id: string) => `${PREFIX}${id}`
function load(id: string): Visit[] {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey(id)) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => x && typeof x.path === 'string' && typeof x.fullPath === 'string' && typeof x.key === 'string').slice(0, MAX) : []
  } catch { return [] }
}
function save() {
  const id = auth.user?.id
  if (!id) return
  try { localStorage.setItem(storageKey(id), JSON.stringify(visits.value)) } catch { /* storage unavailable: memory only */ }
}
/** Removes every stored list except `keep`'s (logout, another user's login on this browser). */
function purge(keep?: string) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k?.startsWith(PREFIX) && k !== (keep ? storageKey(keep) : '')) localStorage.removeItem(k)
    }
  } catch { /* ignore */ }
}

const hasParams = () => Object.keys(route.params).length > 0
function record() {
  if (route.meta.public || !auth.user) return
  const sub = hasParams() && props.label && props.label !== navLabel(loc.itemKey.value) ? props.label : undefined
  const entry: Visit = { path: route.path, fullPath: route.fullPath, key: loc.itemKey.value, sub, at: Date.now() }
  const list = [...visits.value]
  const i = list.findIndex((v) => v.path === entry.path)
  if (i >= 0) list[i] = { ...entry, sub: entry.sub ?? list[i].sub }
  else list.push(entry)
  while (list.length > MAX) {
    const oldest = list.filter((v) => v.path !== entry.path).reduce((a, b) => (b.at < a.at ? b : a))
    list.splice(list.indexOf(oldest), 1)
  }
  visits.value = list
  save()
  void nextTick(() => bar.value?.querySelector('.vp-tag.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
}

onMounted(() => {
  const id = auth.user?.id
  if (id) { purge(id); visits.value = load(id) }
  record()
})
watch(() => route.fullPath, record, { flush: 'post' })
// A detail page's name arrives after its data loads: update that tag's label.
watch(() => props.label, () => { if (hasParams()) record() }, { flush: 'post' })
watch(() => auth.user?.id, (id, old) => {
  if (id === old) return
  if (old) purge(id)
  visits.value = id ? load(id) : []
}, { flush: 'sync' })

const labelOf = (v: Visit) => v.sub ?? navLabel(v.key)
const isActive = (v: Visit) => v.path === route.path

function close(v: Visit) {
  const rest = visits.value.filter((x) => x.path !== v.path)
  visits.value = rest
  save()
  if (!isActive(v)) return
  const next = rest.length ? rest.reduce((a, b) => (b.at > a.at ? b : a)) : null
  void router.push(next ? next.fullPath : '/dashboard')
}
function clearAll() {
  visits.value = visits.value.filter(isActive)
  save()
}
const canClear = computed(() => visits.value.some((v) => !isActive(v)))
</script>

<template>
  <nav v-if="visits.length" class="vp" :aria-label="t('visited.title')">
    <div ref="bar" class="vp-list">
      <span v-for="v in visits" :key="v.path" class="vp-tag" :class="{ active: isActive(v) }" :title="v.fullPath">
        <router-link :to="v.fullPath" class="vp-link" :aria-current="isActive(v) ? 'page' : undefined">{{ labelOf(v) }}</router-link>
        <button type="button" class="vp-close" :aria-label="t('visited.close', { name: labelOf(v) })" @click="close(v)"><CloseOutlined /></button>
      </span>
    </div>
    <a-button v-if="canClear" type="link" size="small" class="vp-clear" @click="clearAll">{{ t('visited.clear') }}</a-button>
  </nav>
</template>

<style scoped>
.vp {
  position: sticky; top: 56px; z-index: 9; display: flex; align-items: center; gap: 4px; height: 36px; padding: 0 8px 0 16px;
  background: var(--cp-bg-container); border-bottom: 1px solid var(--cp-border-secondary);
}
.vp-list { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; overflow-x: auto; white-space: nowrap; scrollbar-width: none; }
.vp-list::-webkit-scrollbar { display: none; }
.vp-tag {
  flex: none; display: inline-flex; align-items: center; gap: 2px; height: 24px; padding: 0 4px 0 8px; font-size: 12px;
  border: 1px solid var(--cp-border-secondary); border-radius: var(--cp-radius); background: var(--cp-fill-alter);
}
.vp-tag:hover { border-color: var(--cp-border); }
.vp-tag.active { border-color: var(--cp-primary); background: var(--cp-primary-bg); }
.vp-link { color: var(--cp-text-secondary); max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
.vp-tag.active .vp-link { color: var(--cp-primary); }
.vp-link:hover { color: var(--cp-primary); }
.vp-close {
  display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 50%;
  background: transparent; color: var(--cp-text-tertiary); font-size: 9px; cursor: pointer;
}
.vp-close:hover { background: var(--cp-bg-hover); color: var(--cp-text); }
.vp-clear { flex: none; font-size: 12px; }
@media (max-width: 640px) { .vp { padding: 0 4px 0 8px; } }
</style>
