import { message } from 'ant-design-vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { api, codeText, errorText } from '../../api/client'
import type { PlatformConnection } from '../../api/types'
import { usePlatformsStore } from '../../stores/platforms'

/** Official-API connection state for the social accounts table (platforms + connections by account id). */
export function usePlatformConnections() {
  const { t } = useI18n()
  const route = useRoute()
  const router = useRouter()
  const store = usePlatformsStore()
  const platforms = computed(() => store.scope.platforms)
  const byAccount = ref(new Map<string, PlatformConnection>())

  async function loadPlatforms() {
    try { await store.load() } catch (e) { message.error(errorText(e)) }
  }

  async function load(accountIds: string[]) {
    if (!accountIds.length) { byAccount.value = new Map(); return }
    try {
      const r = await api<{ connections: PlatformConnection[] }>('GET', `/api/platforms/connections?accountIds=${accountIds.join(',')}`)
      byAccount.value = new Map(r.connections.map((c) => [c.socialAccountId, c]))
    } catch (e) { message.error(errorText(e)) }
  }

  /** Shows the result of an OAuth callback (?platformConnect=…&result=ok|error&code=…) once, then drops the query. */
  function handleCallback() {
    const q = route.query
    if (typeof q.platformConnect !== 'string') return
    const name = platforms.value.find((p) => p.id === q.platformConnect)?.name ?? q.platformConnect
    if (q.result === 'ok') message.success(t('platforms.connectedOk', { name }))
    else message.error(codeText(typeof q.code === 'string' ? q.code : null, { platform: name, error: '', reason: '', type: '' }, t('platforms.connectFailed', { name })), 8)
    const rest = { ...q }
    for (const k of ['platformConnect', 'result', 'code', 'account']) delete rest[k]
    void router.replace({ query: rest })
  }

  return { platforms, byAccount, loadPlatforms, load, handleCallback }
}
