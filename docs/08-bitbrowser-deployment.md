# 比特云手机（BitBrowser）生产部署方案

> 状态：调研与方案（2026-11-17），未在生产环境实施。标注说明：
> **[已验证]** 本次在代码、本机客户端或官方文档中亲自核实；**[推断]** 根据已知事实推理，未实测；**[未验证]** 需要上线前确认。
> 本次调研全程只读：未开机/关机任何手机，未调用 `/phone/adb/get` 等计费或改状态接口，未改代码和配置。

## 0. 结论摘要

> **更新（2026-11-18）**：店主选定 **Tailscale 组网（方案 A-TS，§5.5）** 连接 Linux VPS 与比特客户端，取代下面推荐的反向 SSH 隧道。§4.3 的前提改动（Token、短超时与熔断）已经上线，所以 A-WG/A-TS 在断线时也是快速失败。下面的比较保留作为背景。

**推荐方案 A：Linux VPS（我们的全部服务）+ 一台小型 Windows VPS（只跑比特客户端），两者之间用反向 SSH 隧道连接**（Windows 主动连 Linux，`-R 127.0.0.1:54345:127.0.0.1:54345`，Linux 上用只能转发的受限账号）。WireGuard 留作备选，到 ≥2 个客户端或 SSH 隧道频繁断开时再换。

理由：

1. 比特客户端只有 Windows/macOS 版，而且是要有交互式桌面会话的 Electron 程序，没法放进 Linux 容器；我们的栈（Docker、STF、本地 redroid）又必须在 Linux 上。两者分开，Windows 更新或重启只影响比特来源，不影响 API、STF 和本地设备。
2. 用反向隧道时 Windows 不需要开任何入站端口。客户端本地 API **固定绑定 0.0.0.0、默认无鉴权**（见 §2），所以入站越少越安全。
3. 隧道断了，Linux 上的 `127.0.0.1:54345` 会立刻返回 ECONNREFUSED。我们现在的代码对"连接挂起"处理很差（每次调用要等满 30 s 超时，而且请求是串行的），快速失败正好避开这个问题（见 §4）。
4. 代码已经支持多个来源、多个客户端：每个客户端地址各有一条 1 req/s 队列。以后加客户端，只要加一个 Windows VPS 加一个端口（54346…）。

方案 B（单台 Windows 加 WSL2）不推荐：VPS 上要嵌套虚拟化，Windows 更新会把整套服务一起重启，本地 redroid 也跑不了。

上线前必须做的小改动：本地 API Token 支持（`x-api-key`）、修复 `pkill` 参数的 bug、给只读调用设短超时并加熔断、隧道续期时先取新信息再关旧隧道、客户端与 API 时区对齐。完整清单见 §4.3。

---

## 1. 已知事实（作为前提）

| 事实 | 来源/状态 |
|---|---|
| 比特没有服务端/云端 API。接口由已安装且已登录的桌面客户端提供（Local API，POST JSON） | 官方文档 [本地服务指南](https://doc2.bitbrowser.cn/jiekou/ben-di-fu-wu-zhi-nan.html)：“安装并登录比特浏览器 → 打开系统设置，获取到本地接口url” **[已验证]** |
| 云手机接口全局限速每秒 1 次；开机、挂起、关机都计费；开机是异步的，冷启动约 1 分钟 | [云手机接口文档](https://doc2.bitbrowser.cn/jiekou/cloud-phone.html) **[已验证]** |
| “挂起”会关闭手机窗口，但手机仍在云端运行并持续计费；“关机”才停止计费 | 同上 **[已验证]** |
| `/phone/list` 有 `envType` 参数，默认 1（按时计费），传 0 才查套餐模式的环境 | 同上 **[已验证]**（我们的代码没传，见 §4.3 P1-5） |
| `/phone/list` 在手机开了 adb 时可能返回含 adb 密码（`code`）的连接信息 | 同上（文档示例）**[已验证文档]**。我们的 `list()` 只挑选字段、不记录原始响应，不能改成打印原始 JSON |
| 一份算力同一时间只绑定一个云手机环境；关机后算力释放 | [算力 FAQ](https://doc2.bitbrowser.cn/cloudphone1.html) **[已验证]** |
| 客户端：Windows 10+ / macOS 12+，官方建议 4 核 / 8 GB / 50 GB | 任务背景给出（官方下载页），未重复核实 |
| 本机客户端监听 `*:54345`，无鉴权 | `lsof` 显示 `TCP *:54345 (LISTEN)`，进程是 `比特浏览器.app` **[已验证]** |
| adb 不是公网端口：`/phone/adb/get` 返回网关的 host/port 和临时 SSH 密码（约 28 h）；API 主机自己起 `ssh -L`，只需要出站 SSH | 代码 `adapters/bitbrowser-tunnel.ts` 与此前实测 **[已验证]** |
| 手机所有出网流量（包括我们的 scrcpy relay）都走比特里绑定的代理，在 Android 之下生效。实测：手机在 HK，代理在 Mumbai，操作员在 Yerevan（Starlink）；relay 走 ngrok eu 时 RTT 约 300 ms | 此前实测 |

## 2. 比特客户端特性调查

官方文档几乎没写系统设置（[系统设置页](https://doc2.bitbrowser.cn/Settings.html) 只有截图）。下面的结论来自**本机已安装客户端 v7.2.0 的程序包**（`比特浏览器.app/Contents/Resources/app.asar`，只做了只读的 `grep`），以及 `~/Library/Application Support/BitBrowser/config.json`。

| 问题 | 结论 | 状态 |
|---|---|---|
| 本地 API 端口能改吗？ | **能**。设置里有“本地服务端口”（IPC `save-local-server-port`，存为 `server_port`，默认 54345），改动会写进 `config.json` 的 `localServerAddress`（本机现为 `http://127.0.0.1:54345`）| [已验证，代码] |
| 绑定地址能改吗？有没有“仅本机/局域网”开关？ | **没有**。本地服务（Fastify）写死 `listen({port, host: '0.0.0.0'})`，永远监听所有网卡。`localServerAddress` 里的 127.0.0.1 只是显示/调用用的地址，不是绑定地址。**所以必须靠防火墙挡** | [已验证，代码 + lsof] |
| 端口被占用时会怎样？ | 启动时如果端口被占（EADDRINUSE），会**自动 +1 往上找空闲端口并把新端口持久化**。结果是客户端可能悄悄换到 54346，隧道和来源配置就对不上了 | [已验证，代码 `gA({autoIncrementPort:true, persist:true})`] |
| 有没有鉴权？ | **有，可选**：“Local API Token”。开启后，所有**非 GET/OPTIONS** 请求都必须带请求头 `x-api-key: <token>`，否则返回 403（`header.x-api-key验证失败…`）。本机 `config.json` 里 `enableAuth: false`。注意：比较用的是普通 `===`，不是常量时间比较，所以它只是第二道防线，不能代替防火墙 | [已验证，代码]；UI 上开关的具体位置[未验证] |
| 能不能无界面（headless）运行？ | 文档里的 headless 只是**浏览器窗口**的 `--headless` 启动参数（[无头模式](https://doc2.bitbrowser.cn/headless.html)），不是客户端本身。客户端是 Electron 桌面程序，开机时还会弹出手机窗口，所以**需要一个已登录的交互式桌面会话**（断开的 RDP 会话一般可以，注销不行）| headless 含义[已验证]；“断开的 RDP 会话可以长期运行”[推断，需验证] |
| 开机自启 | 有：代码调用 `app.setLoginItemSettings({openAtLogin})`，即**用户登录时**启动，不是系统服务。所以 Windows 要配自动登录 | [已验证，代码]；UI 开关名[未验证] |
| 自动登录比特账号 | 客户端界面是从网页加载的，本地包里查不到相关逻辑 | [未验证]：需要实测重启后是否保持登录、登录状态多久失效 |
| 自动更新 | 有：electron-updater，源为 `https://update.bitbrowser.cn/bit-update` | [已验证，`app-update.yml`]；会不会在无人值守时自动重启[未验证] |
| 客户端退出时云手机怎么样？ | 退出流程只关本地服务、清浏览器临时数据，**没看到关机云手机的调用**。云手机在云端运行，我们的 adb 隧道直连比特网关、不经过客户端，所以**客户端退出后已开的手机和已建的 adb 隧道应该继续工作**；但在客户端恢复前，没法查电源状态、开关机，也没法续期 adb 授权 | 退出逻辑[已验证，代码]；手机和隧道是否存活[推断，需验证] |
| 关闭手机窗口会关机吗？ | 不会（此前实测）。“挂起”接口会关闭窗口，但手机仍在运行、仍在计费 | [已验证] |
| 团队/员工账号 | 有员工管理与权限（[员工管理](https://doc2.bitbrowser.cn/Users.html)、[员工权限](https://doc2.bitbrowser.cn/help1/yuan-gong-quan-xian-guan-li/README.html)），云手机可以“分享给他人共用”（[分享云手机](https://doc2.bitbrowser.cn/Share.html)），同时在线人数由套餐决定（[FAQ](https://doc2.bitbrowser.cn/question/question1/3.html)）| 功能存在[已验证]；员工账号的 Local API 能否看到并控制分享来的手机[未验证] |
| 同一账号能否在两台电脑上同时登录？ | 查不到 | [未验证]，见开放问题 |
| 同一台 Windows 能否同时开两个客户端（两个账号）？ | Electron 用单实例锁（每个 userData 一个 `SingletonLock`），而且第二个实例会因端口占用自增端口。要跑两个，至少需要两个 Windows 用户会话。**建议一个账号对应一台 Windows VM** | 单实例锁[已验证，本机文件]；其余[推断] |

## 3. 方案比较

### 3.1 候选方案

- **A-SSH（推荐）**：Linux VPS（API、web、Postgres、Redis、STF，以及本地 redroid，如果主机支持 binder）加 Windows VPS（只装比特客户端）。Windows 用内置 OpenSSH 建反向隧道到 Linux，账号受限（`permitlisten`、无 shell）。
- **A-WG**：同 A，但两边用 WireGuard 互联。Linux 直接访问 `http://10.88.0.2:54345`，Windows 防火墙只放行 wg 网卡上来自 10.88.0.1 的流量。
- **B**：一台 Windows（VPS 或独服）跑客户端，我们的栈跑在 WSL2 里（mirrored 网络）。
- **C**：客户端继续放在店主的 Mac（或托管 Mac mini）上，经 WireGuard 或反向 SSH 接到 Linux VPS。
- **D**：Linux 独服上用 KVM 跑一台 Windows 虚拟机放客户端（单台机器、单份账单）。

### 3.2 对比

| 维度 | A-SSH | A-WG | B（WSL2） | C（Mac） | D（KVM 内 Windows） |
|---|---|---|---|---|---|
| 可靠性：客户端崩溃/更新/掉登录 | 只影响比特来源 | 同左 | 同左 | 同左；家庭网络/Starlink 是额外故障点 | 同左 |
| 可靠性：Windows 更新重启 | 只影响比特来源（几分钟）| 同左 | **整套服务停机**，WSL2 和 Docker 要跟着起 | 不涉及（macOS 更新同理）| 只影响比特来源 |
| 断线时的失败方式 | 隧道断后，本机端口**立即拒绝连接**（快速失败）| 对端断开时数据包被**静默丢弃**，每次调用要等满 30 s 超时（需先改 §4.3 P0-3）| 不涉及 | 取决于传输方式 | 取决于传输方式 |
| 安全：本地 API 暴露面 | Windows 零入站；Linux 端只在 loopback 监听 | Windows 只对 wg 放行；多一个 UDP 端口 | API 只在本机，但同一台 Windows 同时承载数据库和对外服务，攻击面集中 | 家用机上跑生产，风险最高 | 虚拟网桥隔离，可以做到零暴露 |
| 延迟/带宽 | 控制面只走 HTTP 小请求，**位置无关紧要**；视频不经过 Windows | 同左 | 同左 | 同左 | 同左 |
| 成本（粗略） | Linux €15–40/月 + Windows €15–40/月（低价商），云大厂 Windows $70–150/月 | 同左 | 一台支持嵌套虚拟化的 Windows：$80–200/月（Azure Dv5/Ev5 级别等）| 托管 Mac mini 约 €60–120/月；自家 Mac 几乎零成本 | 独服 €50–120/月 + Windows 授权 |
| 运维 | 两台机器；tunnel 用计划任务 + 循环脚本 | wg 是系统服务，开机即连，最省心 | WSL2 网络、端口、开机自启都是坑 | 依赖店主的机器 | 需要会 KVM/virtio；Windows 授权 |
| 扩展到多客户端 | 每台 Windows 一个 Linux 端口（54345/54346…）| 每台一个 wg IP，最干净 | 难 | 难 | 一台独服跑多台 Windows VM |
| 本地 redroid | 可以（看 Linux 主机是否支持 binder）| 可以 | **不可以**（Hyper-V/WSL 内核没有 binder，且是嵌套虚拟化）| 可以 | 可以 |

### 3.3 结论

- **起步阶段（1 个比特账号、≤20 台手机）选 A-SSH**：零新增软件，符合店主现有偏好，配合现有代码表现最好。
- **出现第 2 个账号/客户端，或 SSH 隧道经常需要人工干预时，改用 A-WG**（同时先把 §4.3 P0-3 的短超时和熔断做掉）。
- 将来上独服做多主机调度（20–50 台 redroid）时，D 值得考虑：Windows 跑在同一台独服的 VM 里，省掉一个供应商。
- B 和 C 不作为生产方案。C 只适合作为过渡或开发环境（也就是现在的状态）。

### 3.4 机房位置与延迟

- Windows VPS 只承载控制面（列表、电源、adb 授权），**放在哪里都行**，建议和 Linux VPS 同一家供应商、同一地区，这样隧道最稳。
- 影响用户体验的是 **Linux VPS 的位置** [推断，数字是粗估，购买前请从候选机房实测 `ping` 网关和代理]：
  - **adb 路径**（默认高速源）：Linux VPS ↔ 比特 HK 网关（直连，不经过手机代理）。adb 单条流吞吐受 RTT 限制（`config.ts` 注释：RTT 约 0.3 s 时约 100 KB/s）。**VPS 放在香港或新加坡，这一段 RTT 只有几 ms，吞吐会好得多**；但 Yerevan 的操作员到 HK 约 250 ms。
  - **relay 路径**（`SCRCPY_RELAY_URL`，实验功能）：手机 → Mumbai 代理 → VPS。VPS 在欧洲（法兰克福/阿姆斯特丹）时总 RTT 约 280–300 ms（和此前 ngrok eu 的实测一致）；放在 HK 反而要在 HK↔Mumbai 之间绕一圈，约 400 ms+。
  - 所以：主要靠 adb 源时选 HK/SG，主要靠 relay 时选 EU。按此前的测量，要做到 <150 ms，只能让手机和代理靠近操作员，换 VPS 位置达不到。
- 带宽 [推断]：外部手机 scrcpy 码率是 0.6 Mb/s（adb）或 2 Mb/s（relay）。50 台同时被观看时，入站加出站约 30–100 Mb/s，普通 VPS 的流量包够用。

## 4. 客户端不可达时的代码行为与改进

### 4.1 现状（读代码得出 [已验证，代码]）

- `adapters/bitbrowser.ts`：每个客户端地址一个 `BitBrowserClient`，调用串行执行、间隔 ≥1.1 s；默认超时 30 s（开机 120 s，关机和启用 adb 60 s）。连接失败时抛 `bitbrowser.unreachable`（HTTP 502）；`success:false` 时抛 `bitbrowser.api_error`，带上客户端的 msg。**请求里不带 `x-api-key`**，客户端开启 Token 后所有调用都会 403。
- `modules/monitor/monitor.ts` 的外部循环每 15 s 跑一次：**每台外部设备单独调一次 `/phone/running`**。调用失败时只记 `warn` 日志并 `continue`：**设备状态不变，隧道也不动**。界面上看不出来源已经断开。
  - 正在使用的手机：adb 隧道直连比特网关，**客户端挂了也继续能用**（远控、装应用不受影响）[推断]。
  - 续期需要 `/phone/adb/get`，客户端恢复前没法续期，授权（约 28 h）到期后隧道就断了。
  - 如果超时是因为数据包被静默丢弃：N 台设备 × 30 s，一轮 monitor 要好几分钟，**而且用户的开机/关机请求排在同一条串行队列后面**。
- `adapters/bitbrowser-tunnel.ts`：
  - `open()` **先 `close()` 旧隧道，再调 `adbInfo()`**。续期窗口内只要 `adb/get` 出一次错（客户端抖动、限流），一条原本正常的隧道就被白白拆掉了。
  - `killStale()` 执行 `pkill -f "-L 127.0.0.1:57xx:"`，这个模式以 `-L` 开头，会被当成选项解析。在本机用等价的 `pgrep -f '-L 127.0.0.1:5799:'` 实测返回 `illegal option`，加上 `--` 才正常。**所以清理残留 ssh 的逻辑实际上从未生效**（macOS 上已验证；Linux procps 上[推断]也一样）。
  - `expiresAt` 由 `parseLocalTime()` 按 **API 进程所在时区**解析客户端返回的本地时间字符串。**如果 Windows 和 Linux 时区不一致，续期时间就错了**：Windows 比 Linux 快 N 小时时，会晚 N 小时续期（隧道先断，下一轮再自愈，中间有一段中断）；反过来会提前续期，严重时每轮都续，白白消耗限速额度。返回的时间到底是 Windows 本地时间还是北京时间，[未验证]。
  - 进程退出时（`main.ts` 的 SIGTERM/SIGINT 都会走到 `process.exit`）会 SIGTERM 所有 ssh 子进程。用 systemd 管理时，`KillMode=control-group` 也会兜底。
  - 每台手机一个 ssh 进程。`SSH_ASKPASS_REQUIRE=force` 要求 OpenSSH ≥ 8.4，Ubuntu 22.04/24.04 满足。
- `modules/sources/routes.ts`：有修改来源的接口 `PATCH /api/device-sources/:id`（保存前会先测试连接）。地址、Token、时区都可以直接改，不用先删设备。（更正：初稿写成了没有这个接口。）
- 外部 adb 端口池 5700–5799 是全局的（所有来源共用 100 个）；同一台手机挂在两个来源下不会被拦截（唯一约束只是“来源 + 外部 id”）。
- Linux 部署相关：`EXTERNAL_ADB_BIND` 默认是 127.0.0.1，而 STF 的 adb 容器通过 `ADB_DEVICE_HOST=host.docker.internal` 连接。**在 Linux Docker 上，`host.docker.internal` 默认不存在**，容器也连不到宿主机的 127.0.0.1（见 §5.2 配置）。`infra/stf/docker-compose.yml` 的 adb 服务没有 `extra_hosts` [已验证]。

### 4.2 生产影响小结

| 场景 | 现在的表现 | 风险 |
|---|---|---|
| 客户端掉线（隧道正常，快速拒绝） | 每 15 s 一条 warn，状态不变，手机照常用 | 没有告警；授权到期后 adb 断 |
| 隧道断开（A-SSH） | 同上（ECONNREFUSED，很快） | 同上 |
| 网络黑洞（A-WG 对端断开） | 每次调用 30 s，monitor 和用户操作都排队 | 开机/关机界面长时间卡住 |
| 客户端端口自增到 54346 | 隧道连到 54345 时不通，等同客户端掉线 | 不容易发现 |
| 客户端开启 Token | 全部 403 → `bitbrowser.api_error` | 集成中断 |
| 比特账号退出登录 | 返回 `success:false` 加客户端 msg（内容[未验证]） | 同“掉线” |
| 时区不一致 | 续期过早或过晚 | 白耗限速额度，或周期性断开 |

### 4.3 建议的小改动（不在本次实现）

**P0：上线前**（2026-11-17 已全部实现：`apiKey`、`killStale`、短超时 + 每轮跳过离线来源 + 健康状态、续期顺序、`timeZone`）

1. **Local API Token**：来源配置增加可选的 `apiKey`。它是密钥，不能明文放在 `device_sources.config` 里，要用 `secret-box` 加密、只写不读（参照代理密码的做法）；`BitBrowserClient` 收到后加上 `x-api-key` 请求头；审计脱敏规则已经覆盖 `key`。测试脚本要覆盖“错误 Token 返回 403 且错误码清晰”（新增 `bitbrowser.unauthorized`）。
2. **`killStale` 修复**：`spawnSync('pkill', ['-f', '--', pattern])`，在 Linux 和 macOS 上都实测一下。
3. **短超时加熔断**：只读调用（`list` / `running` / `adb/get`）超时改成 5–10 s；每个来源记录 `lastOkAt / lastError / failingSince`；外部 monitor 在一轮里遇到某来源第一次 `unreachable` 后，本轮跳过该来源剩下的设备。开机/关机保留长超时。
4. **续期顺序**：`open()` 先调 `adbInfo()` 拿到新凭据，再关旧隧道、起新隧道，把中断缩短到秒级，并且 `adb/get` 失败时不拆掉正常的旧隧道。
5. **时区**：短期在运维上要求 Windows 和 Linux 用同一时区（建议都用 UTC），并在 `.env` 里显式设置 `TZ`；长期在来源配置里加 `timeZone`，或者把“客户端当前时间”作为基准换算。

**P1：扩展到 20–50 台前**

1. **monitor 批量化**：每个来源每轮只调一次 `/phone/list`（每页 100 条，50 台只需 1 个请求），只对状态有变化或不明确的手机再调 `/phone/running`。现在 50 台时一轮要约 55 s 的限速额度，用户的开关机请求要排在后面等。
2. **用户操作优先**：`BitBrowserClient` 的队列分两个优先级，开机、关机、`adb/get` 插到 monitor 的查询前面。
3. **来源健康状态显示出来**：`GET /api/device-sources` 返回健康状态；仪表盘和 `/api/health` 增加“比特来源”一项；离线时设备卡片标“来源离线”。
4. ~~修改来源接口~~：已有 `PATCH /api/device-sources/:id`，`apiKey` / `timeZone` 已支持（2026-11-17）。
5. **`envType`**：`list()` 分别查询 `envType: 1` 和 `envType: 0`，否则以后买的套餐模式手机不会出现在列表里（文档写明默认只查按时计费，实际行为[未验证]）。
6. **费用防漏**：比特侧已开机、但平台里没有对应设备或设备已标“停止”时，在仪表盘提示。只提示，不自动关机。

**P2：可选**

- 同一个外部 id 被第二个来源再次添加时给出提示（同一账号接了两个客户端时会出现）。
- `bitbrowser-check.ts` 的 `--power` 路径里，`portOpen` 写死连 `127.0.0.1`，第 152 行还断言“tunnel listens on 127.0.0.1 only”。如果生产把 `EXTERNAL_ADB_BIND` 改成 docker0 地址，这两处要改为读取配置。

## 5. 部署 Runbook（方案 A-SSH）

以下假设：Linux 用 Ubuntu 24.04 LTS，Windows 用 Windows Server 2022/2025 或 Windows 11（**比特是否正式支持 Windows Server 版，[未验证]**，见开放问题；不支持就用 Windows 10/11 镜像）。尖括号里的值换成实际值。

### 5.1 Linux VPS

1. **基础加固**
   ```bash
   adduser ops && usermod -aG sudo,docker ops
   # /etc/ssh/sshd_config.d/10-hardening.conf
   PasswordAuthentication no
   PermitRootLogin no
   KbdInteractiveAuthentication no
   ClientAliveInterval 15
   ClientAliveCountMax 3        # 死掉的反向隧道 45 s 内释放 54345，新会话才能重新绑定
   ufw default deny incoming && ufw allow OpenSSH && ufw allow 443/tcp && ufw enable
   timedatectl set-timezone UTC
   apt install -y unattended-upgrades fail2ban
   ```
   注意：**Docker 发布的端口不受 ufw 控制。** 现在的 `infra/stf/docker-compose.yml` 把 7100/7110/7400-7420 发布在所有网卡上，`--auth-secret` 也还是默认值。生产上要把发布地址改成 `127.0.0.1:` 或在 `DOCKER-USER` 链里过滤，再加上供应商侧防火墙。这一条不是比特特有的，但必须做（CLAUDE.md 开放事项里的“STF production auth”）。

2. **隧道专用账号**（只能做反向转发，而且只能监听一个端口）
   ```bash
   adduser --system --group --shell /usr/sbin/nologin --home /var/lib/bbtunnel bbtunnel
   install -d -m 700 -o bbtunnel -g bbtunnel /var/lib/bbtunnel/.ssh
   # /var/lib/bbtunnel/.ssh/authorized_keys（一行；from= 填 Windows VPS 的公网 IP）
   restrict,port-forwarding,permitlisten="127.0.0.1:54345",from="<WIN_PUBLIC_IP>" ssh-ed25519 AAAA... bb-win-01
   chown bbtunnel:bbtunnel /var/lib/bbtunnel/.ssh/authorized_keys && chmod 600 $_
   ```
   ```text
   # /etc/ssh/sshd_config.d/20-bbtunnel.conf
   Match User bbtunnel
       AllowTcpForwarding remote
       PermitListen 127.0.0.1:54345
       PermitOpen none
       GatewayPorts no
       X11Forwarding no
       AllowAgentForwarding no
       PermitTTY no
       ForceCommand /bin/false
   ```
   `sshd -t && systemctl reload ssh`。第二个客户端照此办理：账号 `bbtunnel2` 加 `127.0.0.1:54346`。

3. **我们的服务**：API 用 systemd 直接跑在宿主机上（或者容器用 `network_mode: host`）。原因：它要起 `ssh` 子进程，要访问宿主机 loopback 上的 54345，ssh 隧道还要能被 STF 的 adb 容器连到。项目目前还没有 compose 打包（开放事项）。systemd 单元里设 `Environment=TZ=UTC`、`KillMode=control-group`、`Restart=always`。

4. **`.env` 中与外部手机相关的值**
   ```dotenv
   TZ=UTC
   # 外部手机隧道绑定到 docker0，让 STF 的 adb 容器能连到；不要用 0.0.0.0
   EXTERNAL_ADB_BIND=172.17.0.1
   EXTERNAL_ADB_PORT_MIN=5700
   EXTERNAL_ADB_PORT_MAX=5799
   ADB_DEVICE_HOST=host.docker.internal
   BITBROWSER_KNOWN_HOSTS=/var/lib/cloudphone/bitbrowser_known_hosts   # 持久化路径，记录网关主机密钥（首次使用时信任）
   SSH_PATH=/usr/bin/ssh
   # 可选：relay 实验功能，经反向代理（Caddy/Nginx，TLS）只暴露这个路径，转发到 127.0.0.1:3010
   # SCRCPY_RELAY_URL=wss://<api-domain>/scrcpy-relay
   ```
   STF 的 adb 服务加：
   ```yaml
   adb:
     extra_hosts:
       - "host.docker.internal:host-gateway"
   ```
   ufw 放行容器到宿主机的 5700–5799：`ufw allow in from 172.16.0.0/12 to 172.17.0.1 port 5700:5799 proto tcp`。
   **[未验证]**：这套 Linux 上的组合（docker0 绑定、host-gateway、ufw）还没实测过，第 5.4 步会验证。目前只在 Mac + Docker Desktop 上验证过。

5. **反向代理**：只对外暴露 web 和 `/api`（含 WebSocket）以及可选的 `/scrcpy-relay`。54345 和 5700–5799 只在 loopback/docker0 上，**永远不对外**。

### 5.2 Windows VPS

1. **系统**：4 vCPU / 8 GB / 60 GB（按官方建议；每台开机的手机都会在客户端里开一个窗口，窗口是否持续拉视频流、占多少 CPU 和带宽，[未验证]，20 台以上时要实测）。时区设为 UTC：`tzutil /s "UTC"`。电源计划设为从不睡眠。
2. **防火墙**（本地 API 固定绑定 0.0.0.0，必须挡住；阻止规则优先于允许规则）
   ```powershell
   New-NetFirewallRule -DisplayName "Block BitBrowser Local API" -Direction Inbound -Protocol TCP -LocalPort 54345-54400 -Action Block -Profile Any
   ```
   同时在**供应商安全组**里只放行 RDP（3389），而且只放行管理员 IP；不开放其他任何入站。RDP 开启 NLA、设强密码和账户锁定策略。
3. **安装比特客户端**：只从官网下载，然后登录。在系统设置里：
   - 确认本地服务端口是 **54345**；
   - 打开**开机自启**；
   - **先不要开 Local API Token**，等 §4.3 P0-1 上线后再开，并把 Token 填进来源配置。
4. **自动登录 Windows**（客户端只在登录后启动）：用 Sysinternals **Autologon**（密码以 LSA secret 形式加密存储），给专用的非管理员本地账号 `bbuser` 配置。这个账号设强密码，并拒绝它通过 RDP 以外的方式登录。
   - RDP 断开时**不要注销**：组策略「远程桌面会话主机 → 会话时间限制」里，“已断开会话的时间限制”设为“从不”，“活动但空闲会话的时间限制”也设为“从不”。
   - 断开 RDP 的正确方式是关闭窗口（断开），**不要点“注销”**。
5. **Windows 更新**：设置活动时间，并把重启固定在每周一个低峰窗口（例如周日 04:00 UTC）。比特客户端的自动更新是否会无人值守地重启，[未验证]，先观察一个月。
6. **反向隧道**（内置 OpenSSH 客户端，以 SYSTEM 身份开机运行）
   ```powershell
   New-Item -ItemType Directory C:\ProgramData\bbtunnel
   ssh-keygen -t ed25519 -N '""' -f C:\ProgramData\bbtunnel\id_ed25519 -C bb-win-01
   icacls C:\ProgramData\bbtunnel /inheritance:r /grant "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F"
   # 预置 Linux 主机密钥（从 Linux 上 ssh-keyscan 得到并人工核对指纹）
   Set-Content C:\ProgramData\bbtunnel\known_hosts "<LINUX_IP> ssh-ed25519 AAAA..."
   ```
   `C:\ProgramData\bbtunnel\tunnel.ps1`：
   ```powershell
   while ($true) {
     & "$env:WINDIR\System32\OpenSSH\ssh.exe" -N -T `
       -i C:\ProgramData\bbtunnel\id_ed25519 `
       -o BatchMode=yes -o ExitOnForwardFailure=yes `
       -o ServerAliveInterval=15 -o ServerAliveCountMax=3 `
       -o StrictHostKeyChecking=yes -o UserKnownHostsFile=C:\ProgramData\bbtunnel\known_hosts `
       -R 127.0.0.1:54345:127.0.0.1:54345 bbtunnel@<LINUX_IP>
     Start-Sleep -Seconds 5
   }
   ```
   注册计划任务（取消默认的 72 h 执行时限，失败时重启）：
   ```powershell
   $a = New-ScheduledTaskAction -Execute powershell.exe -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\bbtunnel\tunnel.ps1'
   $t = New-ScheduledTaskTrigger -AtStartup
   $s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
   Register-ScheduledTask -TaskName bbtunnel -Action $a -Trigger $t -Settings $s -User SYSTEM -RunLevel Highest
   Start-ScheduledTask bbtunnel
   ```
   隧道开机就建好，不依赖桌面登录。这样能区分两种故障：“Windows 宕机”时 Linux 端连接被拒绝；“客户端没起来”时连接能建立，但随即被重置。

### 5.3 平台内配置

管理员登录后：设备 → 创建设备 → 比特云手机 → 新建来源，名称 `bit-win-01`，客户端地址 `http://127.0.0.1:54345`。保存时会先做连通性测试，看到手机数量后再添加设备。添加设备**永远不会开机**。

### 5.4 验证（全部免费，不开机）

在 Linux 上执行：

```bash
# 1. 隧道监听只在 loopback
ss -ltnp | grep 54345            # 期望 127.0.0.1:54345，属主是 sshd
# 2. 客户端可达（只输出成功标志和条数，不打印列表内容，因为列表里可能有 adb 密码）
curl -s -m 10 -X POST http://127.0.0.1:54345/phone/list -H 'content-type: application/json' \
  -d '{"page":0,"pageSize":1}' | jq '{success, total: .data.totalNum}'
# 3. 公网上确实访问不到（从另一台机器执行）
nc -zv -w 5 <WIN_PUBLIC_IP> 54345   # 期望超时或被拒绝
nc -zv -w 5 <LINUX_PUBLIC_IP> 54345 # 期望被拒绝
# 4. 集成测试（API 已运行；不加 --power）
cd apps/api && BITBROWSER_API_URL=http://127.0.0.1:54345 npx tsx --env-file=../../.env scripts/bitbrowser-check.ts
# 5. STF 的 adb 容器能连到 docker0 上的端口（借用一个空闲端口临时起监听）
python3 -c 'import socket;s=socket.socket();s.bind(("172.17.0.1",5799));s.listen();input()' &
docker exec cloudphone-stf-adb-1 sh -c 'nc -zv host.docker.internal 5799'   # 期望 succeeded
kill %1
```
- `bitbrowser-check.ts` 默认路径覆盖：来源增删改（仅管理员、保存前测试、不可达地址被拒绝、使用中的来源不能删）、手机列表、添加设备、关机手机保持 `stopped`、重复添加、代理和设备设置被拒绝、审计、删除设备不影响比特侧。
- **故障演练**（不开机即可做）：
  - 在 Windows 上停掉计划任务 `bbtunnel`：Linux 端 `curl` 应立刻失败；API 日志出现 `external phone: power state unavailable`，设备状态不变；重新启动任务后 15–60 s 内恢复。
  - 退出比特客户端：同上，确认 Autologon 加开机自启在重启 Windows 后能自己恢复（`Restart-Computer`，计时到 Linux 端 `curl` 成功为止）。
  - RDP 断开（不注销）24 小时后，确认客户端仍在运行，比特账号仍保持登录。
- **需要计费的端到端验证**（开机 → 隧道 → adb → STF → 远控 → 关机）：`bitbrowser-check.ts --power` **必须事先征得店主同意**，测试结束后它会自动关机。这一步还会顺带验证 Linux 上 docker0 绑定这条 adb 路径；第 152 行“tunnel listens on 127.0.0.1 only”的断言在 docker0 绑定下会失败（见 §4.3 P2），属于预期。

## 5.5 方案 A-TS：Tailscale 组网（店主 2026-11-18 选定，取代 §5.1–5.2 的反向 SSH 隧道）

和 A-WG（§3.1）同一个思路：Linux VPS 与装比特客户端的 Windows 机器（Windows VPS 或一直开着的办公室电脑）加入同一个 Tailscale 网络，API 直接访问 `http://<Windows 的 Tailscale IP>:54345`。不需要隧道脚本、计划任务和受限 SSH 账号，断线由 Tailscale 自动重连。

前提（代码已具备）：来源配置支持 Local API Token（`apiKey`，加密保存，请求头 `x-api-key`，§4.3 P0-1 已做）；只读调用 8 s 超时 + 每个客户端的健康记录，客户端失联时 monitor 跳过它的手机（§4.3 P0-3 已做）。所以 Tailscale 断线时数据包被静默丢弃也只会等 8 s，不会拖住其它来源。

### 5.5.1 Tailscale 后台（一次性）

1. 用店主的账号登录 https://login.tailscale.com 。免费版够用：本方案只有 2 台机器。若不想依赖 Tailscale 的协调服务器，可以自建 Headscale，步骤相同，只是 `tailscale up` 多一个 `--login-server`。
2. **Access controls**：只允许 API 服务器访问 Windows 的 54345 端口，其它一概不通（默认策略是全通，必须改）：
   ```json
   {
     "tagOwners": {
       "tag:cloudphone-api": ["autogroup:admin"],
       "tag:bitbrowser":     ["autogroup:admin"]
     },
     "acls": [
       { "action": "accept", "src": ["tag:cloudphone-api"], "dst": ["tag:bitbrowser:54345"] }
     ]
   }
   ```
   需要通过 Tailscale 远程桌面或 SSH 管理时，再按需加规则（例如管理员设备 → `tag:bitbrowser:3389`），不要加 `*:*`。
3. **Settings → Keys**：生成两个**一次性、带标签、预授权**的 auth key，一个带 `tag:cloudphone-api`，一个带 `tag:bitbrowser`。auth key 只用来入网，用完即失效，不要存进仓库或 `.env`。
4. 两台机器入网后，在 **Machines** 里对它们都点 **Disable key expiry**，否则默认 180 天后掉线。

### 5.5.2 Linux VPS

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --auth-key=<tag:cloudphone-api 的 key> --hostname=cloudphone-api
tailscale ip -4            # 记下本机 IP（100.x.y.z），Windows 防火墙要用
```
- API 容器是 host 网络（docs/10 §1），直接就能访问 Tailscale 地址，不需要改 compose 或 ufw（只有出站连接，没有新入站）。
- 不要开 `--advertise-exit-node` / `--advertise-routes`，也不要让 Tailscale 接管 DNS（`--accept-dns=false`，避免影响容器解析）：
  `sudo tailscale set --accept-dns=false`

### 5.5.3 Windows（Windows VPS 或办公室电脑）

1. 系统准备照 §5.2 的第 1、3、4、5 步（UTC 时区、不睡眠、安装比特客户端并开机自启、Autologon、RDP 断开不注销、更新窗口）。**§5.2 第 6 步的反向隧道不用做。**
2. 安装 Tailscale（官网 Windows 安装包），管理员 PowerShell：
   ```powershell
   tailscale up --auth-key=<tag:bitbrowser 的 key> --hostname=bitbrowser-win-01 --unattended
   tailscale ip -4            # 记下这台的 IP，平台里要填
   ```
   `--unattended` 让 Tailscale 以服务方式运行，不依赖桌面登录，重启后自动连上。
3. **在比特客户端里打开 Local API Token**，复制 Token（平台里要填）。
4. **防火墙**：本地 API 固定绑定 0.0.0.0（§2），必须挡住除 API 服务器以外的一切来源。注意 Windows 防火墙里**阻止规则优先于允许规则**，所以不要用 §5.2 第 2 步那条全局阻止规则，改成「默认阻止入站 + 只放行 API 服务器」：
   ```powershell
   Set-NetFirewallProfile -Profile Domain,Private,Public -DefaultInboundAction Block
   # 删掉/禁用安装时可能自动生成的比特客户端放行规则（名称因版本而异，先查看）
   Get-NetFirewallRule -Direction Inbound -Enabled True | Where-Object { $_.DisplayName -match 'BitBrowser|比特' } | Disable-NetFirewallRule
   # 只允许 Linux VPS 的 Tailscale IP 访问 54345
   New-NetFirewallRule -DisplayName "BitBrowser API from cloudphone-api" -Direction Inbound -Protocol TCP -LocalPort 54345 `
     -RemoteAddress <Linux 的 Tailscale IP> -Action Allow -Profile Any
   ```
   供应商安全组照旧：只放行管理员 IP 的 RDP（或干脆不开 RDP，改走 Tailscale）。三道防线：供应商安全组（公网）、Tailscale ACL（组网内）、Windows 防火墙（本机）。

### 5.5.4 平台内配置

管理员：设备 → 创建设备 → 比特云手机 → 新建来源（或编辑已有来源）：
- 客户端地址：`http://<Windows 的 Tailscale IP>:54345`（用 IP，不用 MagicDNS 名称，少一个依赖）
- API Token：填上一步复制的 Token（保存后不再显示）
- 时区：Windows 的时区（按 §5.2 设成 UTC 就填 `UTC`）

保存时会先做连通性测试，显示手机数量。添加设备不会开机。

### 5.5.5 验证（全部免费，不开机）

在 Linux 上：
```bash
tailscale ping bitbrowser-win-01                     # 期望 pong（direct 或 via DERP 都行）
# 客户端可达（只输出成功标志和条数，不打印列表内容：列表里可能有 adb 密码）
curl -s -m 10 -X POST http://<WIN_TS_IP>:54345/phone/list -H 'content-type: application/json' \
  -H "x-api-key: $BB_TOKEN" -d '{"page":0,"pageSize":1}' | jq '{success, total: .data.totalNum}'
# 不带 Token 应被拒绝（403）
curl -s -o /dev/null -w '%{http_code}\n' -m 10 -X POST http://<WIN_TS_IP>:54345/phone/list -H 'content-type: application/json' -d '{}'
# 集成测试（API 已运行；不加 --power）
cd apps/api && BITBROWSER_API_URL=http://<WIN_TS_IP>:54345 npx tsx --env-file=../../.env scripts/bitbrowser-check.ts
```
从另一台不在 Tailscale 网络里的机器：`nc -zv -w 5 <WIN_PUBLIC_IP> 54345` 期望超时或被拒绝。在 Tailscale 网络里但不是 `tag:cloudphone-api` 的设备上执行同样的 `curl`，期望超时（ACL 生效）。

故障演练：
- Windows 上 `tailscale down`：平台的来源健康状态在一次调用（≤ 8 s）内变成不可达，monitor 跳过它的手机，设备状态不变；`tailscale up` 后 15–60 s 内恢复。
- 重启 Windows（`Restart-Computer`）：Tailscale 服务、Autologon、客户端开机自启三者都恢复后，平台自动恢复；计时到 Linux 端 `curl` 成功为止。
- adb 隧道（`ssh -N -L` 到比特网关）不经过 Tailscale，不受影响；它只依赖 API 能从客户端拿到 adb 密码。

### 5.5.6 从 A-SSH 切换过来（如果已经部署了反向隧道）

1. 按上面完成 Tailscale 与防火墙。
2. 平台里把来源地址从 `http://127.0.0.1:54345` 改成 Tailscale 地址并填 Token，保存（会测试连通）。
3. 停掉并删除 Windows 计划任务 `bbtunnel`，删除 Linux 上的 `bbtunnel` 受限账号和 `authorized_keys` 条目。

## 6. 监控与恢复清单

**监控**（P1-3 落地前先用外部探针；探针**只做 TCP 检查**，不调接口，避免占用 1 req/s 的限速额度）：

| 项目 | 方法 | 告警条件 |
|---|---|---|
| 隧道端点 | Linux 上每分钟跑一次 systemd timer：`nc -z 127.0.0.1 54345` | 连续 3 次失败 |
| 客户端/账号可用 | API 日志里的 `power state unavailable` / `bitbrowser.*` 频率（journald 加 grep，或接日志平台）| 5 分钟内超过 N 条 |
| 端口漂移 | Windows 上每 5 分钟检查一次 `Get-NetTCPConnection -LocalPort 54345 -State Listen` | 不存在（客户端可能已换到 54346）|
| Windows 待重启/更新 | 计划任务检查 `RebootRequired` 注册表项 | 存在超过 3 天 |
| adb 隧道 | `ps -C ssh` 数量与运行中的外部设备数比对；设备 `adbState=offline` 超过 2 分钟 | 不一致 |
| 费用 | 每天人工或脚本比对比特侧开机列表与平台中 `running` 的设备 | 比特侧开机但平台里没有在用 |
| 手机到期 | `/phone/list` 的 `expireTime` | 7 天内到期 |
| 磁盘/内存 | 两台机器常规监控 | >85% |

**恢复手册**：

| 症状 | 处理 |
|---|---|
| Linux 端 54345 拒绝连接 | 查 Windows 计划任务 `bbtunnel`（`Get-ScheduledTask bbtunnel`）→ 手动 `ssh -v` 看报错 → Linux 上 `journalctl -u ssh` 查有没有 `remote port forwarding failed`（旧会话没释放，最多等 45 s）|
| 能连上，但立刻断开或返回空 | 客户端没在运行或端口已漂移：RDP 上去启动客户端，在设置里把端口改回 54345 |
| `bitbrowser.api_error` 且 msg 是登录相关 | 比特账号掉登录，RDP 上去重新登录 |
| 403 `x-api-key` | Token 不一致（P0-1 上线后）：重新设置来源里的 Token |
| 手机已开机但设备 `offline` | 等一轮 monitor（15 s）。还不行就在平台里“重启连接”或停止再启动（启动会走 `ensureTunnel`）；查 `var/bitbrowser_known_hosts` 是否因为网关换了主机密钥导致 ssh 拒绝连接 |
| Windows 重启后一直起不来 | 供应商控制台 VNC 登录，检查 Autologon 和开机自启 |
| 需要换 Windows 机器 | 新机器照 §5.2 配好，用同一个隧道端口接入 Linux，来源配置不用改（这就是固定 loopback 地址的好处）|

## 7. 扩展到 20–50 台手机 / 多账号

- **限速**：每个客户端 1 req/s。现在 monitor 每台每轮 1 次 `running`，50 台时每轮约 55 s，用户操作要跟着排队。**P1-1 和 P1-2 是 20 台以上的前提。**
- **多客户端**：代码已支持（`device_sources` 每行一个客户端地址，`bitbrowserClient()` 按地址各开一条队列）。每增加一个比特账号：一台 Windows VPS、一个 `bbtunnelN` 账号、一个 Linux 端口（54346…），加一个来源。
- **端口池**：外部 adb 端口 5700–5799 是全局共享的，最多 100 台；超出时调大 `EXTERNAL_ADB_PORT_MAX`，并相应调整 ufw 规则。
- **Windows 负载**：每台开机的手机都会在客户端里弹出一个窗口。50 台时负载[未验证]，可能要多台 Windows 分担，或者确认“挂起”接口能不能在保持 adb 可用的前提下关掉窗口（开放问题）。
- **一台 Windows 只跑一个比特账号**（单实例锁和端口自增，见 §2）。

## 8. 成本（粗略，仅供量级参考，以下单当时的价格为准）

| 项目 | 低价供应商 | 云大厂 |
|---|---|---|
| Linux VPS 4–8 vCPU / 8–16 GB | €15–40/月 | $60–150/月 |
| Windows VPS 4 vCPU / 8 GB（含授权）| €15–40/月 | $70–150/月（Windows 授权约占一半）|
| 比特云手机算力 | 按比特的计费方式（按时或套餐），与部署方案无关 | — |

方案 B 省掉一台机器，但要支持嵌套虚拟化的实例，价格通常在 $80–200/月，并不更便宜。

## 9. 开放问题（需要店主或实测确认）

1. 比特客户端在 **Windows Server**（2022/2025）上能否正常安装和登录？还是必须用 Windows 10/11 镜像？
2. **RDP 断开（不注销）后**，客户端和比特账号登录状态能维持多久？会不会被强制下线？同一账号在 Mac 和 Windows 上同时登录会不会互相踢下线？（迁移期间两边可能都开着）
3. `/phone/adb/get` 的 `expireTime` 是客户端本地时间还是北京时间？（决定 §4.3 P0-5 的实现）
4. **“挂起”状态下 adb 还能用吗**？如果能，可以用它关掉客户端里的手机窗口，降低 Windows 负载（仍计费）。这需要一次计费测试，要征得店主同意。
5. 以后会不会买**套餐模式**（envType 0）的手机？会的话，P1-5 要先做。
6. 是否要多个比特账号？员工子账号能否通过 Local API 操作主账号分享来的手机？
7. 客户端自动更新会不会在无人值守时重启？更新后端口和 Token 设置是否保留？
8. Linux VPS 放在 HK/SG（adb 吞吐好）还是 EU（relay 延迟低、离操作员近）？取决于是否把 relay 设为外部手机的默认源。建议先从候选机房实测到 HK 网关和 Mumbai 代理的延迟再定。
9. 生产上是否继续保留本地 redroid？如果保留，Linux 主机要支持 binder（多数 KVM VPS 可以加载 `binder_linux`；本仓库只在 Lima VM 上验证过）。
