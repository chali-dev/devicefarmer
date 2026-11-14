# Google 登录与 YouTube 兼容性：实施计划与风险

日期：2026-11-14　状态：**待确认（涉及下载与环境变更的步骤未执行）**

## 1. 现状检查结果（实测）

| 项目 | 现状 | 对本方案的影响 |
|---|---|---|
| 宿主 | Apple M4 / macOS 27 / 16 GB；Lima VM（vz）Ubuntu 24.04 arm64，4 vCPU / 4 GiB，磁盘剩余 34 GB | arm64 环境；内存是瓶颈 |
| redroid | `redroid/redroid:12.0.0_64only-latest`（AOSP，无 GMS），2 台运行中（phone-1/2） | 新镜像另起 tag，不改动现有镜像 |
| 架构复用点 | `AndroidRuntime` 接口（容器生命周期）+ `AdbAdapter` + `StfAdapter` 分层；`instances.engine` 字段已预留 `docker-android`；每实例独立 `/data` 绑定目录与独立网络命名空间（e2e 已验证重启后数据保留） | 统一 Device Adapter 只需在现有接口上加引擎注册表，不重构 |
| /dev/kvm | VM 内**不存在** | Google Emulator 需 KVM |
| **Google Emulator 主机平台** | 官方 SDK 仓库元数据：emulator 37.3.9 仅发布 `linux_x64`、`darwin_x64`、`darwin_aarch64`、`windows_x64`，**没有 Linux arm64** | **Google Emulator 引擎无法在本机（arm64 Linux VM / Docker）运行，必须使用 x86_64 Linux + KVM 主机**；`google_apis_playstore` 也有 arm64 镜像，但缺少可在 Linux arm64 上运行的 emulator |
| MindTheGapps | 官方 GitHub 组织发布（带 `release.x509.pem` 签名证书）：12.1.0-arm64 230 MB、13.0.0-arm64 367 MB、12.1.0-x86_64 188 MB（均为 2023-10-25） | 可直接使用官方包 + 自有 Dockerfile 叠加 |
| redroid-script | 从第三方 `s1204IT/MindTheGappsBuilder` 下载 GApps（非 MindTheGapps 官方组织），所读文件中未见 MD5 校验逻辑 | **不采用**；自行用 3 行 Dockerfile 叠加官方包，更简单可审计 |

## 2. 方案

### 2.1 主力引擎：Redroid + MindTheGapps（新镜像，不改现有镜像）
- 推荐 **Android 13**：`redroid/redroid:13.0.0_64only-latest` + `MindTheGapps-13.0.0-arm64`，**大版本精确匹配**。
  备选 Android 12：现有 12.0.0 镜像 + MindTheGapps 12.1.0（12L 包装到 12.0，存在小版本错配风险）。
- 构建方式（合法安装：官方包、校验签名、只复制其 `system/` 目录，不改 SELinux、不 root 化、不伪造指纹）：
  ```dockerfile
  FROM redroid/redroid:13.0.0_64only-latest
  COPY mindthegapps/system/ /system/
  ```
  产物 tag：`cloudphone/redroid:13-mtg-20231025`。
- 需对 Android 13 重新跑一遍 STF 兼容冒烟测试（已有脚本）。

### 2.2 备用引擎：Google 官方 Emulator
- 使用 `google/android-emulator-container-scripts` 的 `emu-docker create` 生成镜像，`google_apis_playstore` x86_64 系统镜像。
- 运行条件：x86_64 Linux + `/dev/kvm`；容器以 `--device /dev/kvm` 运行，ADB 5555。
- 平台侧实现 `EmulatorRuntime`（同一 `AndroidRuntime` 接口），并在 `/api/health` 与创建对话框中**检测 /dev/kvm**，无 KVM 时禁用该引擎并给出原因。
- **本机无法测试**，需要一台 x86_64 KVM 主机才能完成「1 台 Emulator」测试。

### 2.3 统一 Device Adapter（复用现有分层）
- `runtimeFor(engine)` 注册表：`redroid` → `RedroidRuntime`，`emulator` → `EmulatorRuntime`。
- 启动检测从 `docker exec getprop` 改为 **adb getprop**（两种引擎通用）。
- 镜像目录（profile）：`redroid-12`（现有）、`redroid-13-gapps`、`emulator-playstore`；创建实例时选择 profile；不同 profile 实例可并存。
- ADB、STF 接入、远程预览、RBAC、任务队列全部复用，不改动。

### 2.4 数据持久化
- Redroid：每实例 `/srv/cloudphone/instances/<name>/data → /data`（已有）。Google 账号、GSF ID、应用数据都在 /data，容器重启/重建后保留。
- Emulator：每实例 AVD 目录卷（userdata 镜像）独立挂载；关闭快照，保证冷启动后状态来自卷。

### 2.5 Google 服务健康检查（只读，不采集账号信息）
monitor 每 60 s 对运行中实例通过 adb 检查，结果存 `instances.google` 并实时推送：
- GMS（`com.google.android.gms`）已安装 / 版本 / 进程存活
- GSF（`com.google.android.gsf`）已安装；读取 **GSF ID**（用于用户自行到 Google 的 uncertified 页面登记）
- Play 商店、YouTube 是否安装及版本
- 是否已登录 Google 账号：仅 `dumpsys account` 中 `com.google` 类型账号**数量**，**不读取、不存储邮箱和密码**

### 2.6 人工 Google 登录与 YouTube（不存储密码）
1. 用户在平台远程控制页面中，按提示用自己的 Google 账号到 google.com/android/uncertified 登记该实例的 GSF ID（平台显示 ID 与复制按钮）。
2. 用户在远程画面中亲自输入 Google 账号密码登录（平台只转发输入事件；粘贴通道不落盘、不记日志）。
3. 通过 Play 商店安装 YouTube（平台可一键打开 Play 商店的 YouTube 页面）。
4. 播放验证：`dumpsys media_session` 播放状态 + 屏幕帧率。

### 2.7 测试（不批量创建）
- 2 台 Redroid+GApps：GMS/GSF/Play 健康 → 用户人工登录 → YouTube 安装/登录/播放 → 容器重启与 stop/start 后登录状态保留 → 资源占用（内存/CPU/磁盘）。
- 1 台 Google Emulator：待 x86_64 KVM 主机。
- 输出 `docs/03-google-test-report.md`。

## 3. 风险

| 风险 | 说明 | 应对 |
|---|---|---|
| 设备未认证 | redroid + GApps 不是 Google 认证设备，未登记前 Google 登录/Play 商店可能被拒 | 每台实例由用户登记 GSF ID（官方流程）；数据卷保证 ID 不变，清数据后需重新登记 |
| Play Integrity 不通过 | 依赖完整性校验的应用/功能不可用 | 按约束**不做任何绕过**；报告中如实记录 |
| 账号风控 | 新环境登录可能触发验证、限制 | 由用户本人完成验证；不做规避 |
| 版本错配 | Android 12.0 镜像 + 12.1 GApps | 推荐 13 + 13 精确匹配 |
| STF 对 Android 13 | 未验证 | 构建后先跑冒烟测试，失败则回退 12 |
| 视频播放性能 | redroid 为软件渲染（无 GPU），高分辨率视频 CPU 占用高、可能卡顿；无 Widevine，DRM 内容（付费影片）不可播 | 测试 360p/720p；记录 CPU；不引入非官方 Widevine |
| 内存 | GMS 常驻，每台预计 +300–600 MB；VM 4 GiB 跑 2 台 GApps + 现有 2 台会吃紧 | 测试前停掉 phone-1/2 或将 VM 提到 6 GiB（需确认） |
| GApps 包较旧 | 官方 MindTheGapps 最新为 2023-10 | 登录后 GMS/Play 商店会自行更新；记录版本 |
| Emulator 无法本机运行 | 官方 emulator 无 Linux arm64 版本 | 需 x86_64 KVM 主机；否则只完成代码与 KVM 检测，不宣称通过 |
| 扩容到 20–50 台 | 本机不可行 | 测试通过后另行规划（x86_64 服务器、内存/CPU 估算） |
