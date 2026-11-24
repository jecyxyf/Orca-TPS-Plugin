# TPS Plugin

**[English](./README.md)** · **简体中文** · **[Orca 插件目录](https://api.onorca.dev/plugins/jecyxyf/orca-tps-plugin)**

[![Orca 1.4.251+](https://img.shields.io/badge/Orca-%3E%3D1.4.251-blue.svg)](https://github.com/stablyai/orca)
[![CI](https://github.com/jecyxyf/Orca-TPS-Plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/jecyxyf/Orca-TPS-Plugin/actions/workflows/ci.yml)
[![MIT 许可](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

## 1. 项目描述

TPS Plugin 是一款 Orca 插件，让你在侧栏查看 Token 用量和生成速度。你可以查看当前会话的请求、回顾个人用量，也可以用 GitHub 账号参加天梯榜。

插件支持本地和 SSH 工作区，可切换 15 种界面语言，并记住上次选择。会话日志在原处读取，天梯榜接收的是用量汇总。

## 2. 界面预览

在 Orca 右侧栏打开 **TPS Plugin**，即可切换**当前数据**、**个人统计**和**天梯榜**。

<p align="center">
  <a href="./assets/readme/zh-CN/overview.png" title="查看原图">
    <img src="./assets/readme/zh-CN/overview.webp" width="640" alt="TPS Plugin 总览图，展示三个中文分页">
  </a>
</p>

*截图使用示例数据。*

## 3. 功能描述

### 3.1 当前数据

- 跟随当前 Orca 频道，最多显示最近 100 次请求。
- 查看模型、输出量（Tokens）、生成速度（tokens/s）、请求耗时和缓存命中率。有记录时也会显示首字延迟。
- Orca 底部状态栏显示最新速度和缓存命中率。估算速度带有 ≈ 标记。

<p align="center">
  <a href="./assets/readme/zh-CN/current-data.png" title="查看原图">
    <img src="./assets/readme/zh-CN/current-data.webp" width="272" alt="中文当前数据页，展示 Codex、Claude、Hermes、OpenCode 和 Pi 的请求卡片">
  </a>
</p>

### 3.2 个人统计

- 查看今日、近 7 天、近 30 天、今年或过去 365 天的用量与请求数。今日还会显示单次请求的最大生成速度。
- 按工具和模型查看用量，比较各模型的平均生成速度。用量以百万 Token（M）计，包含新输入、输出和缓存读写。
- Tokens 管家用现有日志补算最近 370 天。最近 32 天保存逐条请求，最近 370 天保存每日和每小时的汇总。热力图显示过去 365 天。
- 个人统计无需登录，自动合并本机和 SSH 主机的用量。管家通过 SSH 互传统计，两台电脑连到同一台远端主机时，可以读到对方上次同步的统计。在 Orca 的 TPS Plugin 设置中可修改统计时区。

<p align="center">
  <a href="./assets/readme/zh-CN/personal-stats.png" title="查看原图">
    <img src="./assets/readme/zh-CN/personal-stats.webp" width="250" alt="中文个人统计页，展示用量汇总、模型用量、模型均速和用量热力图">
  </a>
</p>

### 3.3 天梯榜

- 用量排名以 M 显示。按天数更新以北京时间自然日统计今日、近 7 天和近 30 天。按小时更新统计已结束的近 24、168 和 720 个完整小时。七张榜默认每 3 秒一起刷新。前三名分别有金、银、铜奖牌。
- 天梯排名旁的开关控制榜单的显示和拉取，并记住上次选择。关闭时收起榜单和个人名次。未登录也可以查看榜单。
- 最短周期的用量榜显示最近 5 分钟的用量波形和平均速度，缺失或异常的用量、速度按 0 显示。较长周期的曲线按天显示用量。用量榜都显示最常用模型、Harness 和上次上传时间。
- 算速度榜时，取每个 GitHub 账号近 24 小时内最高的 10 秒平均生成速度，再排前 100 名。同一账号在多台设备上传也只占一个名次。前三名分别获得标有 `S` 的金、银、铜奖牌。这 10 秒内新增用量超过 500 Token 且速度有效才参与排名。榜上时间、最常用模型、Harness 和完整的新增 Token 数均来自胜出的时段，例如 `1,250,000 tokens`。
- 曲线从零线的绿色连续过渡到最高点的红色。曲线与零线之间使用同样的渐变，透明度为 50%。
- 通过 GitHub 登录后参加排名。同一账号合计最近上报的最多 4 台设备，同一设备被多个管家代报也只算一次。漏报时沿用上次成绩，直到新上报更新成绩或掉出榜单。头像由插件向 GitHub 获取。
- 登录后管家默认每 3 秒上传。开启天梯排名后，插件自动下载榜单。传输时图标转圈，失败时显示小红色感叹号，旁边显示上次成功时间。

<p align="center">
  <a href="./assets/readme/zh-CN/leaderboard.png" title="查看原图">
    <img src="./assets/readme/zh-CN/leaderboard.webp" width="266" alt="中文天梯榜，展示近 30 天用量曲线和速度榜页签">
  </a>
</p>

## 4. 支持的 Harness

**个人统计和天梯榜**在 Windows 和 Linux 上都读取 16 种 Harness 的本地记录，包括 Claude Code、Claude Desktop、Codex、Gemini CLI、Grok Build、OpenCode、OpenClaw、Hermes Agent、Pi、MiniMax Code、Kimi Code、Oh My Pi、Antigravity CLI、GitHub Copilot CLI、WorkBuddy 和 DeepSeek Harness。Claude Desktop 读取 Cowork 的本地审计日志和用量流水。DeepSeek Harness 支持普通和 Zstd 压缩会话日志。

**Orca 会话采集**支持以下工具。

- Codex CLI
- Claude Code（含子代理）
- OpenCode v1 和 v2
- Pi Agent
- Antigravity CLI
- Hermes Agent

## 5. 安装指南

Windows 和 Linux 需使用 **Orca 1.4.251 或更新版本**。采集 SSH 工作区的用量时，远程主机需要安装**支持 SQLite 的 Node.js 22.13 或更新版本**。

Orca 从各连接主机的 `~/.orca/tpsplugin/bin/token_manager.mjs` 启动 Tokens 管家。`bin` 目录有六个程序文件，SQLite 数据库是 `~/.orca/tpsplugin/database/tpslugin.db`，安装指纹保存在 `~/.orca/tpsplugin/`。

### Orca 插件目录

打开 **Orca → 设置 → 插件**，搜索 **TPS**，找到 **jecyxyf** 发布的条目。点击**安装**并确认权限，Orca 会自动下载。[查看插件条目](https://api.onorca.dev/plugins/jecyxyf/orca-tps-plugin)

### 本地安装

克隆这个仓库到本地。

```sh
git clone https://github.com/jecyxyf/Orca-TPS-Plugin.git
```

在 **Orca → 设置 → 插件 → 开发目录（Development folders…）** 中，添加包含 `orca-plugin.json` 的克隆目录。确认权限后启用插件，使用期间保留这个目录。

安装后，在 Orca 右侧栏打开 **TPS Plugin**。

[MIT 许可](./LICENSE) · [第三方许可声明](./THIRD_PARTY_NOTICES.md) · [天梯榜服务端指南](./server/README.md)
