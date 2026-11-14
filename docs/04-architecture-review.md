# 架构审查与优化计划（对照比特云手机类产品）

日期：2026-11-14　依据：现有代码 + 运行中环境实测（g13-1、g13-2、phone-1，均为 redroid-13-gapps）

> 比特云手机未找到公开功能文档，功能对照参考同类产品公开 API：DuoPlus（批量改参数、代理、本地化、GPS）、Hubstudio（批量启停、ADB、安装/启动应用、上传文件、shell）、火山引擎云手机（批量属性、批量 ADB、批量截图）。

## 1. 现有架构（实测）

```
Vue3 前端 ─► Fastify API（RBAC 网关）─┬─ DockerHost → RedroidRuntime / EmulatorRuntime（AndroidRuntime 接口）
                                      ├─ AdbAdapter（共享 adb server）
                                      ├─ StfAdapter（REST + socket.io 服务账号；屏幕流转发 + 输入）
                                      ├─ BullMQ 任务队列（生命周期 / 安装）
                                      ├─ Monitor（5s 对账 Docker/adb/STF；60s Google 健康）
                                      └─ PostgreSQL（users / instances / grants / tasks）
```

实测数据：GApps 实例启动到 STF 就绪 22–24 s；内存 0.77–1.1 GiB/台；空闲 CPU < 1%；镜像 2.47 GB；**Lima 4 GiB 跑 3 台 GApps 后可用内存仅 175 MB**。

## 2. 功能对照

| 方向 | 功能 | 状态 | 说明 / 证据 |
|---|---|---|---|
| 运行环境 | Redroid ARM64 主力引擎 | ✅ | 12 与 13 均验证 |
| | GApps / GMS | ✅ | 官方 MindTheGapps 签名校验后构建；GMS 自动更新到 26.44 |
| | Google 账号登录 / YouTube | ⏳ | 需用户本人登录；GSF ID 展示与安全输入已就绪 |
| | APK 上传安装 | ✅ | 单个 .apk |
| | 拆分 APK（YouTube/Instagram/Facebook 常见分发形式） | ❌ | **P0** |
| | 批量安装、卸载、更新、应用列表 | ❌（仅单台安装） | **P0** |
| | Emulator 备用引擎 | 🟡 | 代码 + KVM 检测完成；无 x86 KVM 主机，未运行验证 |
| 设备独立性 | 独立 /data、应用数据、存储 | ✅ | e2e 验证 |
| | Android ID / GSF ID 重启不变 | ✅ | run4：restart、stop/start 后 GSF ID 不变；Android ID 存于 /data |
| | 分辨率 / DPI / 内存上限 | ✅ | 创建时设置 |
| | 语言、时区 | ❌ | **P0**（系统原生设置项） |
| | 设备名称 | ❌ | **P0**（`settings global device_name`，系统原生） |
| | 设备型号 / IMEI / 一键新机 | ⛔ 不做 | 修改 `ro.product.*`、伪造 IMEI 属于设备指纹伪造，违反约束 |
| 代理与网络 | 每台独立网络命名空间 | ✅ | e2e 验证 |
| | 每台 HTTP / SOCKS5 代理、出口 IP、断线阻断、DNS、IPv6 | ❌ | **P1**（sing-box 每实例 sidecar） |
| 远程控制 | 浏览器实时画面、触控、滑动、按键 | ✅ | |
| | 文本输入（中文粘贴、安全逐字输入） | ✅ | |
| | 剪贴板读取（设备 → 浏览器） | ❌ | **P0** |
| | 截图（原始分辨率 PNG） | ❌ | **P0** |
| | ADB 管理 | 🟡 | 每台独立端口；无 Web 端 shell（不做通用 shell，避免越权） |
| | STF / scrcpy / WebRTC 评估 | ✅ | STF 满足 MVP；scrcpy(H.264) 列 P2 以降带宽 |
| 云手机管理 | 批量创建/启动/停止/重启/删除 | ✅ | |
| | 实例模板 | 🟡 | profile（镜像）已有；参数模板 **P1** |
| | 资源限制 | 🟡 | 内存有；CPU 无 → **P1** |
| | 分组、标签 | ❌ | **P1** |
| | 状态与健康检查 | ✅ | Docker/adb/STF/GMS/GSF/YouTube |
| | 多用户与权限隔离 | ✅ | RBAC e2e 验证 |
| 扩展 | 20–50 台调度、并发、监控 | ❌ | **P2**（多宿主 DockerHost、容量检查、指标） |

## 3. 现存问题

| 问题 | 影响 | 处理 |
|---|---|---|
| 本机 4 GiB 跑 3 台 GApps 后仅剩 175 MB | OOM 风险 | 创建前做**容量检查**（P0：按每台 1 GiB 估算，拒绝超额创建）；生产用 Linux ARM64 服务器 |
| redroid 13 模拟蓝牙 HAL 循环崩溃（~15 次/小时） | CPU 影响可忽略，日志噪声 | 记录为已知问题 |
| STF mock 认证 | 生产不安全 | P2：换 OAuth/LDAP 并仅内网暴露 |
| emulator 无法在 arm64 验证 | 备用引擎未验证 | 需 x86_64 KVM 主机 |

## 4. 优先级计划

**P0（本轮实施并实测）**
1. APK 管理：拆分包安装（.apks/.xapk/.apkm 等 zip 包）、批量安装到多台、应用列表、卸载、更新。
2. 设备参数：语言、时区、设备名称（创建时 + 运行中修改），持久保存在 /data。
3. 远程控制：截图（原始 PNG）、读取设备剪贴板。
4. 容量检查：创建前按可用内存拒绝超额实例。
5. Google 登录 / YouTube：由用户本人登录后，平台验证账号数、YouTube 播放状态、重启后保留。

**P1**：每实例代理（sing-box sidecar + 出口 IP 检测 + 断线阻断 + DNS/IPv6 防泄漏）、分组/标签、参数模板、CPU 限制。

**P2**：多宿主调度（20–50 台）、监控指标、Docker Compose 部署、STF 正式认证、scrcpy/WebRTC 评估、x86 主机上验证 Emulator。

## 5. 20–50 台容量估算（Linux ARM64）

| 项 | 每台 | 50 台 |
|---|---|---|
| 内存（GApps，空闲~轻度使用） | 1.0–1.5 GiB | 64–80 GiB（另留 8 GiB 给宿主/STF） |
| CPU（视频播放为软件渲染，峰值高） | 0.5–2 vCPU | 32–64 vCPU（可超分，播放密集场景需实测） |
| 磁盘（/data，含应用） | 3–8 GB | 200–400 GB SSD |
| 网络 | 屏幕流 JPEG 约 0.5–3 Mbps/观看会话 | 按同时在线观看数估算 |
