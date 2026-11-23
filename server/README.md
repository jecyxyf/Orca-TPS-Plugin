# Token 天梯榜服务

榜单和管理后台运行在同一个 Node.js 服务。Tokens 管家通过 HTTPS 提交汇总，服务把新榜单的数据放在内存里。GitHub 账号、登录和旧版榜单使用服务端 SQLite。

## GitHub 登录配置

分别为正式版和测试版创建 GitHub OAuth 应用。插件登录在系统浏览器完成。管理员首次登录网页时授权读取邮箱，服务器核对已验证邮箱并记住账号 ID。[GitHub OAuth 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)

| 环境 | 服务地址 | GitHub 回调地址 |
| --- | --- | --- |
| 正式版 | `https://itps8.com` | `https://itps8.com/auth/github/callback` |
| 测试版 | `https://test.itps8.com` | `https://test.itps8.com/auth/github/callback` |

未登录用户和被封禁的账号都可以查看榜单。提交需要有效的 GitHub 登录，封禁后服务端会拒绝提交。

旧版写入接口按账号限制上传速度。管理员手动封禁时须填写原因，旧版自动封禁和当天禁传的原因可在管理页查看。

在服务器配置以下环境变量。将包含应用密钥的文件设为仅所有者可读。仓库内的 `server/.env` 已忽略。

| 变量 | 值 |
| --- | --- |
| `GITHUB_CLIENT_ID` | OAuth 应用的 Client ID |
| `GITHUB_CLIENT_SECRET` | OAuth 应用的 Client Secret |
| `LEADERBOARD_ADMIN_EMAIL` | 管理员 GitHub 账号的已验证邮箱 |
| `LEADERBOARD_BASE_URL` | 使用上表的服务地址。默认 `http://127.0.0.1:8787` |
| `LEADERBOARD_HOST` | 监听地址，默认 `127.0.0.1`。Compose 在容器内设为 `0.0.0.0` |
| `LEADERBOARD_PORT` | 监听端口，默认 `8787` |
| `LEADERBOARD_DB` | SQLite 路径。Compose 使用 `/data/leaderboard.sqlite` |
| `LEADERBOARD_MAX_TOKENS` | 可选。设置允许提交的 Token 上限，默认使用接口支持的最大整数 |
| `LEADERBOARD_TRUSTED_PROXY_IPS` | 可选。额外信任的转发 IP，多个地址用逗号分隔。默认信任 `127.0.0.1` 和 `::1`。 |

本地使用 Node.js 24 LTS 运行 `node --env-file=server/.env server/main.mjs`，打开 `/admin` 登录。注册单独的本地 OAuth 应用时，回调改为本地服务的 `/auth/github/callback`。运行 `npm test` 可用模拟 GitHub 服务验证完整的登录、提交、排名和管理流程。

部署期间可以先启动服务。GitHub 凭据还未配置时，管理页显示待配置，`/healthz` 返回 `githubConfigured: false`。

## 用量榜和速度榜

| 管家接口 | 用途 |
| --- | --- |
| `GET /api/tokens-manager/config` | 公开读取扫描、个人统计、上传、榜单发布和读取间隔 |
| `GET /api/tokens-manager/account` | 用 GitHub 登录凭证获取绑定的账号 ID |
| `POST /api/tokens-manager/packets` | 上传一台来源设备的小时、每日用量和速度样本 |
| `GET /api/tokens-manager/snapshot` | 公开读取同一版本的 24 小时、7 天、30 天和速度榜 |

服务按 GitHub 账号和设备 GUID 取最近 10 秒内收到的最新原始统计包。同一设备的代报只算一次。榜单在内存计算和发布，服务重启后由管家重新上报。

五个间隔默认 5000 毫秒。可分别设置 `LEADERBOARD_TOKENS_SCAN_MS`、`LEADERBOARD_TOKENS_PERSONAL_MS`、`LEADERBOARD_TOKENS_UPLOAD_MS`、`LEADERBOARD_TOKENS_PUBLISH_MS` 和 `LEADERBOARD_TOKENS_READ_MS`。上报间隔支持 1000–7500 毫秒。

### 旧版客户端

| 接口 | 用途 |
| --- | --- |
| `POST /api/leaderboard/uploads` | 登录后每 10 秒提交用量和速度。默认每 2 秒批量写入。Kafka 模式持续取包写入。SQLite 提交成功后才确认。 |
| `GET /api/leaderboard/snapshot` | 下载完整榜单。每个整点生成共享截止时间的 24 小时、7 天、30 天和速度榜，并保存最新和上一份结果。 |

先部署服务端，再更新插件。SQLite 会自动增加按来源上传所需的表。新版插件分别提交本机和 SSH 用量，服务端在同一个 GitHub 账号下只计算一次同一个 SSH 来源。远端编号保存在远端用户的数据目录中。上报电脑断线 60 秒后，其他连接同一来源的电脑可以接手。

小时格式的上传包包含 `username`、`deviceGuid` 和 `data`，每包一个来源且最多 64 KiB。`data.format` 为 4，每个有变化的小时带 Token 小计、更新时间和覆盖终点。写入线程一次读取当批相关来源和小时的数据，合并后每个小时只写一行。插件在本机 SQLite 中保存待确认的包，断线后沿用原编号和内容。服务端通过 `GET /api/today/status` 的 `hourlySourceUploads` 公布可切换到小时格式的账号。

已有混合上报记录的账号先用旧数据出榜。相关电脑用格式 3 补齐来源并核对用量后，服务端在首次小时格式上传时把已有时间点汇总为小时。若旧日志已丢失，相关记录移出 30 天统计范围后可以继续切换。完成切换的账号使用小时格式上传，旧客户端仍可查询榜单。上线前在测试服副本按同一整点核对四张榜，用两个客户端验证 SSH 断线接手。保留切换前的数据库备份和服务版本供回退。

## 正式版（Docker Compose）

将代码部署到 `/opt/orca-tps/prod`。在 `/etc/orca-tps/prod.env` 配置正式版的 GitHub 登录和 `LEADERBOARD_BASE_URL=https://itps8.com`，文件权限设为 `0600`。

```sh
sudo LEADERBOARD_ENV_FILE=/etc/orca-tps/prod.env docker compose \
  -p orca-tps-prod -f /opt/orca-tps/prod/server/compose.yml up -d --build --wait
```

SQLite 保存在 Compose 的 `leaderboard-data` 数据卷。更新容器时沿用同一个 Compose 项目名和数据卷。定期在线备份 SQLite，并验证备份可以恢复。[SQLite 备份说明](https://sqlite.org/backup.html)

公网放行 80 和 443，在主机上配置 Caddy，转发到 Compose 绑定的本机端口。Caddy 自动申请和续期域名证书。[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)

```caddyfile
itps8.com {
	reverse_proxy 127.0.0.1:8787 {
		header_up X-Real-IP {remote_host}
	}
}
```

如果容器看到的转发来源是 Docker 网桥地址，将这个地址填入 `/etc/orca-tps/prod.env` 的 `LEADERBOARD_TRUSTED_PROXY_IPS`。可用下面的命令查看默认网络的网关，再核对它是否就是容器看到的来源。填入单个 IP 地址即可，Compose 端口继续绑定在 `127.0.0.1`。

```sh
sudo docker network inspect orca-tps-prod_default --format '{{range .IPAM.Config}}{{println .Gateway}}{{end}}'
```

服务端会使用可信转发提供的 `X-Real-IP` 计算每位访客的接口额度。改动环境变量后，重新运行上面的 Compose 部署命令。如果重建了 Docker 网桥，核对网关地址并更新配置。

## 测试版（Node.js 和 systemd）

将测试代码部署到 `/opt/orca-tps/test`，由 `orca-tps-test.service` 运行。服务使用专用系统账号 `orca-tps-test` 和主机上的 Node.js 24。

```ini
[Unit]
Description=Orca TPS leaderboard (test)
After=network.target

[Service]
User=orca-tps-test
Group=orca-tps-test
WorkingDirectory=/opt/orca-tps/test
EnvironmentFile=/etc/orca-tps/test.env
ExecStart=/opt/nodejs/leaderboard/bin/node /opt/orca-tps/test/server/main.mjs
StateDirectory=orca-tps-test
StateDirectoryMode=0700
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

在 `/etc/orca-tps/test.env` 配置测试版 GitHub 登录及以下参数，文件权限设为 `0600`。

```dotenv
LEADERBOARD_BASE_URL=https://test.itps8.com
LEADERBOARD_PORT=8788
LEADERBOARD_DB=/var/lib/orca-tps-test/leaderboard.sqlite
```

将 `test.itps8.com` 的 A 记录指向硅谷服务器。在主机上的 Caddy 配置中加入测试站点，共用公网 80 和 443。

```caddyfile
test.itps8.com {
	reverse_proxy 127.0.0.1:8788 {
		header_up X-Real-IP {remote_host}
	}
}
```

访问 `https://test.itps8.com/admin` 测试网页登录，或给开发版 Orca 设置 `ORCA_TPS_LEADERBOARD_URL=https://test.itps8.com`。

部署后分别请求两个环境的 `/healthz`，确认响应正常且 `githubConfigured` 为 `true`。再各验证一次登录、提交、榜单查询和重启后的数据读取。

### 测试版 Kafka 写入模式

为测试服准备独立的 Kafka。测试服从同一主机的私有端口连接 Kafka。回归验证使用 Kafka 4.2.2 与 KafkaJS 2.2.4。安装服务端依赖 `npm ci --prefix server --omit=dev`，再创建四分区主题。[Apache Kafka 快速入门](https://kafka.apache.org/42/getting-started/quickstart/)

```sh
bin/kafka-topics.sh --bootstrap-server 127.0.0.1:9092 --create \
  --topic orca-tps-test-uploads --partitions 4 --replication-factor 1 \
  --config retention.ms=259200000
```

在测试服环境文件加上三项，再重启测试服务。一个榜单服务进程负责发送整点标记，并启动同一个消费组的四个线程。重启时沿用主题、消费组和 SQLite 路径。

```dotenv
LEADERBOARD_KAFKA_BROKERS=127.0.0.1:9092
LEADERBOARD_KAFKA_TOPIC=orca-tps-test-uploads
LEADERBOARD_KAFKA_GROUP_ID=orca-tps-test-writers
```

Kafka 接通前，上传会收到可重试的响应，已有榜单可以继续读取。取到数据的线程直接写 SQLite。整点时，等四个分区都写完截止前的数据，再由一个线程生成四张榜。

用独立 Kafka 验证时，设置 `ORCA_TPS_KAFKA_TEST_BROKERS` 后运行 `node --test tests/leaderboard-kafka.test.mjs`。测试会建立独立主题、消费组及临时 SQLite。请为该实例预留测试主题空间。

回退时先在测试入口暂停新上传，保持榜单服务运行。用 `kafka-consumer-groups.sh --bootstrap-server 127.0.0.1:9092 --describe --group orca-tps-test-writers` 核对四个分区的消费积压都为零。然后移除上面三项配置，沿用当前 SQLite 重启测试服务，再恢复上传。保留 Kafka 中的数据和消费组进度。
