# 每日 Token 天梯榜服务

榜单和管理后台运行在同一个 Node.js 服务。Orca 插件使用 HTTPS 提交统计，SQLite 存在服务端磁盘。

## GitHub 登录配置

在 GitHub 创建一个 OAuth 应用。正式入口使用 `https://43.157.2.14`，授权回调填 `https://43.157.2.14/auth/github/callback`。插件点击登录后在系统浏览器授权，管理员首次进网页时授权 GitHub 读邮箱，服务器核对已验证邮箱并记住账号 ID。[GitHub OAuth 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)

未登录用户和被封禁的账号都可以查看榜单。提交需要有效的 GitHub 登录，封禁后服务端会拒绝提交。

同一账号每 10 秒最多成功上传一次，每次更新当天的成绩。连续 4 次上传间隔不足 5 秒会自动封禁，间隔达到 5 秒会重新计数。10 分钟内累计 5 次错误会锁定当天的上传权限。管理员手动封禁时须填写原因，自动封禁和当天禁传的原因可在管理页查看。

在服务器配置以下环境变量。将包含应用密钥的文件设为仅所有者可读。仓库内的 `server/.env` 已忽略。

| 变量 | 值 |
| --- | --- |
| `GITHUB_CLIENT_ID` | OAuth 应用的 Client ID |
| `GITHUB_CLIENT_SECRET` | OAuth 应用的 Client Secret |
| `LEADERBOARD_ADMIN_EMAIL` | 管理员 GitHub 账号的已验证邮箱 |
| `LEADERBOARD_BASE_URL` | 正式使用 `https://43.157.2.14`。本地默认 `http://127.0.0.1:8787` |
| `LEADERBOARD_PORT` | 本机监听端口，默认 `8787` |
| `LEADERBOARD_DB` | 数据库路径，建议 `/var/lib/orca-tps/leaderboard.sqlite` |
| `LEADERBOARD_MAX_TOKENS` | 可选。设置允许提交的 Token 上限，默认使用接口支持的最大整数 |

本地使用 Node.js 24 LTS 运行 `node --env-file=server/.env server/main.mjs`，打开 `/admin` 登录。注册单独的本地 OAuth 应用时，回调改为本地服务的 `/auth/github/callback`。运行 `npm test` 可用模拟 GitHub 服务验证完整的登录、提交、排名和管理流程。

部署期间可以先启动服务。GitHub 凭据还未配置时，管理页显示待配置，`/healthz` 返回 `githubConfigured: false`。

## Ubuntu 部署

| 顺序 | 操作 |
| --- | --- |
| 1 | 将仓库部署到服务器，例如 `/opt/orca-tps`。安装 Node.js 24 LTS、Caddy 和支持 IP 地址证书的 Certbot。 |
| 2 | 建立专用系统账号，通过 systemd 启动 `node /opt/orca-tps/server/main.mjs`。配置 `EnvironmentFile=`、`User=`、`StateDirectory=orca-tps`、`Restart=on-failure`，确认该账号能读代码和写数据库。 |
| 3 | 放行公网 80 和 443。先在 Caddy 上启用下方的 HTTP 验证入口，使用 Certbot Webroot 向 Let’s Encrypt 申请 IP 证书。[IP 证书申请和续期](https://letsencrypt.org/2026/03/11/shorter-certs-certbot) |
| 4 | 把证书和私钥复制到 Caddy 服务账号可读的受限目录，然后启用 HTTPS 配置。Certbot 续期钩子负责更新两份文件并重新加载 Caddy。 |
| 5 | 从公网验证 `https://43.157.2.14/healthz`、网页登录、插件登录和自动续期。每天做 SQLite 在线备份，并试一次从备份恢复。[SQLite 备份说明](https://sqlite.org/backup.html) |

先启用 HTTP 验证入口。确保 `/var/www/letsencrypt` 存在。

```caddyfile
http://43.157.2.14 {
	handle /.well-known/acme-challenge/* {
		root * /var/www/letsencrypt
		file_server
	}
	handle {
		redir https://43.157.2.14{uri} permanent
	}
}
```

使用 Certbot 申请证书。

```sh
sudo certbot certonly --webroot --webroot-path /var/www/letsencrypt \
    --preferred-profile shortlived --ip-address 43.157.2.14
```

部署钩子可用下列命令同步证书，先保存为可执行文件，再在首次签发后运行一次。配置 Certbot 每次续期成功后调用同一个钩子。

```sh
#!/bin/sh
set -eu
lineage="${RENEWED_LINEAGE:-/etc/letsencrypt/live/43.157.2.14}"
install -d -o root -g caddy -m 0750 /etc/caddy/leaderboard-tls
install -o root -g caddy -m 0640 "$lineage/fullchain.pem" /etc/caddy/leaderboard-tls/fullchain.pem
install -o root -g caddy -m 0640 "$lineage/privkey.pem" /etc/caddy/leaderboard-tls/privkey.pem
systemctl reload caddy
```

证书到位后，在 Caddyfile 开头加上默认的 TLS 地址，再追加 HTTPS 入口。公网 IP 经过转发时，Caddy 会用这个地址为直接访问 IP 的客户端选中证书。[Caddy 默认 TLS 地址](https://caddyserver.com/docs/caddyfile/options#default-sni)

```caddyfile
{
	default_sni 43.157.2.14
}
```

```caddyfile
https://43.157.2.14 {
	tls /etc/caddy/leaderboard-tls/fullchain.pem /etc/caddy/leaderboard-tls/privkey.pem
	reverse_proxy 127.0.0.1:8787 {
		header_up X-Real-IP {remote_host}
	}
}
```
