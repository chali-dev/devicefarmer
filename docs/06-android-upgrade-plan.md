# Android 13 → 16 升级方案

日期：2026-11-14　状态：**待确认下载**

## 现状

| 项 | 当前 |
|---|---|
| 镜像 | `cloudphone/redroid:13-mtg-20231025` = redroid `13.0.0_64only-latest`（2024-05）+ MindTheGapps 13.0.0-arm64（2023-10） |
| Android | 13（SDK 33），安全补丁 2023-08-05，userdebug，arm64 |
| 平台耦合点 | profile 目录（`profiles.ts`）、GApps 构建脚本（`infra/redroid-gapps`）、STF 屏幕/触控、测试中的界面坐标、受保护画面采集（隐藏 API 随版本变化） |

## 可用组件（实测查询）

| 版本 | redroid 镜像（arm64） | 官方 MindTheGapps arm64 |
|---|---|---|
| 14 | `14.0.0_64only-latest`（2024-05） | 14.0.0（2025-02） |
| 15 | `15.0.0_64only-latest`（2025-06） | 15.0.0（2026-09，483 MB） |
| **16** | **`16.0.0_64only-latest`（2025-06，约 700 MB 压缩）** | **16.0.0（2026-10，499 MB，附 sha256 与签名证书）** |

结论：**技术上可以升级到 Android 16**，组件均为官方来源，大版本匹配。

## 风险

1. **STF 兼容性未知**：STF 3.9 的 minicap-apk / STFService / minitouch(InputManager) 在 SDK 36 上可能失效 → 必须先跑冒烟测试；失败则退到 15 或改用 scrcpy 方案。
2. **redroid 16 镜像较早（2025-06）**，GApps 较新（2026-10）：可能存在小版本错配（16 QPR），需实测 GMS 是否稳定。
3. **不能原地升级已有实例**：/data 跨 3 个大版本升级风险高（应用数据库迁移、GMS 数据）。建议新建 16 实例；旧 13 实例保留，按需迁移（应用通过「应用库」重装，Google 需重新登录并重新登记 GSF ID）。
4. **受保护画面采集依赖隐藏 API**：13 用 `SurfaceControl.captureDisplay`，14+ 改为 `ScreenCapture`，采集组件需同时支持。
5. **内存**：Android 15/16 + GMS 预计比 13 多 200–400 MB/台，本机 4 GiB VM 只能测 1 台。
6. **Google 设备认证不变**：升级系统版本不会让设备变成「已认证」，仍需登记 GSF ID；Play Integrity 仍预计不通过（不做绕过）。

## 实施步骤（与现有架构一致，不改动 13 镜像）

1. 下载并校验：redroid `16.0.0_64only-latest`、MindTheGapps 16.0.0-arm64（sha256 + 签名证书校验，`verify_jar.py` 复用）。
2. `infra/redroid-gapps/build.sh` 参数化版本 → 构建 `cloudphone/redroid:16-mtg-<date>`。
3. 新增 profile `redroid-16-gapps`（13 保持默认，16 先作为可选）。
4. 兼容测试：启动/adb/STF 冒烟、Google 健康、P0（应用/设置/截图）、代理、受保护画面采集。
5. 通过后把默认 profile 切到 16；13 实例继续可用。
6. 输出兼容性报告。
