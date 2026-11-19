import { message } from 'ant-design-vue'
import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import type { SocialAccount, Task } from '../../api/types'
import { useInstancesStore } from '../../stores/instances'

type Step = 'account' | 'feed'
type SyncTaskResult = { outcome?: string; result?: string; code?: string; taskId?: string; handle?: string; feed?: { taskId?: string; code?: string }
  posts?: number; newPosts?: number; comments?: number; newComments?: number }

/**
 * The one 同步 button of a media account (owner 2026-11-18), shared by 我的媒体号 rows / edit drawer and the account's
 * 关注 / 粉丝 page: `POST /api/social/accounts/:id/sync` = step 1 (从云手机同步 on its linked phone) → step 2 (帖子与评论,
 * queued by step 1) — step 3 (关注 / 粉丝 lists) is its own account-following task, followed by the list views.
 * Followed through task events; pace deferrals continue as a new task. `onAccountStep(accountId)` runs when step 1
 * ended (the account row changed).
 */
export function useAccountSync(onAccountStep: (accountId: string) => void) {
  const { t, te } = useI18n()
  const store = useInstancesStore()
  /** Account id → the 同步 task being followed: step 1 account (account-device-sync), step 2 feed (feed-collect). */
  const syncing = ref<Record<string, { taskId: string; step: Step }>>({})
  const syncLabel = (id: string) => (syncing.value[id]?.step === 'feed' ? t('feed.syncStepFeedShort') : syncing.value[id] ? t('feed.syncStepAccount') : t('social.syncNow'))
  const syncDisabled = (a: Pick<SocialAccount, 'instanceId' | 'platform'>) => !a.instanceId || a.platform !== 'instagram'

  async function syncNow(a: Pick<SocialAccount, 'id' | 'instanceId' | 'platform'>) {
    if (syncDisabled(a) || syncing.value[a.id]) return
    try {
      const r = await api<{ task: { id: string } }>('POST', `/api/social/accounts/${a.id}/sync`)
      syncing.value = { ...syncing.value, [a.id]: { taskId: r.task.id, step: 'account' } }
      message.info(t('social.syncQueued'))
    } catch (e) { message.error(errorText(e)) }
  }

  /**
   * One followed task ended. Step 1 (account): message, `onAccountStep` at once; when it queued step 2 the feed task
   * is followed next ("账号已更新 → 正在读取帖子…"). Step 2 (feed): its own result; a failure there never changes what
   * step 1 wrote.
   */
  async function syncFinished(accountId: string, cur: { taskId: string; step: Step }) {
    const done = () => { const { [accountId]: _d, ...rest } = syncing.value; syncing.value = rest }
    try {
      const { task } = await api<{ task: Task & { result: SyncTaskResult | null } }>('GET', `/api/tasks/${cur.taskId}`)
      const res = task.result ?? {}
      if (task.status === 'success' && res.outcome === 'deferred' && res.taskId) { syncing.value = { ...syncing.value, [accountId]: { ...cur, taskId: res.taskId } }; return }
      if (cur.step === 'feed') {
        done()
        if (task.status !== 'success') message.warning(t('feed.syncFeedFailed', { msg: codeText(task.errorCode ?? undefined, {}, task.error ?? task.status) }))
        else if (res.outcome === 'skipped') message.info(t('feed.syncFeedNotQueued', { msg: codeText(res.code, {}, res.code ?? '') }))
        else message.success(t('feed.syncFeedDone', { msg: t('feed.activity.collect', { posts: res.posts ?? 0, newPosts: res.newPosts ?? 0, comments: res.comments ?? 0, newComments: res.newComments ?? 0 }) }))
        return
      }
      if (task.status === 'success' && res.feed?.taskId) {
        syncing.value = { ...syncing.value, [accountId]: { taskId: res.feed.taskId, step: 'feed' } }
        message.info(t('feed.syncStepFeed'))
        return
      }
      done()
      if (task.status !== 'success') message.error(t('social.sync.failed', { msg: codeText(task.errorCode ?? undefined, {}, task.error ?? task.status) }))
      else if (res.outcome === 'skipped') message.info(t('social.sync.skipped', { msg: codeText(res.code, {}, res.code ?? '') }))
      else {
        const text = res.result && te(`social.sync.result.${res.result}`) ? t(`social.sync.result.${res.result}`) : res.result ?? ''
        if (res.feed?.code) message.warning(`${text} · ${t('feed.syncFeedNotQueued', { msg: codeText(res.feed.code, {}, res.feed.code) })}`)
        else if (res.result === 'created' || res.result === 'updated') message.success(text)
        else message.warning(text)
      }
    } catch (e) { done(); message.error(errorText(e)) }
    finally { if (cur.step === 'account') onAccountStep(accountId) }
  }

  const off = store.onTaskEvent((ev) => {
    if (ev.type !== 'task.updated' || !['success', 'failed', 'cancelled'].includes(ev.task.status)) return
    const hit = Object.entries(syncing.value).find(([, s]) => s.taskId === ev.task.id)
    if (hit) void syncFinished(hit[0], hit[1])
  })
  onBeforeUnmount(off)

  return { syncing, syncLabel, syncDisabled, syncNow }
}
