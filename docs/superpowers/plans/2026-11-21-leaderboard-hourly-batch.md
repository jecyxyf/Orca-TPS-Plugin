# 榜单按小时存储与批量写入实施计划

**目标** 每 2 秒先批量读取本批设备的进度，再按账号、来源和小时合并更新。每小时整点发布四张榜。旧小时可补传，共用 SSH 的用量只计一次。

**设计依据** [榜单按小时存储与批量写入设计](../specs/2026-11-21-leaderboard-hourly-batch-design.md)（`59e00ae`）。在当前 `1.6.5` 分支按下面顺序实施。先在临时库验证，切换验收使用测试服数据库副本。

| 阶段 | 涉及文件 | 验收结果 |
| --- | --- | --- |
| 1. 建小时数据和结果表 | `server/leaderboard-data.mjs`（新增）、`server/store.mjs` | 同一个账号、来源、小时只有一行。重开数据库可读上次发布的结果。 |
| 2. 实现整批写入 | `server/leaderboard-data.mjs`、`server/store.mjs`、`server/source-uploads.mjs`、`server/app.mjs` | 一次查本批进度，同一小时只写一次，重发安全。 |
| 3. 插件按小时发包 | `src/hourly-source-upload.mjs`（新增）、`src/record-usage-index.mjs`、`src/remote-collector.mjs`、`src/remote-channel.mjs`、`src/worker.mjs`、`src/leaderboard.mjs`、`src/usage-upload.mjs` | 本机和 SSH 分来源，补发旧小时和重试都能续上。 |
| 4. 整点算榜并发布 | `server/leaderboard-jobs.mjs`、`server/leaderboard-thread.mjs`、`server/ranking-snapshot.mjs`、`server/main.mjs`、`server/app.mjs`、`src/leaderboard-windows.mjs` | 四张榜共享截止时间。计算失败或重启时可读取最近有效结果。 |
| 5. 迁移和完整验收 | 服务端迁移与管理入口、现有测试、`server/README.md`、`README.md`、`README.zh-CN.md`、`orca-plugin.json` | 相同截止时间核对四张榜。测试两台电脑共用 SSH、断线、接手和旧账号切换。 |

## 1. 建两张表和基础读写

- [ ] 在 `tests/leaderboard.test.mjs` 用临时 SQLite 库覆盖唯一键、来源进度、小时范围、两份榜单结果和重启恢复。正时间戳是小时行，`hour_start = 0` 是来源进度行。
- [ ] 在 `server/leaderboard-data.mjs` 实现 `leaderboard_data` 和 `leaderboard_results`。复用 `server/store.mjs` 的连接和事务。按账号、来源、小时设唯一键，按小时建索引。只读线程打开时只准备查询。
- [ ] 将用量更新时间、覆盖终点、提交时间与速度样本的时间分别保存。清理 720 小时之外的用量和 24 小时之外的速度，保留来源进度。榜单结果按 `cutoff_at` 保存，同一截止时间重算时更新原结果。
- [ ] 运行 `node --test tests/leaderboard.test.mjs` 和 `git diff --check`。

## 2. 每两秒整批查进度、合并再写

- [ ] 扩展 `server/app.mjs` 的现有上传入口。新增小时格式 `data.format: 4`，沿用 `username`、`deviceGuid`、`data` 结构。每包一个来源，带请求编号和若干小时值。使用独立能力字段告诉新插件是否启用，保留旧插件识别的 `uploadFormat`。继续校验登录、GUID、时间、数值和 64 KiB 包大小。
- [ ] 在 `server/store.mjs` 的 `uploadBatch` 中收集小时包的账号、来源和小时键。复用现有账号、封禁、限流和写入资格校验。开始事务后批量读取本批来源进度和涉及的小时行，键比较多时分组查询，避开 SQLite 参数数量上限。
- [ ] 在内存按每个小时处理包。缺失小时可插入。已存在时仅接受更新的 `usage_updated_at` 且 `covered_until` 与旧值一样新或更晚的完整结果。相同数据确认成功。同一时间内容不同就保留原值并返回重新扫描的结果。设备最新时间用来查进度，每个小时独立比较。
- [ ] 复用 `server/source-uploads.mjs` 的 SSH 上报资格规则。资格状态保存在对应来源的进度行。接手时递增资格编号，从远端完整扫描对应小时后才能覆盖。批内按收到顺序处理资格操作，用内存中的最新资格判断后续包。
- [ ] 一个小时的用量取校验后的最新值，速度取合格样本中最快的一笔，保留测速编号及匹配的模型、Harness、时间和新增 Token。复用准备好的写入语句。写完小时和来源进度才提交事务，并按原顺序回复每个包。
- [ ] 在 `tests/leaderboard.test.mjs` 验证批内 700→900 只更新一行。覆盖同一包重发、旧包迟到、已收到今天 11 点后补写昨天 10 点、短覆盖、同时间不同内容和事务回滚。模拟账号下两个来源，确保一台电脑的进度不会挡住另一台。
- [ ] 运行 `node --test tests/leaderboard.test.mjs`。通过后进插件阶段。

## 3. 插件保存完整小时小计并续传

- [ ] 让 `src/record-usage-index.mjs` 从本机库按 GUID 和完成时间算小时小计。复用现有 Token 统计算法和日志完整性检查。当前小时可上传已经完整读取的部分，旧小时补传保留原小时。确认读全后允许用 0 更正这一小时。
- [ ] 让 `src/remote-collector.mjs`、`src/remote-channel.mjs` 为完整远端扫描提供同一远端时钟的更新时间和覆盖终点。保留远端 GUID/分页一致性校验。读取中断时保留原有结果。每个上报者按来源顺序扫描和保留结果。
- [ ] 在 `src/worker.mjs` 和 `src/leaderboard.mjs` 接入按来源的小时读取。先用现有能力协商，再选小时格式或兼容路径。继续使用稳定的来源 GUID 和隔离的账号、服务端队列。
- [ ] 在 `src/hourly-source-upload.mjs` 生成每包一个来源的 `{ username, deviceGuid, data }`。`data` 带格式号、操作、请求编号、小时小计和所需资格。复用 `src/usage-upload.mjs` 中的本机 SQLite 待传队列。超时重发保持请求编号、更新时间、测速编号和内容。按服务器确认移动进度，响应要求补扫时重新完整读取后再提交。
- [ ] 扩展 `tests/local-usage-db.test.mjs`、`tests/remote-channel.test.mjs` 和 `tests/leaderboard.test.mjs`。覆盖跨小时、日志读一半、A 读到 100 条/B 读到 200 条、B 接手前后结果、接手时 A 迟到、重启续传和跨整点重发送样本。
- [ ] 运行 `node --test tests/local-usage-db.test.mjs tests/remote-channel.test.mjs tests/leaderboard.test.mjs`。

## 4. 整点生成并保存四张榜

- [ ] 在 `server/leaderboard-jobs.mjs` 保留 2 秒写入调度。整点先提交接收时间早于截止时刻的待写包，再让 `server/leaderboard-thread.mjs` 的读线程开始本次榜单。等读线程执行首次读取并固定 SQLite 快照后，放行下一批写入。测试读线程退出或失败时也能释放写入。
- [ ] 在 `server/ranking-snapshot.mjs` 以同一个截止时间计算窗口。完整小时用量按 `[截止时间 - 24/168/720 小时, 截止时间)` 聚合。速度按账号取过去 24 个完整小时的最佳样本，排前 20。复用榜单现有字段、显示顺序、用户细节和近 5 分钟速度曲线。
- [ ] 把计算结果交给写入线程保存。确认保存后更新公开缓存。进程启动时从结果表读取最新有效快照，缺失时补算最近整点。保留 `cutoffAt`、`nextAt` 和 `boards` 供现有插件读取。将 `src/leaderboard-windows.mjs` 的整点同步对齐 `nextAt`，保留手动刷新和断线重连。
- [ ] 在 `tests/leaderboard.test.mjs` 构造固定整点。核对 24、168 和 720 小时的首尾，整点刚到的包进入下一份结果，写入无需等排名结束。覆盖速度重发、发布时间更新、服务重启、排名计算失败和最新两份快照。
- [ ] 运行 `node --test tests/leaderboard.test.mjs tests/panel.test.mjs`。

## 5. 迁移、管理动作和验证

- [ ] 在 `server/store.mjs` 和 `server/source-uploads.mjs` 按账号迁移。已能区分来源的记录按完成时间汇总为小时。旧电脑的本机与 SSH 混合总量从日志重算，旧日总量用于核对。数据库事务先检查旧上报版本，补齐后在同一次提交中切换该账号的读取来源。
- [ ] 迁移期间按同一整点读取新旧用量，再统一生成榜单。旧合格速度样本到期前按账号参与速度榜。旧读取协议继续从对应数据和公开快照取结果。保留已有账号封禁、禁传和清分检查，管理动作发生时使受影响的公开结果失效并重算，避免旧结果重新发布。
- [ ] 用临时库模拟空库、按来源库和旧混合库。旧混合测试保留切换前合计，再用 `A 本机 30 + B 本机 20 + 远端 100 = 150` 验证新结果。中断迁移后核对旧榜仍可读取，恢复后验证来源独立。核对 GitHub 改名、滚动窗口过期和清分后的读写。
- [ ] 跑 `npm test`、`git diff --check` 和 `orca plugin validate . --json`。用 `plugin-publish` 同步检查中英文 README、Orca 清单和受影响的配图说明。部署说明注明小时口径、上传顺序和回退路径。
- [ ] 部署验收先用测试服数据库副本。使用同一截止时间对照四张榜，记录迁移前后的账号数和关键用量。双机试验正常上报、重复、补传以及断线后接手。测试服务上线与正式服务的切换分别安排。
