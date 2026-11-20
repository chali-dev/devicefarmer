# 自媒体管理平台（MVP）

Node.js + TypeScript 控制平面，管理运行在 Linux 宿主上的 redroid Android 容器，复用 DeviceFarmer STF 的设备管理与远程控制能力。

```
浏览器 (Vue 3 + Ant Design Vue + Pinia)
   │  HTTP /api/*  ·  WS /api/events（状态推送） ·  WS /api/instances/:id/session（屏幕+输入）
   ▼
API (Fastify + TS) ── RBAC 网关，STF 不对最终用户暴露
   ├─ RuntimeAdapter ── Docker Engine API ──► Linux 宿主: redroid 容器（独立数据目录 + 独立网络命名空间）
   ├─ AdbAdapter ────── 共享 adb server ────► adb connect <host>:<port>
   ├─ StfAdapter ────── STF REST + websocket（服务账号）► STF（设备管理 / 屏幕流 / 输入）
   ├─ BullMQ (Redis) ── 实例生命周期任务队列
   ├─ Monitor ───────── 每 5s 对账 Docker/adb/STF 状态，自动重连 adb
   └─ PostgreSQL ────── 用户、实例、授权、任务
```

实例生命周期（Docker）与设备控制（adb/STF）是分离的两层：`modules/instances/ops.ts` 只编排二者，适配器彼此独立。

## 目录

| 路径 | 说明 |
|---|---|
| `apps/api` | 后端（Fastify）。`src/adapters/` 为 Docker/adb/STF 适配器 |
| `apps/web` | 前端（Vite + Vue 3 Composition API） |
| `infra/stf` | STF 独立部署（STF + RethinkDB + 多架构 adb server） |
| `infra/lima` | macOS 开发用 Linux 宿主（Lima VM，带 binder） |
| `docker-compose.dev.yml` | 开发依赖：PostgreSQL、Redis |
| `docs/` | 兼容性验证报告等 |

## 本地运行（macOS 开发）

前置：Docker Desktop、Node 22+、Lima（`brew install lima`）。

```bash
# 1. Linux 宿主（redroid 需要 binder，Docker Desktop 内核没有）
limactl start --name=redroid infra/lima/redroid-host.yaml

# 2. STF 与开发依赖
docker compose -f infra/stf/docker-compose.yml up -d --build
docker compose -f docker-compose.dev.yml up -d

# 3. 配置与数据库
cp .env.example .env        # 修改 JWT_SECRET / ADMIN_PASSWORD，DOCKER_HOST 中的 $HOME 写成绝对路径
npm install
npm run db:migrate && npm run db:seed   # 初始数据：内置管理员、demo-user（设置了 DEMO_USER_PASSWORD 时）、1 个公共示例素材、3 个公共人设

# 4. 启动
npm run dev:api             # http://127.0.0.1:3000  （健康检查 /api/health）
npm run dev:web             # http://localhost:5173  用 .env 中的 ADMIN_USERNAME / ADMIN_PASSWORD 登录
```

## 测试（全部连接真实环境，无 Mock）

```bash
cd apps/api
# 适配器冒烟：建容器→启动→adb→STF→占用→按键/点击/粘贴→清理
npx tsx --env-file=../../.env scripts/smoke-adapters.ts
# 端到端（需 API 已启动）：认证、批量创建/重启/停止/启动/删除、远程控制、APK 安装、RBAC、隔离性
npx tsx --env-file=../../.env scripts/e2e.ts path/to/any.apk
```

最近一次结果：e2e 32/32 通过（2026-11-14），另在浏览器中手工验证了登录、创建、实时状态、点击/滑动/按键/中文输入、授权与只读用户隔离。

## 角色

| 角色 | 权限 |
|---|---|
| admin（管理员） | 全部设备；创建/删除设备；用户管理、权限管理（设备授权）、存储设置；删除应用库/素材库条目 |
| user（用户） | 仅被授权的设备：查看、远程控制、截图、上传文件、启停/重启、安装/卸载应用、代理与设备设置、推送素材/应用库应用、导入应用库、上传素材 |

`.env` 中 `ADMIN_USERNAME` 对应的账号是内置管理员（`npm run db:seed` 标记）：不可删除、禁用或修改角色，密码只能由其本人修改。系统始终至少保留一个启用的管理员。

## 已知限制 / 后续

- **代理（sing-box）尚未实现**：计划为每实例增加 sing-box 容器持有网络命名空间（redroid 以 `network_mode: container:` 加入），实现 HTTP/SOCKS5 出口、断线阻断（kill switch）与出口检测。
- **Docker Compose 一体化部署**（API/Web 镜像）尚未打包；当前为开发模式运行。
- Docker-Android 引擎仅在 `AndroidRuntime` 接口与 `engine` 字段中预留，未实现。
- STF 使用 mock 认证（仅限内网服务账号）；生产环境应切换 STF 的 OAuth/LDAP 认证单元，且 STF 端口不可对外暴露。
- 本机 Lima VM 4 GiB 内存只适合 3 台实例；5 台需 6–8 GiB，20–50 台需独立 Linux 服务器（`DOCKER_HOST=tcp://...` + TLS）。
- 前端打包体积较大（全量引入 Ant Design Vue），后续按需引入。
