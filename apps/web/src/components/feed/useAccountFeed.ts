import { ref } from 'vue'
import { message } from 'ant-design-vue'
import { api, errorText } from '../../api/client'
import type { FeedResponse } from '../../api/types'

/** Loads one account's feed (动态 + paged posts + collection state) (collected by the 同步 button). Shared by both detail drawers. */
export function useAccountFeed(kind: 'social' | 'tracked') {
  const base = (id: string) => (kind === 'social' ? `/api/social/accounts/${id}` : `/api/tracked-accounts/${id}`)
  const feed = ref<FeedResponse | null>(null)
  const page = ref(1)
  const pageSize = 10
  const loading = ref(false)
  let current: string | null = null

  async function load(id: string, p = page.value) {
    current = id
    page.value = p
    loading.value = true
    try {
      const r = await api<FeedResponse>('GET', `${base(id)}/feed?limit=${pageSize}&offset=${(p - 1) * pageSize}&comments=10`)
      if (current === id) feed.value = r
    } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
  }
  function reset() { feed.value = null; page.value = 1; current = null }
  return { feed, page, pageSize, loading, load, reset }
}
