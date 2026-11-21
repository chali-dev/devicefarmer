# 自媒体管理平台

Node.js + TypeScript 控制平面，管理云手机（目前是比特云手机，以后对接其他云手机商），复用 DeviceFarmer STF 的设备管理与远程控制能力。本机 redroid 容器已于 2026-11-20 移除。

```
浏览器 (Vue 3 + Ant Design Vue + Pinia)
   │  HTTP /api/*  ·  WS /api/events（状态推送） ·  WS /api/instances/:id/session（屏幕+输入）
   ▼
API (Fastify + TS) ── RBAC 网关，STF 不对最终用户暴露
   ├─ 设备来源驱动 ──── 比特客户端本地 API（开关机、必装应用）+ SSH 隧道 ► 云手机 adbd
   ├─ AdbAdapter ────── 共享 adb server ────► adb connect <host>:<port>
   ├─ StfAdapter ────── STF REST + websocket（服务账号）► STF（设备管理 / 屏幕流 / 输入）
   ├─ 任务中心 ──────── BullMQ (Redis)
   ├─ Monitor ───────── 每 15s 对账电源/adb/STF 状态，自动重连 adb
   └─ PostgreSQL ────── 用户、设备、授权、任务、业务数据
```

## 目录

| 路径 | 说明 |
|---|---|
| `apps/api` | 后端（Fastify）。`src/adapters/` 为 adb / STF / 比特客户端适配器，`src/modules/sources/` 为设备来源驱动 |
| `apps/web` | 前端（Vite + Vue 3 Composition API） |
| `infra/stf` | STF 独立部署（STF + RethinkDB + 多架构 adb server） |
| `infra/device-tools` | scrcpy-server 与手机端辅助程序（app_process） |
| `deploy/` | 生产部署（蓝绿，docs/10-deployment.md） |
| `docker-compose.dev.yml` | 开发依赖：PostgreSQL、Redis |
| `docs/` | 部署、比特云、界面规范等文档 |

## 本地运行（macOS 开发）

前置：Docker Desktop、Node 22+、比特客户端（设备来源在页面里配置，见 docs/08-bitbrowser-deployment.md）。

```bash
# 1. STF 与开发依赖
docker compose -f infra/stf/docker-compose.yml up -d --build
docker compose -f docker-compose.dev.yml up -d

# 2. 配置与数据库
cp .env.example .env        # 修改 JWT_SECRET / ADMIN_PASSWORD
npm install
npm run db:migrate && npm run db:seed   # 初始数据：内置管理员、必装应用（Instagram、YouTube）、示例素材与人设

# 3. 启动
npm run dev:api             # http://127.0.0.1:3000  （健康检查 /api/health）
npm run dev:web             # http://localhost:5173  用 .env 中的 ADMIN_USERNAME / ADMIN_PASSWORD 登录
```

## 测试（全部连接真实环境，无 Mock）

集成检查脚本在 `apps/api/scripts/`，说明见 CLAUDE.md。不需要手机的那部分由 `CI_ENV_FILE=<env file> apps/api/scripts/ci-checks.sh` 一起跑（Deploy 工作流的 test 任务）。

## 角色

| 角色 | 权限 |
|---|---|
| admin（管理员） | 全部设备；添加/删除设备、开关机；用户管理、权限管理、存储设置；应用库与必装应用 |
| user（用户） | 仅分配给自己的设备：查看、远程控制、截图、上传文件、推送素材 |

`.env` 中 `ADMIN_USERNAME` 对应的账号是内置管理员（`npm run db:seed` 标记）：不可删除、禁用或修改角色，密码只能由其本人修改。系统始终至少保留一个启用的管理员。
