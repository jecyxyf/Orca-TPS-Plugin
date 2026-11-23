# SSH 用量去重实施计划

**目标** 同一 GitHub 账号的本机用量分别累计，同一 SSH 来源只算一次。A 本机 30、B 本机 20、远端 100，两台电脑都连接时，当天榜和滚动榜都应为 150 Token。

**设计依据** [SSH 用量去重设计](../specs/2026-11-21-ssh-usage-deduplication-design.md)

**技术范围** Node.js、SQLite、Orca 插件存储和现有 SSH 采集器。远端 Node.js 最低版本为 22.13。按现有 10 秒上传间隔和 64 KiB 滚动上传上限设计。旧上传路径保留给尚未切换的账号。

在当前 `1.6.5` 工作区顺序实施。上一批已通过 171 项测试，开工时重跑 `npm test`，用当前结果作为本轮基线。

| 阶段 | 可单独验收的结果 | 主要文件 |
| --- | --- | --- |
| 1. 远端编号 | 换一台电脑或换 SSH 别名，远端仍返回相同 GUID。 | `src/remote-collector.mjs`、`src/remote-channel.mjs`、`tests/remote-channel.test.mjs` |
| 2. 用量按来源统计 | 本机和每个远端分别得出总量，临时断线时旧值保留。 | `src/usage-summary.mjs`、`src/worker.mjs`、`tests/usage-summary.test.mjs` |
| 3. 服务端去重 | 不同本机来源相加，同一远端只保存一份。换手后，晚到的旧包无法覆盖新值。 | `server/app.mjs`、`server/store.mjs`、`server/hourly-rankings.mjs`、`server/source-uploads.mjs`、`tests/leaderboard.test.mjs` |
| 4. 上报与旧库切换 | 插件按来源分批续传，旧混合记录对账后一次替换。 | `src/leaderboard.mjs`、`src/usage-upload.mjs`、`server/source-uploads.mjs`、`tests/leaderboard.test.mjs` |
| 5. 联调 | 两个桌面客户端通过测试服验收。 | `docs/known-issues.md`、`server/README.md`、中英文 README |

## 约定好数据字段

- 本机 GUID 沿用 `leaderboard:installation-id`，在上传时用作 `reporterId`。远端 GUID 由远端用户目录里的文件提供，在请求中用作 `sourceId`。两种编号均使用现有 UUID 校验。
- `sourceKind` 为 `local` 或 `ssh`。`local` 来源的 `sourceId` 必须等于 `reporterId`。账号归属由服务端从登录会话取得。
- `readUsageSources(reporterId)` 返回各来源的 `sourceId`、`sourceKind`、北京时间日用量 `daily: [{day, tokens}]`、滚动值 `buckets: [[completedAt, tokens]]`、已完整扫描的时间段 `coverage: [from, to]` 及本次远端成功采集时间 `observedAt`。滚动时间用 UTC 毫秒，范围包含起点、截止点归入下一段。未扫完时省略 `coverage`。
- `POST /api/leaderboard/uploads` 用 `format: 2` 识别新版请求。请求带 `reporterId`、`requestId` 和 `operations`。操作类型为 `lease`、`update`、`baseline-part`、`baseline-commit`、`migration-status` 和 `migration-commit`。响应为逐项 `results`，每项带 `code`。涉及来源的操作同时返回 `sourceId`，需要重试的操作返回可用于续传的版本或批次编号。
- 远端写入资格按「账号 + 来源」管理。服务器时间决定 60 秒到期，`leaseEpoch` 每次接手递增。同一资格内，`revision` 用于顺序更新。`requestId` 加正文指纹用于识别原样重试。当天用量和滚动用量仍复用现有表，批次准备和切换进度单独保存。

| 操作 | 请求字段与结果 |
| --- | --- |
| `lease` | 提交 `sourceId`、`observedAt`。成功返回 `leaseEpoch`、`expiresAt`。客户端仅在新一轮 SSH 采集成功后续期。 |
| `update` | 提交 `sourceId`、`sourceKind`、`revision`、变动的 `daily` 或 `buckets`，远端还须带 `leaseEpoch`。`coverage` 仅在对应范围数据已发齐时带上。成功返回已确认的 `revision`。 |
| `baseline-part` | 提交 `sourceId`、`sourceKind`、`snapshotId`、`partIndex`、`partCount`、`purpose`、`daily` 和 `buckets`。`purpose` 为 `handover` 或 `migration`，换手批次带 `leaseEpoch`。暂存确认返回 `snapshotId` 和 `partIndex`。 |
| `baseline-commit` | 提交 `sourceId`、`snapshotId`、`leaseEpoch`、完整的 `coverage`。服务端确认所有批次到齐后一次替换。 |
| `migration-status` | 返回该账号的切换状态、需核对的旧设备及范围、旧记录版本和已经暂存的批次。 |
| `migration-commit` | 提交用于核对的 `legacyVersions` 和每个来源的 `snapshotId`。若版本变化或任一范围的原用量无法核对，保留旧榜并返回尚需补齐的范围。 |

## 1. 给远端生成并读回 GUID

- [ ] 扩展 `tests/remote-channel.test.mjs`。在同一个临时远端用户目录同时建立两条连接，再从不同 SSH 别名读取，断言三个结果为同一个有效 GUID。另测两个用户目录得到不同编号，编号文件失效或打不开时保留此前的来源记录。
- [ ] 运行 `node --test tests/remote-channel.test.mjs`，确认新测试指出当前采集器没有返回远端 GUID。
- [ ] 在 `src/remote-collector.mjs` 的用量扫描首包中返回 `sourceId`。数据目录优先取 `XDG_DATA_HOME`，默认取 `~/.local/share`。先在同目录写好权限为 `0600` 的临时文件，再以独占方式发布为 `orca-tps-plugin/source-id`，由并发输家读回已存在的编号。编号异常时把这个来源标为无法完整读取。
- [ ] 在 `src/remote-channel.mjs` 校验首包 GUID、分页间一致性和重新打开连接后的 GUID。按真实 GUID 建立来源缓存，同一个 GUID 只返回一组描述。连接参数继续用作连接查找。
- [ ] 重跑远端测试。检查原有 SSH 当前数据、个人统计、断开再重连场景。

## 2. 在现有索引里保留来源

- [ ] 扩展 `tests/usage-summary.test.mjs`。同一远端的两个入口合计 100，本机独立合计 30，个人统计为 130。远端失联时，旧 100 仍可显示，新上报缺少完整覆盖。恢复后可更新已确认的时间段。
- [ ] 运行 `node --test tests/usage-summary.test.mjs`，复现当前只能从索引取到整体汇总的问题。
- [ ] `src/usage-summary.mjs` 在已有每份日志统计上保留来源，并生成 `leaderboardSources(reporterId)`。保留本机设备与远端 `sourceId` 的区别。旧地址缓存等同一来源首次完整扫描后再换成 GUID 缓存，同一来源的旧新缓存只计一份。
- [ ] `src/worker.mjs` 将 `readUsageSources(reporterId)` 接入 `startLeaderboard`，用现有扫描和补读预算。读取失败时，能够确认的其他来源仍可更新。发送零值前须先有该来源的完整覆盖。
- [ ] 重跑个人统计和远端测试，核对断线保护、今日和远端合计、跨北京时间零点、滚动区间边界。

## 3. 服务端按来源写入并保护交接

- [ ] 先在 `tests/leaderboard.test.mjs` 测试两个本机 GUID 与一个共用远端 GUID。按同一账号上报 30、20、100，三张滚动榜和当天榜均为 150。不同 GitHub 账号的数据分别计数。再覆盖无效 GUID、冒用其他本机编号、重复请求和大小超限。
- [ ] 运行 `node --test tests/leaderboard.test.mjs`，确认新版请求目前会被旧接口拒绝。
- [ ] 在 `server/app.mjs` 按格式校验请求，送入现有批量写入线程。`server/source-uploads.mjs` 负责写入资格、暂存批次和去重状态。`server/store.mjs` 与 `server/hourly-rankings.mjs` 复用现有主键来保存按来源的用量，使用 `reporterId` 保留对上报次数的检查。每个批次返回本机和各远端的实际结果。
- [ ] 增加固定时间的交接测试。让 A 获得资格，B 可以上传自己的本机量。推进 60 秒后让 B 取得新资格。随后送达 A 的旧包，断言已保存的远端值保持不变。同一批重发后，保存结果一致。过期的覆盖和旧的版本也不能推回已确认的时间点。
- [ ] 处理 `lease`、`update`、`baseline-part` 与 `baseline-commit`。全新来源可以先提交已读取的用量，完整扫描后再声明覆盖。换手时保留原有数据，接手方用 `snapshotId` 和批次号分次准备完整覆盖，全部到齐才在一次事务内替换。过期资格提交的暂存块不能进入榜单。
- [ ] 重跑榜单测试，验证服务器重启后仍记得有效资格、确认结果和暂存批次。检查封禁、当天禁传和已清分日期在新版写入时仍生效。

## 4. 插件分批续传并切换旧记录

- [ ] 扩展 `tests/leaderboard.test.mjs`。模拟半批成功、响应丢失、续传、切换 GitHub 账号和服务器、接手后收到上一台电脑的迟到数据。核对不同来源各自的结果，失败部分用原编号续传，成功时间只在所需数据都确认后更新。
- [ ] `src/leaderboard.mjs` 生成新版请求并使用逐来源结果。`src/usage-upload.mjs` 按服务器、账号、来源和写入资格管理回执与待发批次。实际发送前按 JSON 字节数拆包，租约过期时回到换手准备。服务端缺少新版能力时用已有格式提交。已切换账号的失败重试继续发新版请求。
- [ ] 写旧记录迁移测试。旧设备 A 和 B 各自含 100 远端量时，旧合计 250。准备期间看见 250，完整切换后看见 150。日志缺失、最新旧版本发生变化、进程重启或管理端清分都要检验重新核对及续传。
- [ ] 使用 `migration-status` 返回每个账号还需覆盖的旧设备和时间范围。`baseline-part` 将来源数据写入暂存。迁移批次按编号重试，重启后从服务器已确认的位置恢复。对每个旧设备逐日、逐时间点核对，确认新数据仍可解释这些旧用量。共用远端选择一份已经完整核对的快照。检查通过后，让 `migration-commit` 以同一事务替换旧记录并启用按来源计数。若准备期间出现更新的旧值，继续使用旧汇总，补齐后重试。已移出统计范围的旧值按旧规则过期。
- [ ] 对已切换账号的旧格式写入返回 `upgrade_required`。旧版读取接口仍可查询。测试空库直接使用新版，以及已有数据的账号切换前继续使用旧版。
- [ ] 重跑 `node --test tests/leaderboard.test.mjs`。核对源数据切换、按日期汇总、滚动榜和上传部分失败提示。

## 5. 最终验收与发布顺序

| 检查 | 验收 |
| --- | --- |
| 自动化 | `npm test`、`git diff --check`、`orca plugin validate . --json` 全部通过。 |
| 测试服 | 两个客户端用同一 GitHub 账号，连接相同远端账号。核对同一 GUID、150 Token 合计和 60 秒交接后的结果。 |
| 旧记录 | 用测试数据库副本验证 250 → 150，核对完整切换、断线保留、进程重启及旧版查询。 |
| 用户说明 | 验收后在问题清单标为已修复。用 `plugin-publish` 核对中英文 README 和 Orca 目录资料，并在部署说明写清服务端与插件的更新顺序。 |

先部署支持两种上报格式的服务端，再让新版插件按来源上报。正式服的上线安排单独确认。
