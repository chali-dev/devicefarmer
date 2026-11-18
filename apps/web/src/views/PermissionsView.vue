<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { DeleteOutlined, EditOutlined, MoreOutlined, PlusOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import type { CustomRole } from '../api/types'
import { dateLocale } from '../i18n'
import PageContainer from '../components/common/PageContainer.vue'
import { MENU_GROUPS, navLabel } from '../components/common/menu'
import { confirmDanger, MODAL_WIDTH } from '../components/common/ui'

/**
 * 权限管理 (账号管理, admin): 角色菜单权限. Columns = 管理员 (fixed, everything) | 普通用户 (GET/PUT
 * /api/settings/role-menus) | every 自定义角色 (/api/roles: a variant of the user role, same data scope, own menus).
 * One 保存 writes every changed column. The dashboard is always on and admin-only menus cannot be granted to any role
 * (shown greyed). The API enforces it too (403 rbac.menu_disabled).
 */
interface RoleMenus {
  menus: string[]; defaults: string[]; grantable: string[]; updatedAt: string | null
  fixed: { always: string[]; adminOnly: string[] }
}
const USER = '__user'
const { t } = useI18n()
const state = ref<RoleMenus | null>(null)
const roles = ref<CustomRole[]>([])
/** Column key (USER or a role id) → ticked menus. */
const picked = reactive<Record<string, string[]>>({})
const saving = ref(false)
const loaded = ref(false)

const same = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join()
async function load() {
  try {
    const [m, r] = await Promise.all([
      api<RoleMenus>('GET', '/api/settings/role-menus'),
      api<{ roles: CustomRole[] }>('GET', '/api/roles'),
    ])
    state.value = m
    roles.value = r.roles
    for (const k of Object.keys(picked)) delete picked[k]
    picked[USER] = [...m.menus]
    for (const role of r.roles) picked[role.id] = [...role.menus]
    loaded.value = true
  } catch (e) { message.error(errorText(e)) }
}
onMounted(load)

/** Sidebar order: dashboard, then every group's items; each row says whether it can be granted. */
const rows = computed(() => {
  const s = state.value
  const kind = (k: string) => (!s ? 'adminOnly' : s.grantable.includes(k) ? 'grantable' : s.fixed.always.includes(k) ? 'always' : 'adminOnly')
  return [
    { group: null as string | null, items: [{ key: 'dashboard', kind: kind('dashboard') }] },
    ...MENU_GROUPS.map((g) => ({ group: g.flat ? null : g.key, items: g.items.map((it) => ({ key: it.key, kind: kind(it.key) })) })),
  ]
})
const columns = computed(() => [
  { key: USER, saved: state.value?.menus ?? [] },
  ...roles.value.map((r) => ({ key: r.id, saved: r.menus })),
])
const changedKeys = computed(() => columns.value.filter((c) => picked[c.key] && !same(picked[c.key]!, c.saved)).map((c) => c.key))
const isDefault = computed(() => !!state.value && same(picked[USER] ?? [], state.value.defaults))

function toggle(col: string, key: string, on: boolean) {
  const cur = picked[col] ?? []
  picked[col] = on ? [...new Set([...cur, key])] : cur.filter((k) => k !== key)
}
async function save() {
  saving.value = true
  try {
    for (const key of changedKeys.value) {
      if (key === USER) {
        const m = await api<RoleMenus>('PUT', '/api/settings/role-menus', { menus: picked[USER] })
        state.value = m
        picked[USER] = [...m.menus]
      } else {
        const { role } = await api<{ role: CustomRole }>('PATCH', `/api/roles/${key}`, { menus: picked[key] })
        roles.value = roles.value.map((r) => (r.id === role.id ? role : r))
        picked[key] = [...role.menus]
      }
    }
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
function discard() {
  picked[USER] = [...(state.value?.menus ?? [])]
  for (const r of roles.value) picked[r.id] = [...r.menus]
}

// role create / edit (name + description); the menus are edited in the table
const edit = reactive({ open: false, id: null as string | null, name: '', description: '', busy: false })
function openCreate() { Object.assign(edit, { open: true, id: null, name: '', description: '' }) }
function openEdit(r: CustomRole) { Object.assign(edit, { open: true, id: r.id, name: r.name, description: r.description ?? '' }) }
async function submitEdit() {
  const name = edit.name.trim()
  if (!name) return message.error(t('roleMenus.roleNameRequired'))
  edit.busy = true
  try {
    if (edit.id) {
      const { role } = await api<{ role: CustomRole }>('PATCH', `/api/roles/${edit.id}`, { name, description: edit.description.trim() || null })
      roles.value = roles.value.map((r) => (r.id === role.id ? role : r))
    } else {
      const { role } = await api<{ role: CustomRole }>('POST', '/api/roles', { name, description: edit.description.trim() || null, menus: state.value?.menus ?? [] })
      roles.value = [...roles.value, role]
      picked[role.id] = [...role.menus]
    }
    message.success(t('common.saved'))
    edit.open = false
  } catch (e) { message.error(errorText(e)) }
  finally { edit.busy = false }
}
function remove(r: CustomRole) {
  if (r.userCount > 0) return message.warning(t('roleMenus.deleteInUse', { n: r.userCount }))
  confirmDanger({
    title: t('roleMenus.deleteConfirm', { name: r.name }), content: t('roleMenus.deleteContent'),
    onOk: async () => {
      try {
        await api('DELETE', `/api/roles/${r.id}`)
        roles.value = roles.value.filter((x) => x.id !== r.id)
        delete picked[r.id]
        message.success(t('common.deleted'))
      } catch (e) { message.error(errorText(e)); await load() }
    },
  })
}
</script>

<template>
  <PageContainer :subtitle="t('roleMenus.subtitle')">
    <template #extra>
      <a-button type="primary" :disabled="!loaded" @click="openCreate"><template #icon><PlusOutlined /></template>{{ t('roleMenus.addRole') }}</a-button>
    </template>
    <a-card :bordered="false">
      <a-spin :spinning="!loaded">
        <a-alert type="info" show-icon class="block" :message="t('roleMenus.hint')" />
        <div class="scroll">
          <table class="grid">
            <thead>
              <tr>
                <th>{{ t('roleMenus.menu') }}</th>
                <th class="c">{{ t('roleMenus.roleAdmin') }}<div class="sub muted">{{ t('roleMenus.builtinRole') }}</div></th>
                <th class="c">{{ t('roleMenus.roleUser') }}<div class="sub muted">{{ t('roleMenus.builtinRole') }}</div></th>
                <th v-for="r in roles" :key="r.id" class="c">
                  <div class="head">
                    <a-tooltip :title="r.description || null"><span class="name">{{ r.name }}</span></a-tooltip>
                    <a-dropdown :trigger="['click']">
                      <a-button type="text" size="small" :aria-label="t('common.more')"><template #icon><MoreOutlined /></template></a-button>
                      <template #overlay>
                        <a-menu>
                          <a-menu-item key="edit" @click="openEdit(r)"><EditOutlined /> {{ t('roleMenus.editRole') }}</a-menu-item>
                          <a-menu-item key="delete" danger @click="remove(r)"><DeleteOutlined /> {{ t('roleMenus.deleteRole') }}</a-menu-item>
                        </a-menu>
                      </template>
                    </a-dropdown>
                  </div>
                  <div class="sub muted">{{ t('roleMenus.userCount', { n: r.userCount }) }}</div>
                </th>
              </tr>
            </thead>
            <tbody>
              <template v-for="(row, ri) in rows" :key="ri">
                <tr v-if="row.group" class="group"><td :colspan="3 + roles.length">{{ t(`nav.group.${row.group}`) }}</td></tr>
                <tr v-for="it in row.items" :key="it.key">
                  <td :class="{ indent: row.group }">
                    {{ navLabel(it.key) }}
                    <a-tag v-if="it.kind === 'always'" class="tag">{{ t('roleMenus.always') }}</a-tag>
                    <a-tag v-else-if="it.kind === 'adminOnly'" class="tag">{{ t('roleMenus.adminOnly') }}</a-tag>
                  </td>
                  <td class="c"><a-checkbox :checked="true" disabled /></td>
                  <td v-for="col in columns" :key="col.key" class="c">
                    <a-checkbox
                      v-if="it.kind === 'grantable'" :checked="(picked[col.key] ?? []).includes(it.key)" :aria-label="navLabel(it.key)"
                      @change="(e: any) => toggle(col.key, it.key, e.target.checked)"
                    />
                    <a-checkbox v-else :checked="it.kind === 'always'" disabled />
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <a-space wrap class="actions">
          <a-button type="primary" :loading="saving" :disabled="!changedKeys.length" @click="save">{{ t('common.save') }}</a-button>
          <a-button :disabled="!changedKeys.length || saving" @click="discard">{{ t('common.cancel') }}</a-button>
          <a-button :disabled="!state || isDefault" @click="picked[USER] = [...(state?.defaults ?? [])]">{{ t('roleMenus.restoreDefault') }}</a-button>
          <span v-if="changedKeys.length" class="warn small">{{ t('roleMenus.unsaved') }}</span>
          <span v-else-if="state?.updatedAt" class="muted small">{{ t('settings.updatedAt', { at: new Date(state.updatedAt).toLocaleString(dateLocale()) }) }}</span>
        </a-space>
      </a-spin>
    </a-card>
  </PageContainer>

  <a-modal
    v-model:open="edit.open" :title="edit.id ? t('roleMenus.editRole') : t('roleMenus.addRole')" :width="MODAL_WIDTH.sm"
    :ok-text="edit.id ? t('common.save') : t('common.create')" :cancel-text="t('common.cancel')" :confirm-loading="edit.busy" @ok="submitEdit"
  >
    <a-form layout="vertical">
      <a-form-item :label="t('roleMenus.roleName')" required :extra="t('roleMenus.roleNameHint')">
        <a-input v-model:value="edit.name" :maxlength="32" />
      </a-form-item>
      <a-form-item :label="t('roleMenus.roleDescription')">
        <a-textarea v-model:value="edit.description" :maxlength="200" :auto-size="{ minRows: 2, maxRows: 4 }" />
      </a-form-item>
      <a-alert v-if="!edit.id" type="info" show-icon :message="t('roleMenus.newRoleMenus')" />
    </a-form>
  </a-modal>
</template>

<style scoped>
.block { margin-bottom: 16px; }
.scroll { overflow-x: auto; }
.grid { min-width: 480px; border-collapse: collapse; }
.grid th, .grid td { padding: 8px 12px; border-bottom: 1px solid var(--cp-border-secondary); text-align: start; }
.grid th { font-weight: 600; color: var(--cp-text-secondary); vertical-align: top; }
.grid .c { text-align: center; min-width: 110px; }
.grid .group td { font-weight: 600; background: var(--cp-bg-layout); }
.head { display: inline-flex; align-items: center; gap: 2px; }
.name { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { font-weight: 400; font-size: 12px; }
.indent { padding-inline-start: 28px !important; }
.tag { margin-inline-start: 8px; }
.actions { margin-top: 16px; }
.warn { color: var(--cp-warning); }
</style>
