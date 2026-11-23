# 1.6.5 本机 SQLite 和按设备上传实施计划

> 执行时按 `executing-plans` 逐项实现和验收。由当前会话顺序实施。

**目标** 一台电脑一个本机数据库，保存最近 30 天的请求、三个界面各自的两份快照和待确认的上传包。榜单服务按来源 GUID 更新用量。

**实现方式** 插件用 Node 自带的 `node:sqlite` 保存本机数据。现有解析器提供单次请求的统计，榜单端继续使用现有用量表和写入线程。新版上传请求的三个顶层字段为 `username`、`deviceGuid`、`data`。

**设计依据** [本机存储和按设备上传设计](../specs/2026-11-21-local-usage-storage-design.md)（`77ce4d0`）和 [SSH 用量去重设计](../specs/2026-11-21-ssh-usage-deduplication-design.md)。

## 共同规则

- 在当前 `1.6.5` 分支实施，保留工作区已有修复。开工时运行 `npm test`，近期基线为 177 项通过。
- 使用当前 Orca 用户资料目录下的 `tps-plugin/usage.sqlite`。新库直接初始化三张业务表，设备 GUID、登录凭证和界面设置沿用 Orca 存储。库结构用 `PRAGMA user_version` 管理。
- 请求时间为 UTC 毫秒。明细最多保留 720 小时。个人统计按本地日期，榜单每日用量按北京时间。上传包最多 64 KiB。
- 自动化使用临时目录和数据库副本。部署顺序为服务端、插件、测试服双机联调。测试服或正式服的部署和数据操作按各自的授权执行。

| 阶段 | 主要文件 | 单独验收 |
| --- | --- | --- |
| 1. 建本机库 | `src/local-usage-db.mjs`（新增）、`src/data-paths.mjs`、`tests/local-usage-db.test.mjs`（新增） | 三张表，超过 5 MiB 后仍可读写，重启后可恢复。 |
| 2. 存单条记录 | `src/data.mjs`、计算线程、SSH 采集和用量统计 | 重读、轮转和断线保留正确用量。 |
| 3. 缓存界面 | `src/channel-cache.mjs`、`src/worker.mjs`、`src/leaderboard.mjs`、`src/leaderboard-windows.mjs` | 每个界面只保留当前和上次两份快照。 |
| 4. 服务端格式 3 | `server/app.mjs`、`server/store.mjs`、`server/source-uploads.mjs` | 单来源请求使用现有唯一键，旧包和重复请求安全处理。 |
| 5. 按来源续传 | `src/usage-upload.mjs`、`src/submission-stats.mjs`、`src/leaderboard.mjs`、`src/worker.mjs` | 包与编号一起落库，断线后续传，账号和环境各自独立。 |
| 6. 完整验证 | 现有测试、README、部署说明和问题清单 | 全量测试、本机两端对账与插件校验。 |

验收时重点检查半份日志、迟到的工作区响应、服务器已写入但响应丢失、GitHub 改名，以及用量更正跨日期这五个情况。分别在采集、界面、续传、服务端、明细测试中固定预期结果。

## 1. 建立本机数据库

**文件** 新增 `src/local-usage-db.mjs` 和 `tests/local-usage-db.test.mjs`。在 `src/data-paths.mjs` 添加数据库路径解析。

**接口** `openLocalUsageDb(filename)` 返回 `replaceLog(reading)`、`readRecords({ from, to, deviceGuid })`、`readLogVersions(deviceGuid)`、`prune(now)`、`readPanel(panelId, scope)`、`publishPanel(panelId, scope, value, at)`、`queue` 和 `close()`。读取输入 `reading` 含 `deviceGuid`、`logUnitKey`、`logStamp`、`records`、`complete` 和 `now`。记录字段对应设计中 `usage_records` 的列。

- [ ] 在 `tests/local-usage-db.test.mjs` 写空库和重启测试。断言用户业务表名为 `usage_records`、`panel_cache` 和 `upload_queue`，读写一份超过 5 MiB 的明细后重开仍可查询。过期测试用边界前、边界上和边界后的三笔记录。
- [ ] 运行 `node --test tests/local-usage-db.test.mjs`，确认测试在存储模块缺失时失败。
- [ ] 建表并使用备好的 SQL 语句批量写入。明细以 `(device_guid, record_id)` 为唯一键，建完成时间索引和 `(device_guid, log_unit_key)` 索引。存时间窗为 `[now - 720h, now]`。数据库打开或写入失败时返回明确错误，保留现有库。
- [ ] 实现 `replaceLog` 的批次提交。在一次事务中保存读到的记录，返回本次发生变动的旧、新时间点。仅当 `complete` 时核对缺失行。临时读不到、读一半或版本变化时保留此前记录。把取消和持久化失败加入测试。
- [ ] 重跑本库测试，再运行 `git diff --check`。通过后进入采集接入。

## 2. 接入单条请求和个人统计

**文件** `src/data.mjs`、`src/computation-worker.mjs`、`src/remote-collector.mjs`、`src/remote-channel.mjs`、`src/usage-summary.mjs`、`src/worker.mjs`，以及现有的采集、SSH 和用量测试。

**接口** `discoverUsageUnits(cutoff, { includeRecords: true, ...options })` 沿用现有描述。明细读取以现有记录字段分页，返回 `{ records, nextOffset, complete }`。本地线程以 `usageRecords(key, stamp, offset)` 调用，SSH 使用同样的三项结果和现有 GUID 校验。用量索引提供 `leaderboardSources(reporterId)` 和 `summary()`，分别从明细计算榜单和个人统计。

- [ ] 扩展已有解析和 SSH 测试。覆盖 A 本机 30、共用远端 100、两个 SSH 别名仍只算 100。加入一份跨本地日期和北京时间零点的日志、同毫秒完成的两次请求、末尾半行和超出通信上限的日志。
- [ ] 运行 `node --test tests/usage-summary.test.mjs tests/remote-channel.test.mjs`，确认明细接口和存储验证失败。
- [ ] 把 Codex、Claude Code、Pi、OpenCode、Antigravity 和 Hermes 的现有解析结果接入明细。复用请求编号和用量算法，筛选 720 小时范围，只把统计行交给数据库。大的读取沿用流式读取、字节预算和调度让步。
- [ ] SSH 明细分页，每页验证来源、日志版本和位置。版本变化、页面缺失或连接中断时，将该次读取标为未完成。完整页可以分批准备，最后一页确认前保持旧统计。相同 GUID 的两个连接共用一组记录，本机源使用已有设备 GUID。
- [ ] 让个人统计、30 天热力图、按来源每日总量和滚动时间点从明细计算。一次更正从旧时间点移到新时间点时重新计算两边，同一时间点的多条请求先按来源合计。只在扫全时声明覆盖。
- [ ] 重跑用量和 SSH 测试，确认重读后的请求数量一致，断线和失败文件保留上次成功数值，补齐后正常更新。

## 3. 接入三个界面的两份快照

**文件** `src/local-usage-db.mjs`、`src/channel-cache.mjs`、`src/worker.mjs`、`src/leaderboard.mjs`、`src/leaderboard-windows.mjs`、`src/panel.html`、`tests/panel.test.mjs` 和 `tests/leaderboard.test.mjs`。

**接口** 使用第一阶段的 `readPanel` 和 `publishPanel`。界面编号为 `current-data`、`usage` 和 `leaderboard`。当前数据按工作区匹配，榜单范围包含目标地址、账号和所选周期，个人统计按当前资料匹配。

- [ ] 写三组界面测试。连续成功写入 A、B、C 后断言当前为 C、上次为 B。断线和重启还能读取 B、C 的原始更新时间。切换工作区、GitHub 账号和服务器时，只显示新范围的数据。旧工作区的网络请求最后返回时，当前快照仍属于新工作区。
- [ ] 运行 `node --test tests/panel.test.mjs tests/leaderboard.test.mjs`，确认新的界面快照路径尚未通过。
- [ ] 在现有成功返回入口写入快照。持久化每次成功的可显示结果，两份快照在同一事务内移动。失败或过期的异步响应只使用相同范围的可读结果。三个界面共三行，快照类型与各自面板现有格式一致。
- [ ] 重跑面板和榜单测试，核对隐藏榜单、重新打开、换工作区，以及榜单开关的原有行为。

## 4. 服务端接收新版单来源格式

**文件** `server/app.mjs`、`server/store.mjs`、`server/source-uploads.mjs` 和 `tests/leaderboard.test.mjs`。

**接口** `POST /api/leaderboard/uploads` 增加 `{ username, deviceGuid, data: { format: 3, operation, requestId, … } }`。用量操作对应现有 `lease`、`update`、`baseline-part` 和 `baseline-commit`。账号级迁移查询和确认继续走已有控制入口。账号状态返回 `uploadFormat: 3` 和稳定的 `accountId`。

- [ ] 写格式 3 接口测试。断言一包只认一个 GUID，重复请求得到相同确认，不同内容复用编号会被拒绝。用每天和时间点的 100 → 130 测试覆盖写入，用过期资格和旧版本验证迟到包被拒绝。
- [ ] 运行 `node --test tests/leaderboard.test.mjs`，确认格式 3 尚未受理。
- [ ] 验证登录、用户名、来源和包大小，把合法的一包映射到现有来源写入方法。沿用写入线程、账号上传间隔、封禁、清分和现有唯一键。用量字段包括 `daily`、`buckets` 和有效 `coverage`。SSH 取 `reporterGuid` 及 `leaseEpoch`，本机根据来源推导上报者。
- [ ] 按真实账号编号处理 GitHub 改名。已经确认过的原样重试可以查旧确认。未入库的旧用户名包返回明确的改名结果。账号迁移流程和格式 2 访问按原有规则继续。
- [ ] 重跑榜单测试，覆盖 A 本机 30、B 本机 20 和同一个 SSH 100 的当天及三张滚动榜合计 150。验证远端接手前保留原值。测试 64 KiB 边界、清分、锁定、封禁和跨北京时间零点。

## 5. 按来源落库和续传

**文件** `src/local-usage-db.mjs`、`src/usage-upload.mjs`、`src/submission-stats.mjs`、`src/leaderboard.mjs`、`src/worker.mjs`、`tests/local-usage-db.test.mjs` 和 `tests/leaderboard.test.mjs`。

**接口** `queue.stage({ origin, accountId, deviceGuid, affected })` 保存需更新的日期和时间点。`queue.draft({ origin, accountId, deviceGuid })` 读回待汇总的时间点与该来源的确认版本。`queue.next({ origin, accountId })` 读回下一个已冻结的包。`queue.freeze({ origin, accountId, deviceGuid, requestId, body, revision, affected })` 保存完整包。`queue.confirm({ origin, accountId, deviceGuid, requestId, result })` 在一个事务内确认并推进来源进度。各状态用同一张表。

- [ ] 写断线和重启测试。发包后丢失回应时，重启仍发相同的请求编号和正文。待确认期间新增记录进入之后的包。在保存明细或变动队列时模拟错误，并确认两者一起成功或一起保留原值。测试登录用户改名、账号切换、测试服切到正式服、旧版服务端和大批次。
- [ ] 运行 `node --test tests/local-usage-db.test.mjs tests/leaderboard.test.mjs`，确认 SQLite 队列续传尚未通过。
- [ ] 在写明细的同一事务中，把更正产生的旧、新日期和时间点写入已知目标的队列。同一范围尚未冻结的变动可合并。消费时重新计算来源在对应时间点的总量。首次使用该账号或环境时安排近 30 天的批次。服务器拒绝过期资格后，按新的资格准备完整快照。
- [ ] 冻结后的包用原编号和原正文发送。在同一事务标记完成并保存该来源的确认范围及版本。提交失败后保留待确认包，继续确认仍在统计范围内的数据。速度摘要随已确认的来源包结算，保留当前部分失败提示。
- [ ] 按 JSON 字节数拆包。格式 3 一次只上传一个来源，按来源轮换，避免大批次占满后续发送机会。旧服务端走现有兼容格式时，同步进度也通过本机队列保存。当前数据、自动上传和榜单刷新保持各自独立的调度。
- [ ] 重跑库和榜单测试，检查两个用户、两个服务器的队列隔离，以及 SSH 失联时本机仍能上传。

## 6. 完整验收和文档

- [ ] 用新库集成运行整套插件流程。验证三张表、历史 30 天边界、两份快照、超过 5 MiB 的本机库、重启续传和源 GUID 一致性。
- [ ] 运行 `npm test`、`git diff --check` 和 `orca plugin validate . --json`，全部通过后完成本地验收。
- [ ] 使用 `plugin-publish` 核对中英文 README 和 Orca 插件目录资料，说明个人统计读最近 30 天、本机 SQLite 及服务端先更新的顺序。按实际结果更新 `docs/known-issues.md` 和 `server/README.md`。
- [ ] 用两个客户端在测试服验证同一个远端 GUID、150 Token 合计、断线接手以及旧账号已有记录的核对。将本地自动化和线上联调分别记录。
