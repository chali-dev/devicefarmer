import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api/client'
import type { AppNotification } from '../api/types'
import { useInstancesStore } from './instances'

/**
 * Unread count of the signed-in user's notifications (告警通知), shared by the header bell, the user menu's
 * 通知中心 entry and the /notifications page. Every list / read / delete response carries the current `unread`
 * (set it with `setUnread`); new rows arrive live as `notification.created` over /api/events.
 */
export const useNotificationsStore = defineStore('notifications', () => {
  const unread = ref(0)
  const instances = useInstancesStore()
  const seen = new Set<string>()
  instances.onNotification((ev) => {
    if (seen.has(ev.notification.id)) return
    seen.add(ev.notification.id)
    if (!ev.notification.readAt) unread.value++
  })

  function setUnread(n: number) { unread.value = n }
  async function refresh() {
    try { setUnread((await api<{ unread: number }>('GET', '/api/notifications?limit=1')).unread) } catch { /* keep the last value */ }
  }
  /** Live notifications for a view (the store already counted them). */
  function onCreated(fn: (n: AppNotification) => void) { return instances.onNotification((ev) => fn(ev.notification)) }

  return { unread, setUnread, refresh, onCreated }
})
