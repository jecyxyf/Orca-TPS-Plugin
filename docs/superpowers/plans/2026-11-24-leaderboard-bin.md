# 天梯榜单文件存储实施计划

依据[已确认的设计](../specs/2026-11-24-leaderboard-bin-design.md)。在当前分支按下列顺序实现和验证，验收环境为 `test.itps8.com`。

## 1. 实现状态文件和迁移命令

- [x] 在 `server/store.mjs` 用一个 `leaderboard.bin` 保存 JSON 的 UTF-8 字节。格式版本为 `1`，包含账号、管理员、封禁、有效会话摘要和最近 25 条账号管理操作。读取时校验格式、账号引用和到期时间。
- [x] 登录、退出和封禁由主进程顺序写入。需要同时更新账号和登录凭证时，在同一次保存中完成。先写同目录的临时文件并刷盘，再替换正式文件。成功后更新内存。损坏文件使服务报错退出。
- [x] 新增 `server/migrate-leaderboard-state.mjs`，从 `accounts`、`administrator`、`ban_reasons`、`sessions` 和 `audit` 只读导入。校验写入结果并报告数量。发现目标文件已存在时停止，保留目标内容。服务入口与迁移命令各自启动。
- [x] 用临时目录测试重启读回、过期会话、文件损坏、替换失败和重复迁移。迁移测试使用临时 SQLite 样本。

## 2. 切换当前服务入口

- [x] 更新 `server/main.mjs`、`server/app.mjs` 和 `server/admin-page.mjs`。接入新的状态文件，保留 1.6.5 用到的登录、退出、配置、账号绑定、上传和四榜快照。管理页保留账号搜索、封禁、解封和管理记录。
- [x] 在 `src/tokens-manager-calendar.mjs` 放置共享的日期、小时和保留期计算。让 `src/tokens-manager-stats.mjs` 和算榜线程直接使用它，保留管家数据库模块原有的导出供本机和 SSH 统计使用。
- [x] 移除旧版榜单的路由、存储和工作线程，清理 `server/leaderboard-jobs.mjs`、`server/leaderboard-thread.mjs`、`server/leaderboard-data.mjs`、`server/hourly-rankings.mjs`、`server/source-uploads.mjs`、`server/ranking-snapshot.mjs`、`server/kafka-transport.mjs` 和 `server/kafka-consumer.mjs`，以及 Kafka 依赖。
- [x] 调整 `tests/leaderboard.test.mjs` 和 `tests/tokens-manager.test.mjs` 中依赖旧服务的用例，清理 `tests/leaderboard-kafka.test.mjs`。保留当前插件的登录、网络重试、排行开关、头像和个人统计测试。用模拟 GitHub 验证登录、退出、管理员和封禁，再验证新版已登录上传与未登录查榜。

## 3. 验证并更新部署资料

- [x] 运行 `npm test` 和 `git diff --check`。使用临时状态文件执行 `node --no-experimental-sqlite server/main.mjs`，确认服务可以启动、回应健康检查并发布四榜快照。
- [x] 更新 `server/README.md` 和 `server/compose.yml`。记录状态文件路径、一次性迁移方法和测试服切换步骤。按项目交付要求，用 `plugin-publish` 检查中英文 README 和 Orca 插件介绍。

## 4. 切换测试服并清理旧库

| 顺序 | 操作和检查 |
| --- | --- |
| 上线前 | 把通过本地测试的服务端文件上传到测试服暂存目录，核对包和现有服务路径。继续使用 `orca-tps-test.service` 和 `test.itps8.com` 的 GitHub 回调。 |
| 迁移 | 停止测试服务，以服务账号从 `/var/lib/orca-tps-test/leaderboard.sqlite` 迁移到同目录的 `leaderboard.bin`。核对账号和会话数量、管理员和封禁状态及文件权限。 |
| 验证 | 设置 `LEADERBOARD_STATE_FILE` 并启动新版。核对健康检查、GitHub 授权入口、身份校验和四榜刷新。再重启一次，核对状态文件仍可读，结合新版上传测试验证榜单恢复。切换失败时用旧程序和原库恢复测试服务。 |
| 清理 | 验证通过后删除测试服原库及仍存在的 `-wal`、`-shm` 文件。再重启并检查服务、状态文件和公开榜单。 |
