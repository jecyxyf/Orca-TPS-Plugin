# 榜单 Kafka 传输实施计划

**目标** Kafka 设 4 个分区，4 个常驻线程各自取包并批量写 SQLite，另有 1 个线程整点算榜。取包随消息到达持续进行，写库成功后才确认消费进度。

**依据** [已确认的设计](../specs/2026-11-21-leaderboard-kafka-transport-design.md)（`7c581b1`）。先在本机用独立 Kafka 和临时 SQLite 验证，再用测试服数据库副本对账。首次接入使用服务端配置开关，原写入模式仍为默认。

| 阶段 | 涉及文件 | 验收结果 |
| --- | --- | --- |
| 1. 收包入队 | `server/main.mjs`、`server/app.mjs`、新增 `server/kafka-transport.mjs`、`server/package.json` 及锁文件 | 每次上传完整入队，同一账号和来源稳定路由到一个分区。 |
| 2. 四个线程取包写库 | 新增 `server/kafka-consumer.mjs`、`server/leaderboard-jobs.mjs`、`server/leaderboard-thread.mjs`，必要时调整 `server/store.mjs` | 在四个常驻线程各自取包写库，写完才确认进度。失败重试，重复包不会多算。 |
| 3. 整点算榜 | `server/kafka-transport.mjs`、`server/kafka-consumer.mjs`、`server/leaderboard-jobs.mjs`、`server/leaderboard-thread.mjs` | 四个分区都已写入截止前的数据，再由单个线程生成四张榜。 |
| 4. 验证和回退 | `tests/leaderboard.test.mjs`、新增 `tests/leaderboard-kafka.test.mjs`、`server/README.md` | 隔离环境验证真实 Kafka、重启、共用 SSH、整点和切回原模式。 |

## 1. 收包入队

- [ ] 在独立的本机 Kafka 上先验证 KafkaJS 连接、写入、消费组和进度提交。锁定通过验证的 KafkaJS 和 Kafka 版本。用测试专用主题和消费组，显式创建并核对 4 个分区、3 天保留期，关闭自动建主题。直接复用现有 Node.js 和 Java 工具启动本机验证环境。[Apache Kafka 快速入门](https://kafka.apache.org/quickstart/) · [KafkaJS 版本](https://kafka.js.org/versions)
- [ ] 在 `server/main.mjs` 根据 `LEADERBOARD_KAFKA_BROKERS` 选择写入模式。Kafka 模式填写 `LEADERBOARD_KAFKA_TOPIC` 和 `LEADERBOARD_KAFKA_GROUP_ID`。测试服配置使用专用值。Kafka 未接通时，上传按现有 `unavailable` 响应重试，读取服务继续提供有效结果。进程重启沿用相同消费组和 SQLite。
- [ ] 在 `server/app.mjs` 上传入口沿用现有校验。将服务器已验证的账号 ID 与来源 GUID 交给入队选分区。旧格式的一次请求含多个条目时，作为一个包发送。单来源旧包用来源或设备编号，混合来源旧包按账号固定路由。消息包含内部请求关联编号、原上传编号、收件时间和现有写入所需的条目。保留写库时的账号与权限复查，消息只带现有会话摘要。
- [ ] 收到 Kafka 已保存确认后等待 SQLite 写入结果。将等待时间设在插件现有 10 秒网络超时内。写库成功后按原顺序回送条目结果。超时返回可重试结果并清理等待项，已经入队的包继续处理。用受控的并发和等待队列限制进程内积压。

## 2. 四个常驻线程各自取包写库

- [ ] Kafka 模式启动 4 个 Node 工作线程。每个线程连同一个消费组并打开自己的 SQLite 连接，使用 `eachBatch` 连续取包，按分区顺序处理。每批最多 64 包或 1 MiB，合法大包完整处理。通过 `uploadBatch` 在事务里写入，将结果按原请求拆开。通知主线程更新读取缓存。[KafkaJS 批量消费和手动提交](https://kafka.js.org/docs/consuming)
- [ ] 禁用自动提交和自动确认整批。写库提交成功后，明确提交该分区已完成的最后一个位置加一。正常业务拒绝随当前批确认。数据库忙或事务错误时，保留未确认进度并重试，按需等待并继续发心跳。处理过程发现分区已被重新分配时停止旧批次。进程退出时停止收包、结束当前批次并断开连接。
- [ ] 模拟同一账号的不同来源分到两个分区，较早收到的包较晚写入。核对账号上传时钟和限流时钟不会被倒拨，也不会因为排队顺序触发快速上传封禁。用现有事务处理账号和来源状态，确保重复消费、共用 SSH、迟到旧包和重扫继续按现有规则执行。
- [ ] 加入本机故障测试。分别在 SQLite 提交前、提交后确认前终止线程。恢复后查 Kafka 进度、SQLite 小计和速度样本，确认没有跳包和重复计数。模拟暂时持有 SQLite 写锁，验证锁释放后能继续写。

## 3. 用一个线程整点算榜

- [ ] 在 `server/kafka-transport.mjs` 给入队请求和整点标记排好顺序。整点前的发送结果确定后，为四个分区分别写入同一轮标记。标记带截止时间和本轮编号。四条标记写好后再发整点及以后收到的包。一次发送结果不明确时，当前轮转入恢复，继续提供上一份有效榜单。
- [ ] 消费线程到达标记后先提交之前的数据，然后等主线程放行。主线程按分区收集到达情况，重复标记只算一次。等待时维持消费组心跳，并允许同一线程推进它暂时接管的其他分区。重新分配时，未确认的标记可由接手线程继续处理。
- [ ] 四个分区都到达后复用 `createPublishedSnapshot`。算榜线程第一次 SQLite 查询固定读取内容，主线程随即放行各分区。由算榜线程保存四榜结果，复用 `publishHourlyResult` 的管理版本检查。等待或计算失败时放行写入、保留最近有效结果，恢复后对最近整点补算。封禁或清分仍按现有规则让受影响的结果失效。
- [ ] 启动后为需要补算的最近整点建立一轮新标记。上一进程遗留的标记作为已中断的轮次处理，同一分区继续按顺序消费其上传包。补算轮在四个分区重新汇合，避免进程在部分分区确认标记后退出造成一直等待。测试部分标记发送失败、部分分区确认后重启、等待期间重新分配，以及固定快照后尚未发布时退出。

## 4. 对账和回退

- [ ] 默认模式跑 `node --test tests/leaderboard.test.mjs`、`npm test` 与 `git diff --check`。Kafka 模式用独立主题、消费组、临时 SQLite 和模拟 GitHub 服务跑 `node --test tests/leaderboard-kafka.test.mjs`。验证新旧上传格式的响应、分区分工、空闲分区也能到达整点、连续跨两个整点、四张榜共用截止时间。
- [ ] 用测试服数据库副本和同一批上传分别运行两种模式。核对同一整点的 24 小时、7 天、30 天用量榜和每人一条的速度榜，并验证两台电脑共用 SSH、补传和断线接手。记录吞吐量、Kafka 积压、SQLite 锁等待、进程内存和写库用时。
- [ ] 更新 `server/README.md` 的测试服配置、依赖安装和回退顺序。回退演练先停止接受新的上传，再等待四个分区消费进度追上末尾，保留 SQLite 和 Kafka 数据，最后切回原模式。对账和故障测试通过后，可用相同配置安排测试服上线。
