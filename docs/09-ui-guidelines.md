# 09 前端 UI 规范（Ant Design Pro 风格）

目标：所有后台页面看起来、用起来一致。优先用 Ant Design Vue 原生组件，少写自定义 CSS，颜色只用 token。
**只改 UI/UX，不改业务逻辑、API 调用、数据、权限、路由。**

## 1. 主题与全局样式

- `src/theme.ts`：默认**亮色**（新用户；已保存的 system/dark 选择保留），主色 `#1677FF`，圆角 6，字号 14。改全局视觉只改这里的 `TOKENS`。
- `components/ThemeVars.vue` 把 token 发布为 CSS 变量：`--cp-bg-layout/-container`、`--cp-text(-secondary/-tertiary/-quaternary)`、`--cp-border(-secondary)`、`--cp-fill-alter`、`--cp-bg-hover`、`--cp-primary(-bg)`、`--cp-success/-warning/-error`、`--cp-radius(-lg)`、`--cp-shadow`、`--cp-mask`、`--cp-green/yellow/orange/red`。不要写死颜色。
- `src/styles/global.css`（main.ts 引入）：
  - 布局节奏：`--cp-page-padding`（24px，≤640px 为 12px）、`--cp-gap`（16px / 12px）。
  - 文本工具类（**不要再在页面里重复声明**）：`.muted`（三级文字色）、`.faint`、`.small`（12px）、`.mono`（等宽）、`.nowrap`、`.ellipsis`。
  - 全局修正：抽屉不超过屏宽、抽屉 footer 右对齐、表格内部横向滚动、窄屏卡片头换行、窄屏 Modal 不溢出。

## 2. 布局（`views/AppLayout.vue`）

- 左侧亮色菜单（`MENU_GROUPS`，在 `components/common/menu.ts`，四个模块：云手机管理 / 媒体矩阵 / 内容中心 / 系统管理），顶部 56px 白色 header：折叠按钮 + 面包屑 + 右侧（连接告警、通知、主题、语言、用户）。sider 与 header 固定，仅内容滚动。
- 面包屑 = `nav.group.<group>` › `nav.<item>`（设备详情再加设备名），全部来自菜单数据 + i18n。新增页面：在 `MENU_GROUPS` 加 item，`nav.<key>` 加文案即可。
- 内容区 padding = `--cp-page-padding`，背景 `--cp-bg-layout`。

## 3. 公共组件（`src/components/common/`）

| 文件 | 用途 | API |
| --- | --- | --- |
| `PageContainer.vue` | 每个页面的外框 | props：`title?`（默认取菜单名）、`subtitle?`；slots：`extra`（右上角按钮，自动 `a-space wrap`）、`title-suffix`（标题旁的帮助按钮/标签）、`subtitle`、`title`、default（内容块，按 `--cp-gap` 纵向排列） |
| `SearchBar.vue` | 表格上方的筛选栏 | default slot 放筛选控件（自己设 `style="width: …"`）；监听了才显示按钮：`@search`（查询，主按钮）、`@reset`（重置）、`@refresh`（刷新图标，配 `:loading`）；`#actions` 右对齐（批量按钮、统计文字）。自动换行 |
| `StatusTag.vue` | 统一状态显示 | `<StatusTag kind="proxy" :status="x.status" />`；`kind` 默认 `instance`（徽标样式），其余默认 tag；`badge` 强制徽标；默认 slot 追加内容 |
| `status.ts` | 状态族 → 颜色 + 文案 | `STATUS_FAMILIES`：instance、task、proxy、socialLogin、socialAccount、tracked、content、publish、comment、commentReply、media、backup。另有 `statusColor/statusLabel/statusBadge`。新状态族在这里加一条 |
| `StatCard.vue` | KPI 数字卡 | props：`title`、`value`、`suffix?`、`icon?`（图标组件）、`footer?`（或 `#footer`）、`to?`（整卡链接）、`tone?`（error/warning/success，值>0 时上色）、`loading?` |
| `ui.ts` | 表格 / 弹窗约定 | `TABLE_SIZE`（'middle'）、`pagination(opts)`、`actionColumn(width)`、`MODAL_WIDTH {sm 480, md 640, lg 800}`、`DRAWER_WIDTH {md 520, lg 760}`、`confirmDanger({title, content?, okText?, onOk})`、`confirmAction(...)` |
| `menu.ts` | 菜单数据 + 当前位置 | `MENU_GROUPS`、`MENU_KEYS`、`useMenuLocation()` → `{ itemKey, group, title }` |

仪表盘内部的小数字格 `components/dashboard/StatLink.vue` 保留（卡片内的多列数字）。

## 4. 页面结构

```vue
<PageContainer :title="t('xxx.title')" :subtitle="…">
  <template #extra>
    <a-button>次要操作</a-button>
    <a-button type="primary"><template #icon><PlusOutlined /></template>新建</a-button>
  </template>
  <a-alert … />                      <!-- 可选：页面级提示，不要再加 margin -->
  <a-card :bordered="false">
    <SearchBar :loading="loading" @reset="reset" @refresh="load">
      <a-input-search … style="width: 240px" />
      <a-select … style="width: 130px" />
      <template #actions>统计 / 批量按钮</template>
    </SearchBar>
    <a-table … />
  </a-card>
</PageContainer>
```

- 不再用 `<a-card :title size="small">` 包整页：标题进 PageContainer，内容卡 `:bordered="false"`（默认尺寸，内边距 24；窄屏自动 12）。
- 页面内多个区块 = 多个 `a-card :bordered="false"`；页内 tabs 放在卡片里（`a-tabs`），或像代理页用 `a-segmented` 放在卡片上方。
- 主按钮最多一个（新建/添加），放 `extra` 最右，带 `PlusOutlined`。
- 删除旧的 `.page-head` / `.toolbar` / `.muted` / `.small` 等样式。

## 5. 表格

- `:size="TABLE_SIZE"`（列表页）；卡片/抽屉/弹窗里的子表格用 `size="small"`。
- 分页：
  - 前端分页：`:pagination="pagination({ defaultPageSize: 50 })"`（**不要传 `pageSize`**，否则切换每页条数无效）。
  - 后端分页：`:pagination="pagination({ current: page.current, pageSize: page.pageSize, total })"` + `@change`。
  - 小列表可加 `hideOnSinglePage: true`；自定义总数文案用 `totalText: (n) => t('xxx.total', { n })`。
- 操作列：`actionColumn(width)`（标题“操作”，固定在右侧）。单元格 `<a-space :size="0">` + `a-button type="link" size="small"`，最多 3 个，其余放“更多”`a-dropdown`（`t('common.more')`）；删除用 `danger`，不可用时 `disabled` + `a-tooltip` 说明原因。
- 一律设置 `:scroll="{ x: 列宽之和 }"`，列给 `width`，长文本用 `a-typography-text :ellipsis`。
- 空状态：默认空即可；有“新建”或“清除筛选”意义时用 `#emptyText` 放 `a-empty` + 按钮（参考 ProxiesView）。
- 加载：`:loading="loading"`；首次整块加载用 `a-spin`。
- 批量操作：选中后在表格上方显示批量条（参考 SocialAccountsView `.batch-bar`）。

## 6. 状态显示

一律 `<StatusTag kind=… :status=… />`，不要再写 `<a-tag :color="XXX_COLOR[s]">{{ t('…') }}</a-tag>`。颜色语义：success=成功/正常，processing=进行中，warning=需注意，error=失败，default=空闲/中性，purple=已计划，gold=待审核。非状态的分类标签（平台、角色、类型）继续用普通 `a-tag` / `PlatformTag`。

## 7. 表单、Modal、Drawer

- 新建/编辑：字段 ≤ 6 个用 **Modal**（`MODAL_WIDTH.sm/md`），更多字段或分组用 **Drawer**（`DRAWER_WIDTH.md`，复杂编辑器 `lg`）。详情/日志一律 **Drawer**（`md` 或 `lg`）。
- 表单一律 `layout="vertical"`，两列用 `a-row :gutter="12"` + `a-col :xs="24" :sm="12"`；校验用 `rules` + `formRef.validate()`。
- 按钮顺序：取消 在左，主操作 在右（Modal 默认即如此；Drawer 在 `#footer` 里直接放按钮，全局样式右对齐，不要 `float`）。保存中用 `:confirm-loading` / `:loading`。
- 删除等不可逆操作：`confirmDanger({ title, content?, onOk })`（红色“删除”按钮）；其他需确认的操作：`confirmAction`。行内的轻量确认（取消任务、重试）可用 `a-popconfirm`。
- 只读详情用 `a-descriptions`（`bordered size="small"`，`:column="{ xs: 1, sm: 2 }"`）。

## 8. 仪表盘

- 顶部 KPI 行：`StatCard` × 4（`:xs="24" :sm="12" :xl="6"`），每张可点击到对应列表。
- 下方模块卡：`a-card size="small" :bordered="false"`，标题 + `extra` “查看全部”，`a-row :gutter="[16, 16]"`，`:xs="24" :md="12" :xl="8"`；趋势图用现有 `tracked/LineChart.vue`。

## 9. 响应式

- 桌面优先，验证 1280 / 1024 宽度，以及 ≤640 不出现横向滚动。
- 栅格用 `a-col` 的 `xs/sm/md/lg/xl`；筛选控件固定宽度但会换行（SearchBar 已处理）；表格靠 `scroll.x` 内部滚动；弹窗/抽屉已全局限制最大宽度。
- 不写死 `px` 的页面宽度；需要时用 `max-width: 100%`。

## 10. 改造一个页面的清单

1. 外层换成 `PageContainer`（标题、副标题、`extra` 按钮），删掉自写的页头。
2. 内容放进 `a-card :bordered="false"`；筛选区换成 `SearchBar`（原有的“改变即查询”行为保持不变，只是不加查询按钮）。
3. 表格：`TABLE_SIZE`、`pagination(...)`、`actionColumn(...)`、`scroll.x`、空状态。
4. 状态 tag → `StatusTag`；`Modal.confirm` 删除 → `confirmDanger`。
5. Modal/Drawer 宽度用 `MODAL_WIDTH` / `DRAWER_WIDTH`，表单 `layout="vertical"`，抽屉 footer 去掉 float。
6. 删掉与 global.css 重复的样式（`.muted/.small/.mono/.faint`），剩余样式只用 `--cp-*` 变量。
7. 新文案同时加到 `zh-CN.ts` 和 `en.ts`（键必须一致）。
8. `npm run typecheck` + `npm run build --workspace apps/web`；浏览器亮/暗、中/英、1280/1024 检查；行为不变（同样的请求、同样的按钮效果）。

## 11. 现状与剩余工作

已完成（第 1 阶段）：主题、布局、公共组件；`DashboardView`、`ProxiesView`、`SocialAccountsView` 已按规范改造。

剩余页面（按菜单模块分工）：

**A. 云手机管理**
- `views/InstancesView.vue`（799 行，网格/表格双视图 + 自定义 `.toolbar`）：外框换 PageContainer，工具栏保留功能但统一按钮/间距；表格部分按第 5 节；创建 Modal 已是 800 宽 → `MODAL_WIDTH.lg`；多处 `Modal.confirm`。
- `views/InstanceDetailView.vue`：多卡片详情页；PageContainer（标题=设备名，`extra`=电源操作），卡片 `:bordered="false"`，`a-descriptions` 统一。
- `views/LibraryView.vue`：标准列表 + 安装 Modal。
- 组件：`CloudPhoneDrawer.vue`、`DeviceLogDrawer.vue`（任务状态 → `StatusTag kind="task"`）、`DeviceThumb.vue`、`DevicePlayer.vue`（只看样式，不动逻辑）、`social/DeviceSocialCard.vue`。

**B. 媒体矩阵**
- `views/AnalyticsView.vue`（统计数字 → 可用 `StatCard`；详情 Drawer 760 → `DRAWER_WIDTH.lg`）。
- `views/TrackedAccountsView.vue`（列表 + 两个 Modal；分页是自定义 onChange，换 `pagination()` 时保持后端分页）。
- `views/CommentsView.vue`（tabs + 列表 + 3 个 Modal；状态 → `StatusTag kind="comment"/"commentReply"/"task"`）。
- 组件：`comments/CommentDrawer.vue`、`tracked/TrackedAccountDrawer.vue`、`tracked/LineChart.vue`、`analytics/TrendCharts.vue`、`social/PlatformTag.vue`。

**C. 内容中心**
- `views/MediaView.vue` + `components/media/MediaPanel.vue`（状态 → `kind="media"`）、`MediaUploader.vue`、`CategoryManager.vue`。
- `views/ScriptsView.vue`、`views/TrendingView.vue`（标准列表 + 设置 Modal）。
- `views/ContentView.vue`（编辑 Drawer `min(760px,100vw)` → `DRAWER_WIDTH.lg`；footer 去 float；状态 → `kind="content"/"publish"`）。
- `views/PublishView.vue`（日历 + 列表；`kind="publish"`）。
- 组件：`content/DistributeModal.vue`、`MediaPicker.vue`、`MediaStrip.vue`、`TemplateInsert.vue`、`publish/PublishTaskDrawer.vue`。

**D. 系统管理**
- `views/UsersView.vue`（最简单的 CRUD，可作为第一个练手页）、`views/PermissionsView.vue`、`views/AuditView.vue`（后端分页 + 日期筛选）、`views/TasksView.vue`（tabs + 后端分页 + 详情 Drawer，`kind="task"`）、`views/SystemView.vue`、`views/SettingsView.vue`（tabs 外框）。
- 组件：`settings/*`（7 个设置面板：统一 `a-form layout="vertical"`、保存按钮位置）、`system/BackupPanel.vue`（`kind="backup"`）、`system/LogPanel.vue`、`notify/NotificationBell.vue`。
- `views/LoginView.vue`：独立页面，只需对齐主题。

**共享文件（易冲突）**：`i18n/zh-CN.ts`、`i18n/en.ts`（只在自己模块的命名空间里加键；需要 `common.*` 新键时先和负责人确认）、`components/common/*`、`styles/global.css`、`api/types.ts`（颜色常量）。公共组件需要新能力时，先提给负责人统一改，不要各自修改。
