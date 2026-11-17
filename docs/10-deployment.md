# 生产部署：GitHub Actions + Docker 镜像 + 蓝绿切换

> 状态（2026-11-17）：镜像、蓝绿脚本和 workflow 已在本机 Docker Desktop 上模拟服务器实测（见 §8）。
> **未验证**：真实的 GHCR 推送/拉取、真实 SSH 部署、Let's Encrypt TLS、Linux 主机上的 docker0/host-gateway 组合（docs/08 §5.4）、amd64 镜像构建（本机只构建了 arm64）。

## 1. 结构

```
                 :443 (TLS, Caddy 自动证书)
浏览器 ──────────► proxy (Caddy, 共享) ──/api/*, /scrcpy-relay*──► api-<活动色>  127.0.0.1:3101|3102 (+relay 3111|3112)
                                     └──其余──────────────────────► web-<活动色>  127.0.0.1:3201|3202 (静态文件)
共享、不切换：Postgres 17、Redis、proxy（compose 项目 cloudphone）、STF（infra/stf + deploy/stf.override.yml）
每种颜色 = 同一版本的 api + web（compose 项目 cloudphone-blue / cloudphone-green）
```

- 镜像：`ghcr.io/<owner>/<repo>-api:<版本>`、`-web:<版本>`，git sha 写在 label `org.opencontainers.image.revision`。
  - api（`deploy/docker/api.Dockerfile`，node:24 alpine，用户 node）：ssh 客户端（比特隧道）、pg_dump 17（备份，`PG_DUMP_CMD=pg_dump`）、ffmpeg/ffprobe、procps（pkill）、tini；构建时下载 scrcpy-server 并按 `fetch.sh` 里的 SHA-256 校验；两个 dex 辅助程序由官方 SDK zip 编译，zip 按 Google 公布的 sha1 校验（`infra/device-tools/fetch-sdk.sh`），这一层有缓存。`--build-arg DEX_HELPERS=0` 可跳过：此时安全画面源（secure）不可用、relay 关闭，其余功能不变。镜像里不需要 adb 可执行文件（API 用 STF 的 adb server）。
  - web（`deploy/docker/web.Dockerfile`）：Vite 构建产物 + 小 Caddy（用户 65534），SPA 回退到 index.html，`/assets/*` 长缓存，其余 `no-cache`。
- 所有容器用 **host 网络**：API 要访问宿主机回环上的比特客户端隧道 `127.0.0.1:54345` 和 STF，且比特 adb 隧道要绑在 docker0（`EXTERNAL_ADB_BIND=172.17.0.1`）上让 STF 的 adb 容器连到。Postgres/Redis/api/web 只监听 127.0.0.1，对外只有 Caddy 的 80/443。

### 重叠期间不能跑两份的东西（关键设计）

蓝绿切换时两种颜色会同时运行几秒到几分钟。处理方式：

| 项目 | 处理 |
|---|---|
| 任务 worker（BullMQ）、monitor（含比特隧道 5700–5799 的打开/续期）、审计/任务保留、每小时调度 | 只在 **leader** 进程运行：`BACKGROUND_WORK=leader` 时 API 用 Redis 租约 `cloudphone:leader:<db>`（SET NX PX 15 s，每 5 s 续期）竞选。新颜色启动后是 standby（只服务 HTTP），旧颜色收到 SIGTERM 后先停 HTTP、等正在跑的任务结束、关闭隧道，**最后**才释放租约，新颜色 2 s 内接手（先 `reconcileTasks`）。续期发现租约被别人拿走 → 进程退出、由 restart 策略以 standby 身份重启，绝不出现两个 leader。开发环境默认 `always`（行为不变）。 |
| API 端口 | 每色固定端口（3101/3102），proxy 切换 upstream。 |
| scrcpy relay 监听端口 | 每色一个（3111/3112），`/scrcpy-relay*` 随 proxy 一起切换（relay 会话在哪个进程发起就由哪个进程监听）。 |
| 设备 adb serial | 与颜色无关：redroid 是 `host.docker.internal:<5555–5604>`（sidecar 发布的端口），比特手机是 `host.docker.internal:<5700–5799>`（leader 绑在 docker0 上的 ssh 转发）。两色都在宿主机网络命名空间，STF 看到的 serial 不变。 |
| 迁移 | 每次部署在启动新颜色**之前**由 `deploy.sh` 单独执行一次（`node dist/db/migrate.js`，随后执行幂等的 seed）。应用启动时不跑迁移。 |
| 小时级调度 | 本来就幂等（idempotencyKey），而且只在 leader 上跑。 |

剩余风险（已知、可接受）：切换后约 `DRAIN_SECONDS`（默认 5 s）内旧 leader 仍可能领取任务；如果新版本在**已有队列**上新增了任务类型，旧 worker 会把它标成 `task.unknown_type`。新任务类型请放在新队列上，或接受这几秒的窗口。超过 `STOP_GRACE`（默认 120 s）还没结束的任务会被 SIGKILL，新 leader 按现有崩溃语义把它标成 `task.interrupted`（不会重跑）。

### 迁移必须向后兼容（expand / contract）

旧颜色在切换前一直跑在新 schema 上，回滚也是旧代码跑在新 schema 上（迁移从不回退）。所以：

1. **expand**：只加东西——新表、可空列或带默认值的列、新索引（大表用 `CREATE INDEX CONCURRENTLY` 的话要单独处理）。旧代码必须能无视它们照常工作。
2. 新代码上线并稳定（至少超过可回滚的 2 个版本）之后，才在后续版本里 **contract**：删列、改名、加 NOT NULL、删表。
3. 禁止在同一个版本里改名/删除旧代码还在用的列；改名 = 加新列 + 双写 + 回填，几版之后再删旧列。
4. drizzle 迁移照旧只追加（不改旧迁移）。旧版本的 migrator 遇到更新的数据库是 no-op（实测，§8）。

## 2. 服务器一次性准备（Ubuntu 24.04）

1. Docker Engine + compose 插件（官方 apt 源），`flock`、`curl` 自带。部署用户：`adduser deploy && usermod -aG docker deploy`。
2. 防火墙：供应商防火墙只放行 22、80、443。**Docker 发布的端口不受 ufw 控制**：redroid 的 sidecar 把 adb 端口发布在 0.0.0.0:5555–5604，必须在 `DOCKER-USER` 链挡住外部访问，例如
   `iptables -I DOCKER-USER -i <公网网卡> -p tcp --dport 5555:5604 -j DROP`（并持久化）。STF 端口由 `deploy/stf.override.yml` 绑到 127.0.0.1。
   STF adb 容器访问 docker0 上的比特隧道端口：`ufw allow in from 172.16.0.0/12 to 172.17.0.1 port 5700:5799 proto tcp`（docs/08 §5.1）。
3. 目录（`DEPLOY_DIR=/srv/cloudphone`）：
   ```bash
   sudo install -d -o deploy -g deploy /srv/cloudphone /srv/cloudphone/state /srv/cloudphone/instances
   sudo install -d -o 1000 -g 1000 /srv/cloudphone/data        # API 容器以 uid 1000 运行
   ```
   `deploy/` 由 workflow 每次部署时复制过去；第一次也可以手动 `scp -r deploy deploy@host:/srv/cloudphone/`。
4. 配置（都不进仓库，`chmod 600`）：
   - `/srv/cloudphone/deploy.env` ← `deploy/deploy.env.example`（镜像名、域名、Postgres 密码、端口）。
   - `/srv/cloudphone/app.env` ← `deploy/app.env.example`（API 环境变量，`DATABASE_URL` 的密码要和 deploy.env 一致）。
5. GHCR：workflow 每次用本次 job 的 `GITHUB_TOKEN`（只读 packages）在服务器上 `docker login`，结束后 `logout`，服务器上不留长期凭证。手动在服务器上执行 `rollback.sh` 时，如果镜像已在本地（默认保留历史里的版本）不需要登录；否则先用只读 PAT `docker login ghcr.io`。
6. STF：
   ```bash
   git clone <repo> /srv/cloudphone/src   # 只用 infra/stf 和 deploy/stf.override.yml
   cd /srv/cloudphone/src && STF_AUTH_SECRET=$(openssl rand -hex 24) \
     docker compose -f infra/stf/docker-compose.yml -f deploy/stf.override.yml up -d --build
   ```
   （把 `STF_AUTH_SECRET` 写进 `infra/stf/.env` 以便以后重启。）
7. 反向代理 + TLS：`deploy.env` 里 `SITE_ADDRESS=<域名>`，DNS 指向服务器，80/443 可达，Caddy 首次部署时自动申请 Let's Encrypt 证书（数据在 volume `caddy-data`）。无域名测试可用 `SITE_ADDRESS=:8080`（纯 HTTP）。
8. 比特客户端的反向隧道（Windows → Linux `127.0.0.1:54345`）：按 docs/08 §5.1–5.2 配置；API 在 host 网络里直接访问 `http://127.0.0.1:54345`。
9. 时区：`app.env` 里 `TZ=UTC`，Windows 也用 UTC（docs/08 §4.3）。

## 3. GitHub 设置

1. Settings → Environments → 新建 `production`：
   - **Required reviewers**：至少一人（部署 job 等待批准后才 SSH 上服务器；镜像构建在批准前就会执行，只推镜像，不影响线上）。
   - Deployment branches：按需限制（例如只允许 `main` 和 `release/*`）。
   - Secrets：`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`（专用 ed25519 私钥，公钥放服务器 `~deploy/.ssh/authorized_keys`）、`DEPLOY_KNOWN_HOSTS`（`ssh-keyscan -t ed25519 <host>` 的输出，**人工核对指纹**）。
   - Variables（可选）：`DEPLOY_DIR`（默认 `/srv/cloudphone`）、`DEPLOY_SSH_PORT`（默认 22）。
2. 仓库 Variables（可选）：`IMAGE_PLATFORMS`（默认 `linux/amd64`；arm64 服务器填 `linux/arm64`）。
3. Settings → Actions → General → Workflow permissions 保持默认只读即可（workflow 自己声明最小权限：构建 job `packages: write`，部署 job `packages: read`）。

## 4. 部署 / 回滚 / 状态

GitHub → Actions → **Deploy** → Run workflow：

- “Use workflow from” 选分支（就是要部署的代码）。
- `action=deploy`，`version` 可留空（自动 `YYYYMMDD-HHMM-<短 sha>`），只允许字母数字和 `. _ -`；已存在的版本号会被拒绝（保证回滚拿到的就是当时部署的镜像）。
- 流程：typecheck → 构建并推送两个镜像（buildx + gha 缓存）→（审批）→ SSH 复制 `deploy/` → `deploy.sh <version>` → Job Summary 显示结果和 `status.sh`。
- `action=rollback`，`rollback_steps=1|2`：不构建，SSH 执行 `rollback.sh <steps>`。

服务器上也可以直接执行：

```bash
/srv/cloudphone/deploy/deploy.sh 20261117-1030-abc1234
/srv/cloudphone/deploy/rollback.sh 1      # 回到上一个版本；2 = 再往前一个
/srv/cloudphone/deploy/status.sh          # 活动颜色、历史、每色容器与 /api/ready、最近部署记录
```

`deploy.sh` 步骤：拉镜像 → 确保共享栈运行 → 迁移 + seed（一次）→ 启动空闲颜色 → 等它的 `/api/ready` 返回本版本且 web 可访问（`READY_TIMEOUT`）→ 重写 `state/caddy/upstream.caddy` 并 `caddy reload`（原子、优雅：进行中的 HTTP 请求在旧配置上完成）→ 经 proxy 确认 → 写状态 → 等 `DRAIN_SECONDS` → `compose down` 旧颜色（SIGTERM，最多 `STOP_GRACE`）→ 等新颜色成为 leader → 清理不在历史里的本地镜像。
在切换前任何一步失败都会停掉新颜色，活动颜色不变。`flock` 保证同一台服务器上不会同时跑两个部署。

状态文件 `state/state`：`ACTIVE_COLOR` 和最近 3 个版本（新的在前）。规则：
- deploy v：v 放到最前（如果历史里已有 v，移到最前），只保留 3 个。
- rollback N：重新部署 `HISTORY[N]`（完整蓝绿流程，迁移照跑，对旧版本是 no-op），之后历史去掉被回滚掉的 N 个新版本（它们不再是回滚目标，要再上线就重新 deploy）。历史不够 N+1 个时拒绝。
  例：`v3 v2 v1` → `rollback 1` → `v2 v1`（此时 `rollback 2` 被拒绝，`rollback 1` → `v1`）；`v3 v2 v1` → `rollback 2` → `v1`。
- `state/deploy.log` 记录每次 start/switched/done/failed/refused。

**WebSocket**：`caddy reload` 时 Caddy 会关闭经它代理的 WebSocket（事件流、远控会话），前端重连后就到了新颜色（实测 200 ms 内重连）。远控画面需要重新连接一次。

## 5. 健康检查

- `/api/ready`（新增，无需登录）：只检查 API 自身 + Postgres + Redis，返回 `version`、`color`、`background`（leader / standby / always）。切换和容器 healthcheck 用它。
- `/api/health`：还要求 STF、adb、Docker 正常。可以在 `deploy.env` 里把 `READY_PATH` 改成 `/api/health`，但那样 STF 出问题时就无法部署（包括修复它的部署）。

## 6. 排障

| 现象 | 处理 |
|---|---|
| `another deploy/rollback is running` | 另一个部署在跑（或被 kill 后锁文件还被占用——flock 随进程释放，一般不会残留）。 |
| `did not become ready` | 输出里有新颜色 api 的最后 40 行日志；常见：`app.env` 缺变量（config 校验失败）、数据库连不上、`data/` 不可写（应属 uid 1000）。线上未受影响。 |
| `migrations failed` | 新颜色未启动，线上未受影响。修复迁移后重新部署。 |
| proxy 未确认切换 | `docker compose -p cloudphone logs proxy`；TLS 首次申请证书失败时检查 DNS 和 80 端口。upstream 文件已指向新颜色。 |
| 新颜色一直 standby | `status.sh` 看旧颜色是否还在（任务没结束会等到 `STOP_GRACE`）；`docker exec cloudphone-redis-1 redis-cli GET cloudphone:leader:0` 看谁持有租约。 |
| 比特手机 adb 断开 | 切换后由新 leader 的 monitor 在 15–60 s 内重建隧道；STF adb 容器能否连到 docker0 见 docs/08 §5.4。 |
| 回滚到的镜像不在本地 | 先 `docker login ghcr.io`（只读 PAT）再执行，或从 GitHub 发起 rollback（workflow 会登录）。 |

## 7. 文件

- `.github/workflows/deploy.yml`：手动触发的 deploy / rollback。
- `deploy/docker/{api,web}.Dockerfile`、`deploy/docker/web.Caddyfile`、`.dockerignore`
- `deploy/compose.shared.yml`（Postgres、Redis、Caddy）、`deploy/compose.app.yml`（一种颜色）、`deploy/caddy/Caddyfile`
- `deploy/deploy.sh`、`rollback.sh`、`status.sh`、`lib.sh`；模板 `deploy.env.example`、`app.env.example`；`stf.override.yml`
- `infra/device-tools/fetch-sdk.sh`（下载并校验 SDK zip）、`compile-dex.sh`（`build-dex.sh` 与镜像共用）

## 8. 本机实测记录（2026-11-17，Docker Desktop 模拟服务器）

模拟方式：一个 Linux 容器（docker CLI + compose、bash、curl、flock）挂载 Docker socket、在 host 网络里执行 `deploy/*.sh`；独立的 compose 项目 `cpdeploytest`、独立的 Postgres/Redis 容器和 volume、不冲突的端口（proxy 18080，PG 15433，Redis 16381，api 3101/3102，web 3201/3202）。STF/adb 指向不存在的端口（`/api/health` 如实报告 adb/stf 失败，切换用 `/api/ready`）。v1、v2 由同一份代码构建，v3 额外带一个只在临时副本里的测试迁移（建表 `deploy_test_marker`）。请求压测：host 网络容器里不停顿地循环请求 proxy 的 `/api/ready` 和 SPA 路由。

| 步骤 | 结果 |
|---|---|
| deploy v1（首次，blue） | 21 个迁移，blue 立即成为 leader |
| deploy v2（→ green），压测中 | 5734 个请求，**失败 0**；green 先 standby，blue 停止后 1 s 内接手 |
| deploy v3（→ blue），压测中 | 5405 个请求，**失败 0**；迁移数 21 → 22，测试表存在 |
| rollback.sh 1（→ v2 green），压测中 | 5423 个请求，**失败 0**；迁移仍是 22（v2 的 migrator 对更新的库 no-op），v2 在 v3 schema 上正常；历史 `v2 v1` |
| rollback.sh 2 | 拒绝：`only 2 version(s) recorded (newest first: v2 v1)` |
| rollback.sh 3 / 非法版本号 / 不存在的镜像 | 均拒绝，线上不变 |
| 两个部署同时启动 | 第二个被 flock 拒绝 |
| deploy v3 → rollback.sh 2（v3 v2 v1 → v1），压测中 | 5508 个请求，**失败 0**；历史 `v1` |
| 任务跨切换：leader 上跑一个 25 s 的 test.echo 时部署 | 9964 个请求失败 0；旧色 SIGTERM 后 HTTP 立即停止，但持有租约直到任务成功结束（1 次尝试），新色随后 1 s 内成为 leader |
| 事件 WebSocket 跨切换 | 切换时被关闭（1001），200 ms 后重连到新颜色 |
| 就绪超时（故意配错 READY_PATH） | 新颜色被停掉，活动颜色和历史不变 |
| `docker stop` API | 约 0.1 s 内退出，exit code 0 |
| 构建产物 | scrcpy-server SHA-256 校验通过；dex 与开发机构建的 sha256 完全一致；pg_dump 17.12、ffprobe 8.0.1、OpenSSH 10.2 |
