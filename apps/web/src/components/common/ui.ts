import { Modal } from 'ant-design-vue'
import type { TablePaginationConfig } from 'ant-design-vue'
import { t } from '../../i18n'

/**
 * Shared table / dialog conventions (docs/09-ui-guidelines.md). Constants and tiny helpers only:
 * pages keep using <a-table>, <a-modal>, <a-drawer> directly.
 */

/** Default <a-table size> for list pages; nested tables inside cards, drawers and modals use 'small'. */
export const TABLE_SIZE = 'middle' as const

/**
 * Standard pagination: "共 n 条" total plus a page-size changer.
 * Client-side lists: `pagination({ defaultPageSize: 50 })` (never `pageSize`: that pins the size and breaks the
 * size changer); server-side lists are controlled: `pagination({ current, pageSize, total })` + @change.
 * `totalText` overrides the "共 n 条" label (e.g. a page-specific t('social.total')).
 */
export function pagination(o: TablePaginationConfig & { totalText?: (n: number) => string } = {}): TablePaginationConfig {
  const { totalText, ...rest } = o
  return {
    defaultPageSize: 20,
    showSizeChanger: true,
    pageSizeOptions: ['10', '20', '50', '100'],
    showTotal: totalText ?? ((n: number) => t('common.total', { n })),
    ...rest,
  }
}

/** Right-fixed action column; cells hold <a-space :size="0"> of `type="link" size="small"` buttons, 3 at most + 更多. */
export function actionColumn(width: number, extra: Record<string, unknown> = {}) {
  return { title: t('common.action'), key: 'ops', width, fixed: 'right' as const, ...extra }
}

/** Dialog widths: small forms / confirms, standard forms, wide forms or tables. Drawers: forms, details. */
export const MODAL_WIDTH = { sm: 480, md: 640, lg: 800 } as const
export const DRAWER_WIDTH = { md: 520, lg: 760 } as const

/** Destructive confirm (delete, unbind, batch delete): red OK button labelled 删除 unless told otherwise. */
export function confirmDanger(o: { title: string; content?: string; okText?: string; onOk: () => unknown }) {
  return Modal.confirm({
    title: o.title, content: o.content, okType: 'danger', okText: o.okText ?? t('common.delete'), cancelText: t('common.cancel'),
    onOk: o.onOk as () => Promise<void>,
  })
}

/** Non-destructive confirm (role change, retry, power on): primary OK button. */
export function confirmAction(o: { title: string; content?: string; okText?: string; onOk: () => unknown }) {
  return Modal.confirm({
    title: o.title, content: o.content, okText: o.okText ?? t('common.ok'), cancelText: t('common.cancel'),
    onOk: o.onOk as () => Promise<void>,
  })
}
