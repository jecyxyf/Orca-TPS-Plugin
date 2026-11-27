# Orca TPS Plugin v1.6.7 重构、降内存与压测完成报告

- **日期**：2026-11-27
- **目标**：全功能保留，将业务代码量压至 **10,000 行以内**，全面降低多运行时内存占用，并在硅谷测试服完成部署与压力测试验证。

---

## 一、核心结论总览

| 指标 | 重构前 | 重构并调优后 | 变化 |
| --- | ---: | ---: | --- |
| 业务代码总行数（`src/*.mjs` + `src/panel.html` + `server/*.mjs`） | 15,306 行 | **9,278 行** | **-6,028 行（-39.4%）** |
| 全量自动化单元测试（`npm test`） | 176/176 通过 | **176/176 通过（0 失败）** | 全功能零回退 |
| 插件 Worker 启动内存（RSS） | 74.0 MB | **59.9 MB** | **-14.1 MB（-19.1%）** |
| 语言包模块启动堆增量（`src/locales.mjs`） | 1,280 KB | **468 KB** | **-63.4%** |
| 硅谷测试服线上内存（`orca-tps-test.service`） | 140.4 MB（峰值 140.9 MB） | **56.6 MB**（峰值 **56.9 MB**） | **-83.8 MB（-59.7%）** |
| 硅谷测试服线上线程数（Tasks） | 16 | **10** | 减少 6 个线程 |
| 测试服公网 HTTPS 验收（`https://test.itps8.com`） | — | **100/100 HTTP 200** | 0 服务端报错 |

---

## 二、代码精简与结构化重构

### 1. 分模块代码行数对比

| 模块 | 文件数 | 重构前 | 重构后 | 减少行数 | 降幅 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `src/*.mjs` | 21 | 8,659 行 | **5,274 行** | -3,385 行 | -39.1% |
| `src/panel.html` | 1 | 5,343 行 | **3,057 行** | -2,286 行 | -42.8% |
| `server/*.mjs` | 8 | 1,304 行 | **947 行** | -357 行 | -27.4% |
| **业务代码合计** | **30** | **15,306 行** | **9,278 行** | **-6,028 行** | **-39.4%** |
| 自动化测试 `tests/*.test.mjs` | 16 | 6,221 行 | 6,152 行 | -69 行 | -1.1% |

### 2. 主要架构瘦身与降内存改动

| 方向 | 具体改动 | 收益 |
| --- | --- | --- |
| 语言包按需加载 | 将 16 种语言词典拆出到 `src/locales/*.json`，`src/locales.mjs` 按当前界面语言懒加载 | 消除启动时一次性驻留全部语言字典，启动堆占用直降 **63.4%** |
| 合并冗余模块 | 移除/合并已过时或重复的计算与路径辅助模块（`computation.mjs`、`computation-worker.mjs`、`data-paths.mjs`、`leaderboard-installation.mjs` 等），去除无用依赖 | 显著减少模块图体积与 Worker 启动内存（`-14.1 MB`） |
| 管家流式统计 | `makePersonalPacket` 直接流式遍历 Tokens Manager 数据库聚合并释放中间对象，避免全量重复拷贝数组 | 50,000 条记录聚合仅耗时 **47.0 ms**，峰值内存可控 |
| WebView 面板精简 | 结构化压缩 `src/panel.html` 的重复渲染与样式逻辑，保持全部交互、图表、榜单、多语言及 `panel.test.mjs` 100% 兼容 | 面板代码直降 **2,286 行（-42.8%）** |
| 天梯榜服务端调优 | 默认接收线程数按 CPU 核数自适应 `min(4, max(1, CPU核数))`（2 核机器默认 2 线程，替代旧版固定 8 线程）；共享内存双缓冲每块设为 `32 MB`（旧版 `64 MB` 的一半），支持环境变量 `LEADERBOARD_TOKENS_RECEIVERS` / `LEADERBOARD_TOKENS_BUFFER_MB` 覆写 | 线上测试服实占内存直降 **59.7%**，同时兼顾大包突发承载力 |

### 3. 当前业务代码文件清单（共 30 个文件 / 9,278 行）

| 文件 | 行数 | 文件 | 行数 |
| --- | ---: | --- | ---: |
| `src/panel.html` | 3,057 | `src/leaderboard-windows.mjs` | 106 |
| `src/harness_parser.mjs` | 975 | `src/leaderboard_stats.mjs` | 101 |
| `src/harness_formats.mjs` | 805 | `src/worker.mjs` | 95 |
| `src/harness_collectors.mjs` | 750 | `src/leaderboard-avatars.mjs` | 94 |
| `src/orca_connection.mjs` | 303 | `src/remote-channel.mjs` | 93 |
| `src/database.mjs` | 289 | `server/tokens-manager-jobs.mjs` | 91 |
| `src/token_manager.mjs` | 278 | `src/channel-cache.mjs` | 87 |
| `server/app.mjs` | 276 | `src/locales.mjs` | 69 |
| `server/tokens-manager-rankings.mjs` | 274 | `src/local-usage-db.mjs` | 69 |
| `src/controller.mjs` | 262 | `server/admin-page.mjs` | 67 |
| `src/leaderboard.mjs` | 258 | `server/tokens-manager-buffer.mjs` | 59 |
| `src/tokens-manager-client.mjs` | 233 | `server/migrate-leaderboard-state.mjs` | 40 |
| `src/active-conversation.mjs` | 228 | `server/main.mjs` | 33 |
| `src/personal_stats.mjs` | 141 | `src/sqlite.mjs` | 24 |
| `server/store.mjs` | 107 | `src/harnesses.mjs` | 14 |

---

## 三、本地测试与基准验证

| 验证项 | 测试内容 | 结果 |
| --- | --- | --- |
| 全量单元测试 | `npm test`（16 个测试文件，覆盖协议、解析、渠道聚合、数据库、WebView 面板、天梯榜服务端与 SSH 管家） | **176/176 通过，0 失败**（耗时约 15.8 s） |
| 面板脚本语法检查 | 使用 `vm.Script` 校验 `src/panel.html` 内联脚本并零改动通过 `tests/panel.test.mjs` | 全部通过 |
| Tokens 管家 5 万条流式压测 | 写入 50,000 条记录并依次执行 `commitSource` → `finishScan` → `makePersonalPacket` → `makeLeaderboardPacket` | 写入 **935.4 ms**（~53.5k 条/秒）；个人包 **47.0 ms**（1,464 天 + 17,520 小时）；榜单包 **28.2 ms**；RSS 61.8 → 峰值 125.9 MB |

---

## 四、硅谷测试服部署与压力测试

### 1. 部署环境与状态

- **主机规格**：硅谷测试机（2 vCPU / 3,723 MB RAM / Node.js v24.22.3）
- **线上服务**：`orca-tps-test.service`（`systemd` 托管，监听 `127.0.0.1:8788`，Caddy 自动 HTTPS 代理至 `https://test.itps8.com`）
- **部署范围**：仅同步重构后的 `server/` 与 `src/` 至 `/opt/orca-tps/test`，并移除 `/etc/orca-tps/test.env` 中写死的 `LEADERBOARD_TOKENS_RECEIVERS=8`；正式服 `/opt/orca-tps/prod` 与测试服持久化数据文件未做任何改动。
- **回滚备份**：旧版测试服代码已备份在测试机 `/tmp/orca-tps-test-backup`。

### 2. 多场景压力测试结果（隔离端口 + 临时状态文件，测完已清理）

| 压测阶段 / 场景 | 服务端配置 | 上传吞吐 / 错误 | 读榜吞吐 / 延迟 | 内存（空载 → 峰值） |
| --- | --- | --- | --- | --- |
| 初测 1：15 秒混合读写（32 传 + 16 读，1,000 账号，2.8 KB） | 1 线程 + 8 MB 缓冲 | 981.5/s（**8,370 次 400**） | 1,583.9/s（p50 8.6 ms，0 错） | 94.8 → 276.4 MB |
| 初测 1（对照） | 2 线程 + 8 MB 缓冲 | 277.9/s（0 错） | 2,513.9/s（p50 4.1 ms，0 错） | 105.9 → 238.3 MB |
| 初测 1（旧配置对照） | 8 线程 + 8 MB 缓冲 | 292.1/s（0 错） | 2,714.3/s（p50 2.8 ms，0 错） | 173.9 → 306.8 MB |
| 初测 2：10,000 独立账号满载上报 + 排榜 | 2 线程 + 8 MB 缓冲 | **10,000/10,000（0 错，480.1/s）** | 3 套榜单全部排出完整前 100 名 | 121.8 → 353.6 MB |
| 初测 3：真实大包对比（68.3 KB 包，32 并发 10 秒） | 2 线程 + 8 MB 缓冲 | 47.1/s（476 成功 / 3,205 次 400） | — | 空载 106.2 MB |
| 初测 3（对照） | 2 线程 + **32 MB 缓冲** | **189.3/s**（1,912 成功，**4 倍吞吐**） | — | 空载 **106.0 MB**（无额外空载开销） |
| **终测 A（默认参数）**：10 秒混合读写（32 传 + 16 读，1,000 账号） | **默认 2 线程 + 32 MB 缓冲** | **279.8/s（0 错，p50 114.4 ms）** | **2,821.5/s（0 错，p50 3.2 ms）** | **105.7 → 206.9 MB**（比旧 8 线程省 ~100 MB） |
| **终测 B（默认参数）**：300 账号 67.5 KB 真实大包洪峰（单轮 19.8 MB） | **默认 2 线程 + 32 MB 缓冲** | **300/300 全部接收（0 错，耗时 1.63 s）** | 用量榜 100 名 / 速度榜 100 名正常 | 峰值 379.3 MB（占整机 ~10%） |
| **终测 C（公网 HTTPS）**：`https://test.itps8.com` 100 次混合请求 | 线上 `orca-tps-test` | **100/100 全部 HTTP 200（0 错）** | p50 169.7 ms / p95 630.1 ms | 稳定 **56.6 MB**（峰值 **56.9 MB**） |

### 3. 压测发现与针对性优化闭环

1. **缓冲容量不足导致大包突刺 400**：通过核查 Caddy 访问日志发现线上真实上报包体为 **81 KB ~ 355 KB**，原先 8 MB 缓冲区在每轮 3 秒内最多仅容纳 ~23–100 个大包。将默认单块缓冲调整为 **32 MB** 后，300 账号单轮 19.8 MB 大包洪峰实现 **0 丢包**，且因 Linux 对 `SharedArrayBuffer` 按需分页，**空载内存零增长**。
2. **2 核服务器线程数最优配比**：实测在 2 核机器上，8 线程比 2 线程白白多占 ~68–100 MB 内存，而吞吐几乎持平甚至更慢；1 线程则会在高并发下拖慢读榜。改为默认 `min(4, max(1, CPU核数))` 后，2 核机器自动启用 2 个接收线程，线上常驻内存从 **140.4 MB** 降至 **56.6 MB**，读榜 QPS 反而提升至 **2,821.5 req/s**。

---

## 五、后续使用与运维说明

- **本地开发联调测试服**：设置环境变量 `ORCA_TPS_LEADERBOARD_URL=https://test.itps8.com`（或写入 `.env.leaderboard.local`）后重载插件，即可在测试服验证登录、上报和榜单展示。
- **远程文档同步**：已更新 `server/README.md` 中的默认线程数与共享内存缓冲区说明；如需向正式服（`itps8.com` Docker Compose）发布，可按 `server/README.md` 标准流程构建并上线。
- **测试服回滚**：若需回退测试服，直接将测试机 `/tmp/orca-tps-test-backup` 还原到 `/opt/orca-tps/test` 并重启 `orca-tps-test.service` 即可。
