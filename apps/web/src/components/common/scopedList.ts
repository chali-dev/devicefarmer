import { computed, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { ScopedItem } from '../../api/types'
import { useAuthStore } from '../../stores/auth'
import { confirmDanger } from './ui'

export interface ScopedListOptions {
  /** API base, e.g. `/api/personas` (GET ?scope=, POST, PATCH/DELETE /:id, POST /:id/merge). */
  path: string
  /** Key of the list in the GET response (`personas`, `categories`). */
  listKey: string
  /** i18n prefix of the list's own labels (confirmDelete, deleteContent, mergeOk, …). */
  texts: string
  /** false = a personal row merges only into the same owner's rows (media categories). */
  mergeIntoPublic?: boolean
  /** Called after every successful change (before the reload). */
  onChanged?: () => void
}

/**
 * State and actions of a scoped name list (人设, 内容分类, 素材分类), shared by the `ScopedListManager` dialog and the
 * 人设 page: public rows (admins edit) and personal ones (own; admins may list every user's, optionally one owner's).
 * Create / edit / reorder / merge / delete with the same confirmations and merge-direction rules as the API
 * (`lib/scoped-list.ts`: public → public; personal → the same owner's or, with mergeIntoPublic, a public row).
 */
export function useScopedList(o: ScopedListOptions) {
  const { t } = useI18n()
  const auth = useAuthStore()
  const tx = (k: string, p?: Record<string, unknown>) => t(`${o.texts}.${k}`, p ?? {})
  const mergeIntoPublic = o.mergeIntoPublic ?? true

  const tab = ref<'public' | 'mine'>('public')
  /** Admin, personal tab: own rows or every user's (`ownerId` narrows that to one user). */
  const owner = ref<'own' | 'all-users'>('own')
  const ownerId = ref<string | undefined>()
  const publicList = ref<ScopedItem[]>([])
  const personalList = ref<ScopedItem[]>([])
  const loading = ref(false)
  const busy = ref(false)

  const allUsers = computed(() => tab.value === 'mine' && auth.isAdmin && owner.value === 'all-users')
  const list = computed(() => (tab.value === 'public' ? publicList.value : personalList.value))
  const canEdit = computed(() => tab.value === 'mine' || auth.isAdmin)

  async function load() {
    loading.value = true
    try {
      const get = (q: string) => api<Record<string, ScopedItem[]>>('GET', `${o.path}?${q}`).then((r) => r[o.listKey] ?? [])
      const personal = allUsers.value ? `scope=all-users${ownerId.value ? `&ownerId=${ownerId.value}` : ''}` : 'scope=mine'
      ;[publicList.value, personalList.value] = await Promise.all([get('scope=public'), get(personal)])
    } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
  }

  /** Runs a change, then notifies and reloads; errors become a message. Resolves true on success. */
  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    busy.value = true
    try { await fn(); o.onChanged?.(); await load(); return true } catch (e) { message.error(errorText(e)); return false } finally { busy.value = false }
  }

  /** New row in the current tab (public or personal; `forOwner` = admin creating a personal row for another user). */
  const create = (name: string, description: string | null, forOwner?: string) =>
    run(() => api('POST', o.path, { scope: tab.value, name, description, ...(forOwner ? { ownerId: forOwner } : {}) }))
  /** Name/description change (no request when nothing changed). */
  function update(p: ScopedItem, name: string, description: string | null) {
    if (!name || (name === p.name && description === p.description)) return Promise.resolve(true)
    return run(() => api('PATCH', `${o.path}/${p.id}`, { name, description }))
  }
  /** Swap with the neighbour in `rows`, then renumber 0..n-1 (only changed rows are written). */
  function move(rows: ScopedItem[], i: number, d: -1 | 1) {
    const j = i + d
    if (j < 0 || j >= rows.length) return
    const next = [...rows]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    void run(async () => {
      for (const [idx, p] of next.entries()) if (p.sort !== idx) await api('PATCH', `${o.path}/${p.id}`, { sort: idx })
    })
  }
  function remove(p: ScopedItem) {
    confirmDanger({
      title: tx('confirmDelete', { name: p.name }),
      content: p.count || p.accounts ? tx('deleteContent', { n: p.count, accounts: p.accounts ?? 0 }) : undefined,
      onOk: () => run(() => api('DELETE', `${o.path}/${p.id}`)),
    })
  }

  // ---- merge
  const merging = ref<ScopedItem | null>(null)
  const mergeInto = ref<string | undefined>()
  const mergeTargets = computed(() => {
    const src = merging.value
    if (!src) return []
    const own = src.ownerType === 'user' ? personalList.value.filter((p) => p.ownerId === src.ownerId) : []
    const pub = src.ownerType === 'public' || mergeIntoPublic ? publicList.value : []
    return [...own, ...pub].filter((p) => p.id !== src.id)
      .map((p) => ({ value: p.id, label: p.ownerType === 'public' && src.ownerType === 'user' ? `${p.name} · ${t('scopedList.public')}` : p.name }))
  })
  function startMerge(p: ScopedItem) { merging.value = p; mergeInto.value = undefined }
  async function doMerge() {
    const src = merging.value
    if (!src || !mergeInto.value) return
    await run(async () => {
      const r = await api<{ moved: number; movedAccounts?: number }>('POST', `${o.path}/${src.id}/merge`, { into: mergeInto.value })
      message.success(tx('mergeOk', { n: r.moved, accounts: r.movedAccounts ?? 0 }))
      merging.value = null
    })
  }

  return {
    tx, tab, owner, ownerId, publicList, personalList, loading, busy, allUsers, list, canEdit,
    load, run, create, update, move, remove, merging, mergeInto, mergeTargets, startMerge, doMerge,
  }
}
