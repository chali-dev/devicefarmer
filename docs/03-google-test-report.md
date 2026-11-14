# Google 服务与 P0 功能测试报告

日期：2026-11-14　环境：Apple M4 / Lima VM（Ubuntu 24.04 arm64，4 vCPU / 4 GiB）/ Docker 29.9 / STF 3.9.0
镜像：`cloudphone/redroid:13-mtg-20231025`（redroid 13.0.0_64only + 官方 MindTheGapps-13.0.0-arm64-20231025_200931，签名与 39 个文件摘要校验通过）

所有结果均为真实环境测试（脚本：`apps/api/scripts/google-check.ts`、`p0-check.ts`、`e2e.ts`），无 Mock。

## 1. 结果汇总

| 项目 | 结果 | 证据 |
|---|---|---|
| GApps 镜像构建（不改动原镜像） | ✅ | 新 tag；原 `redroid:12.0.0_64only` 保留 |
| Android 13 + STF 兼容 | ✅ | 冒烟：adb、STF ready、按键、点击、粘贴均通过 |
| GMS / GSF / Play 服务安装并运行 | ✅ | GMS 22.21 → 自动更新至 26.44.32；GSF 已安装；GMS 签到成功 |
| GSF ID 读取 | ✅ | 19 位，经平台 API 读取（需 `su 0`，redroid userdebug） |
| GSF ID 重启 / stop-start 后不变 | ✅ | run4：两台均不变 |
| Android ID 重启后不变 | ✅ | p0-check |
| 安全输入（密码） | ✅ | 逐字符输入 `Secure Typing 42` 正确；设备剪贴板未变化 |
| Google 账号登录 | ✅ | 用户本人在 phone-1 登录成功（受保护画面 + 安全输入）；平台只统计账号数量 |
| YouTube 安装 / 登录 | ✅ | 从 Play 商店安装 21.45.82；登录后不再出现取 token 失败；播放检测已实现（media_session state=3），尚未在播放中采样 |
| 登录状态重启后保留 | ⏳ 待登录后验证 | 账号数据位于 /data，与 GSF ID 同一持久化路径（已验证） |
| Emulator 引擎 | 🟡 未运行 | 代码 + KVM 检测完成；本机无 Linux arm64 emulator，需 x86_64 KVM 主机 |
| 批量安装（APK） | ✅ | 2 台并发任务成功，应用列表显示版本 |
| 拆分包安装（.apks 会话安装） | ✅（单 APK 包） | PackageInstaller 会话路径通过；**多 split 的真实 YouTube/Instagram 包待用户提供后验证** |
| 更新（同包覆盖安装） | ✅ | |
| 批量卸载 | ✅ | |
| 损坏安装包拒绝 | ✅ | 400 |
| 平台组件保护 | ✅ | STFService 标记为平台组件，卸载请求 400 |
| 语言 / 时区 / 设备名称 | ✅ | zh-CN / Europe/Berlin / CloudPhone-B 应用成功，重启后保持 |
| 非法时区拒绝 | ✅ | 400 |
| 设备型号不可改 | ✅（设计如此） | ro.product.model 保持 `redroid13_arm64_only` |
| 截图（原始 PNG） | ✅ | 720×1280 |
| 容量检查 | ✅ | 可用内存不足时拒绝创建（409，附需要/可用数值） |
| 设备 → 浏览器剪贴板读取 | ❌ | Android 10+ 拒绝后台应用读剪贴板（STFService 被拒）；计划 P1 用 scrcpy-server |
| 回归 e2e（32 项） | ✅ | 重构后 32/32 通过（本轮新增功能前最后一次运行；当前因内存不足无法再起 2 台） |
| API 中途退出恢复 | ✅ | 中断的 start 任务在 API 重启后由 BullMQ 继续完成 |

## 2. 资源占用（实测）

| 指标 | 数值 |
|---|---|
| GApps 实例内存 | 0.77–1.12 GiB（空闲） |
| 空闲 CPU | 0.1–0.8% |
| 创建到 STF 就绪 | 22 s；重启 22–24 s |
| 镜像 | 2.47 GB（GApps 层 270 MB） |
| VM 剩余内存 | 3 台 GApps 时仅 40–175 MiB ⚠️ |

## 3. 兼容性问题

1. redroid 13 模拟蓝牙 HAL 循环崩溃（约 15 次/小时），CPU 影响可忽略。
2. redroid 内 `sqlite3` 崩溃；GSF ID 改从 GMS `Checkin.xml` 读取。
3. Android 13 中 `dumpsys` 字段由 `mResumedActivity` 改为 `ResumedActivity:`（测试脚本已兼容）。
4. 修改系统语言需重启 Android 框架（约 20–30 s，不重启容器）；必须先改语言再写其他设置，否则设置写入会丢失（已修复）。
5. 设备未经 Google 认证：登录前需用户自行登记 GSF ID；Play Integrity 预计不通过（不做绕过）。

## 4. 需要用户完成的验证

1. 在实例详情页复制 GSF ID，用自己的 Google 账号在 https://www.google.com/android/uncertified 登记，等待数分钟。
2. 在远程画面中打开 设置 → 账号 → 添加 Google 账号；输入密码时打开「安全输入」。
3. 通过「应用管理」上传 YouTube 官方安装包（拆分包可直接上传），登录并播放视频。
4. 页面「Google 服务」卡片应显示：已登录 1 个账号、YouTube 已安装、播放中。之后点击「重启」，确认仍显示已登录。

## 5. Google Workspace（组织管理）账号说明（2026-11-14 实测）

使用组织账号登录时，所有应用取 token 均失败：`DeviceManagementScreenlockRequired`，并伴随
`No device or profile owner found for bad device management broadcast`。原因是组织的移动设备管理策略：
设备必须设置屏幕锁，并满足组织的设备管理要求。处理过程（均由用户本人完成）：
1. 设置 PIN（受保护画面开关可显示 PIN 页面）；
2. 移除并重新添加账号；
3. 按组织要求启用设备管理（「设备管理应用」）。
之后 token 正常、YouTube 可登录。若组织要求高级管理（Android Device Policy 工作资料）或拦截未认证设备，需由组织管理员调整策略，平台不做规避。个人 @gmail.com 账号无此限制。

## 6. 文件上传到手机（修复记录）

通过 adb 写入共享存储的文件会被 MediaStore 标记为 `is_pending=1`（对其他应用不可见、无尺寸元数据），
导致 Instagram 选图看不到。修复：扫描后按文件名定位记录、清除 `is_pending` 并重新扫描；
上传接口在返回前校验 `is_pending=0`，否则报错（不再静默成功）。
