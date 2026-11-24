# Token 天梯榜服务

榜单和管理后台运行在同一个 Node.js 服务。Tokens 管家通过 HTTPS 提交汇总，实时榜单保存在内存。GitHub 账号、登录和管理状态保存在 `leaderboard.bin`。该文件用 UTF-8 字节保存一个 JSON 对象。

## GitHub 登录配置

分别为正式版和测试版创建 GitHub OAuth 应用。插件登录在系统浏览器完成。管理员首次登录网页时授权读取邮箱，服务器核对已验证邮箱并记住账号 ID。[GitHub OAuth 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)

| 环境 | 服务地址 | GitHub 回调地址 |
| --- | --- | --- |
| 正式版 | `https://itps8.com` | `https://itps8.com/auth/github/callback` |
| 测试版 | `https://test.itps8.com` | `https://test.itps8.com/auth/github/callback` |

未登录用户和被封禁的账号都可以查看榜单。提交需要有效的 GitHub 登录，封禁后服务端会拒绝提交。

管理员封禁账号时须填写原因。管理页支持查询账号、封禁、解封以及查看最近 25 条账号管理操作。

在服务器配置以下环境变量。将包含应用密钥的文件设为仅所有者可读。仓库内的 `server/.env` 已忽略。

| 变量 | 值 |
| --- | --- |
| `GITHUB_CLIENT_ID` | OAuth 应用的 Client ID |
| `GITHUB_CLIENT_SECRET` | OAuth 应用的 Client Secret |
| `LEADERBOARD_ADMIN_EMAIL` | 管理员 GitHub 账号的已验证邮箱 |
| `LEADERBOARD_BASE_URL` | 使用上表的服务地址。默认 `http://127.0.0.1:8787` |
| `LEADERBOARD_HOST` | 监听地址，默认 `127.0.0.1`。Compose 在容器内设为 `0.0.0.0` |
| `LEADERBOARD_PORT` | 监听端口，默认 `8787` |
| `LEADERBOARD_STATE_FILE` | 状态文件路径。默认 `server/.data/leaderboard.bin`。Compose 使用 `/data/leaderboard.bin`。 |
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

两个接收线程并行校验上报。每个线程从首包计时，满 1 秒或攒到 32 个包就批量写入同一块共享内存，写入后回执。算榜线程每 5 秒切换缓冲区，在放开写锁后用已写入的包计算四张榜。同一设备的代报只算一次。本轮没有写入的设备退出本轮，下一轮写入后重新参与。服务重启后由管家重新上报。

榜单发布间隔固定为 5000 毫秒。扫描、个人统计、上报和读取间隔默认也是 5000 毫秒，可分别通过 `LEADERBOARD_TOKENS_SCAN_MS`、`LEADERBOARD_TOKENS_PERSONAL_MS`、`LEADERBOARD_TOKENS_UPLOAD_MS` 和 `LEADERBOARD_TOKENS_READ_MS` 设置。上报间隔支持 1000–7500 毫秒。

## 从 SQLite 迁移

从旧服务升级时先停止旧服务，在新版代码目录用服务账号运行一次迁移。下面用测试服的路径举例。Docker 部署在挂载的数据目录中使用 `/data/leaderboard.sqlite` 和 `/data/leaderboard.bin`。

```sh
node server/migrate-leaderboard-state.mjs \
  --from /var/lib/orca-tps-test/leaderboard.sqlite \
  --to /var/lib/orca-tps-test/leaderboard.bin
```

迁移会保留账号、管理员、封禁、有效会话和最近的账号管理操作。已有目标文件时迁移会报错并保留其内容。设置 `LEADERBOARD_STATE_FILE` 后启动新版，检查登录、上报、榜单和重启。验证成功后清理旧库及其 SQLite 临时文件。

## 正式版（Docker Compose）

将代码部署到 `/opt/orca-tps/prod`。在 `/etc/orca-tps/prod.env` 配置正式版的 GitHub 登录和 `LEADERBOARD_BASE_URL=https://itps8.com`，文件权限设为 `0600`。

```sh
sudo LEADERBOARD_ENV_FILE=/etc/orca-tps/prod.env docker compose \
  -p orca-tps-prod -f /opt/orca-tps/prod/server/compose.yml up -d --build --wait
```

`leaderboard.bin` 保存在 Compose 的 `leaderboard-data` 数据卷。更新容器时沿用同一个 Compose 项目名和数据卷。

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
LEADERBOARD_STATE_FILE=/var/lib/orca-tps-test/leaderboard.bin
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
