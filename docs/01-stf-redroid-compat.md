# STF × redroid 兼容性验证报告

日期：2026-11-14　结论：**通过，远程控制采用 STF；scrcpy 暂不引入**

## 测试环境

| 角色 | 配置 |
|---|---|
| 控制平面（macOS） | Docker Desktop 4.97 / arm64；STF `devicefarmer/stf:3.9.0` + RethinkDB 2.4.4 + 自建 adb server（alpine `android-tools` 35.0.2） |
| Android 宿主（Linux） | Lima VM（`infra/lima/redroid-host.yaml`）：Ubuntu 24.04 arm64，kernel 6.8.0-147，4 vCPU / 4 GiB，`binder_linux` 模块 |
| Android 镜像 | `redroid/redroid:12.0.0_64only-latest`（Android 12 / API 31 / arm64-v8a），720×1280@320dpi |
| 链路 | STF(adb 容器) → `host.docker.internal:555x` → Lima 端口转发 → redroid adbd |

注意：Docker Desktop 内核未开启 `CONFIG_ANDROID_BINDER_IPC`，redroid **无法**在 macOS Docker Desktop 上运行，必须使用 Linux 宿主。

## 结果（全部为实测）

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 1 | redroid 启动 | ✅ | `sys.boot_completed=1`，system_server / surfaceflinger / adbd 运行，0 次重启 |
| 2 | STF 识别设备 | ✅ | provider 日志 `Fully operational`；REST `/api/v1/devices` 返回 `present=true ready=true sdk=31` |
| 3 | 屏幕流 | ✅ | API 31 无原生 minicap 库，自动使用 `minicap-apk`；WebSocket 首帧 228–314 ms，画面变化时约 12 fps（VM 软件渲染） |
| 4 | 触控 | ✅ | 无 `/dev/input` 触摸设备，minitouch 回退为 Android InputManager；浏览器点击 Gallery → `GalleryActivity` 前台 |
| 5 | 按键 | ✅ | STF Home 键生效 |
| 6 | 键盘输入 | ⚠️ | 人工速度输入正确（`stftest`）；**突发快速输入会乱序**（`stftest`→`sfettst`）。批量文本应走剪贴板粘贴或 `adb shell input text` |
| 7 | REST：占用/释放 | ✅ | `POST /api/v1/user/devices` 成功 |
| 8 | 远程 ADB | ✅ | `POST .../remoteConnect` 返回 `localhost:7401`；需先 `POST /api/v1/user/adbPublicKeys` 注册公钥，否则 `unauthorized` |
| 9 | APK 安装 | ✅ | 经远程 ADB 安装 F-Droid（12.7 MB）`Success`，启动后正常渲染并联网 |
| 10 | 多实例 | ✅ | 3 台同时 `present/ready`；内存：每台空闲约 550 MB，运行应用约 900 MB |
| 11 | 容器重启恢复 | ✅ | `docker restart` 后 adb 约 15 s 自动重连，STF 自动重建 worker 并 `Fully operational` |

## 对架构的约束（实现时必须遵守）

1. **STF 设备状态有滞后**：重启期间 adb 已 `offline`，STF 仍报 `ready=true`。实例健康以平台自身检测为准（Docker 状态 + `adb get-state` + `sys.boot_completed`），STF 状态仅作参考。
2. **屏幕流端口是动态的**：重连后 7404→7412。前端必须每次从 STF API 获取 `display.url`，不能缓存端口。
3. **设备接入由平台负责**：redroid 不是 USB 设备，需由 Node 侧 `adb connect host:port`；STF 必须带 `--allow-remote`。
4. **STF UI 需暴露 7110**（websocket 单元），否则控制页显示 Disconnected。
5. **远程 ADB 需注册公钥**：平台为 API 服务生成固定 adbkey，并注册到 STF 服务账号。
6. **内存预算**：5 台 MVP 的 Linux 宿主至少需要 6–8 GiB；本机 Lima 4 GiB 只适合 3 台。20–50 台需要独立的 Linux 服务器（x86_64 或 arm64 均有镜像）。
7. **STF 认证**：开发环境用 mock auth（需 CSRF：先 GET `/auth/mock/` 取 `XSRF-TOKEN`）。平台对外以自己的 RBAC 为准，STF 不对最终用户直接暴露。

## 远程控制方案决策

**采用 STF**（屏幕、触控、按键、APK、远程 ADB 均通过实测）。scrcpy 暂不引入，以下情况再评估：需要 >30 fps 或音频、需要 H.264 低带宽、或 STF 在 Android 13+ 镜像上出现兼容问题。

## 复现

```bash
limactl start --name=redroid infra/lima/redroid-host.yaml
limactl shell redroid sudo docker run -d --name r1 --privileged -p 5555:5555 \
  -v /srv/redroid/r1:/data redroid/redroid:12.0.0_64only-latest
docker compose -f infra/stf/docker-compose.yml up -d --build
docker compose -f infra/stf/docker-compose.yml exec adb adb connect host.docker.internal:5555
open http://localhost:7100
```
