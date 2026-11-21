# Token 天梯榜服务

榜单和管理后台运行在同一个 Node.js 服务。Orca 插件使用 HTTPS 提交统计，SQLite 存在服务端磁盘。

## GitHub 登录配置

分别为正式版和测试版创建 GitHub OAuth 应用。插件登录在系统浏览器完成。管理员首次登录网页时授权读取邮箱，服务器核对已验证邮箱并记住账号 ID。[GitHub OAuth 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)

| 环境 | 服务地址 | GitHub 回调地址 |
| --- | --- | --- |
| 正式版 | `https://itps8.com` | `https://itps8.com/auth/github/callback` |
| 测试版 | `https://test.itps8.com` | `https://test.itps8.com/auth/github/callback` |

未登录用户和被封禁的账号都可以查看榜单。提交需要有效的 GitHub 登录，封禁后服务端会拒绝提交。

同一账号每 10 秒最多成功上传一次，每次更新当天的成绩。连续 4 次上传间隔不足 5 秒会自动封禁，间隔达到 5 秒会重新计数。10 分钟内累计 5 次错误会锁定当天的上传权限。管理员手动封禁时须填写原因，自动封禁和当天禁传的原因可在管理页查看。

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

| 接口 | 用途 |
| --- | --- |
| `POST /api/leaderboard/uploads` | 登录后每 10 秒提交用量和速度。写入线程每 2 秒批量提交，提交后确认。 |
| `GET /api/leaderboard/snapshot` | 下载完整榜单。榜单线程每 10 秒读取共享截止时刻的 24 小时、7 天、30 天和速度榜。 |

先部署服务端，再更新插件。SQLite 会自动增加按来源上传所需的表。新版插件分别提交本机和 SSH 用量，服务端在同一个 GitHub 账号下只计算一次同一个 SSH 来源。远端编号保存在远端用户的数据目录中。上报电脑断线 60 秒后，其他连接同一来源的电脑可以接手。

格式 3 的上传包包含 `username`、`deviceGuid` 和 `data`，每包一个来源且最多 64 KiB。插件在本机 SQLite 中保存待确认的包，断线后沿用原编号。服务端通过 `GET /api/today/status` 公布支持的格式。测试服先验证两个客户端连接同一 SSH 来源时当天榜和滚动榜的合计。

已有混合上报记录的账号先保留当前榜单。等相关电脑补齐日志，并能核对现有用量后，服务端一次切换到按来源计数。若旧日志已丢失，相关记录移出 30 天统计范围后可以继续切换。完成切换的账号需要用新版插件上传，旧客户端仍可查询榜单。

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
