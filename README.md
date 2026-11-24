# TPS Plugin

**English** · **[简体中文](./README.zh-CN.md)** · **[Orca plugin directory](https://api.onorca.dev/plugins/jecyxyf/orca-tps-plugin)**

[![Orca 1.4.251+](https://img.shields.io/badge/Orca-%3E%3D1.4.251-blue.svg)](https://github.com/stablyai/orca)
[![CI](https://github.com/jecyxyf/Orca-TPS-Plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/jecyxyf/Orca-TPS-Plugin/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

## 1. Project description

TPS Plugin brings token usage and generation speed to the Orca sidebar. See what the current session is doing, review your usage over time, or join the leaderboard with a GitHub account.

The plugin supports local and SSH workspaces and remembers your choice of 15 interface languages. Conversation logs are read in place. The leaderboard receives usage totals.

## 2. Interface overview

Open **TPS Plugin** in Orca’s right sidebar to switch between **Current Data**, **Personal Stats**, and **Leaderboard**.

<p align="center">
  <a href="./assets/readme/en/overview.png" title="View full-size screenshot">
    <img src="./assets/readme/en/overview.webp" width="640" alt="TPS Plugin overview with all three tabs in English">
  </a>
</p>

*The screenshots use sample data.*

## 3. Features

### 3.1 Current Data

- Follow the active Orca channel and view up to 100 recent requests.
- See the model, output in Tokens, generation speed in tokens per second, request duration, time to first token (TTFT) when available, and cache hit rate.
- Check the latest speed and cache hit rate in the Orca status bar. Estimated speeds are marked with ≈.

<p align="center">
  <a href="./assets/readme/en/current-data.png" title="View full-size screenshot">
    <img src="./assets/readme/en/current-data.webp" width="267" alt="English Current Data tab showing request cards for Codex, Claude, Hermes, OpenCode, and Pi">
  </a>
</p>

### 3.2 Personal Stats

- Review usage and requests for today, the last 7 or 30 days, this calendar year, or the past 365 days. Today's summary also shows the highest generation speed for a single request.
- Break down usage by tool and model, and compare average model generation speeds. Usage is shown in millions of tokens (M) and includes new input, output, cache reads, and cache writes.
- The Tokens Manager fills in up to 370 days from the available logs, keeping 32 days of request details and 370 days of daily and hourly totals. The heatmap covers 365 days.
- Personal Stats combines local and SSH hosts without signing in. It keeps the last statistics for an offline host. Set the statistics time zone in the TPS Plugin settings in Orca.

<p align="center">
  <a href="./assets/readme/en/personal-stats.png" title="View full-size screenshot">
    <img src="./assets/readme/en/personal-stats.webp" width="250" alt="English Personal Stats tab showing totals, model usage, average speed, and a usage heatmap">
  </a>
</p>

### 3.3 Leaderboard

- Browse usage rankings for the last 24 hours, 7 days, and 30 days in M. The service refreshes all four boards together every five seconds by default. Usage counts completed hours. The top three get gold, silver, and bronze medals.
- Use the switch next to Rankings to control leaderboard viewing. Turning it off hides the rankings and stops fetching them. The plugin remembers your choice. Guests can view rankings.
- The 24-hour usage tab shows the latest five minutes of usage and average generation speed. The 7-day and 30-day tabs show daily usage. All three show the most-used model, Harness, and latest upload time.
- The Speed tab ranks up to 20 GitHub accounts by their best average generation speed from a qualifying upload in the past 24 hours. Each account appears once across all its devices. An upload qualifies with more than 500 new tokens and a valid speed. The winning upload supplies the time, most-used model, Harness, and full count of new tokens, such as `1,250,000 tokens`.
- Each curve uses a continuous gradient from green at zero to red at the highest point. The fill uses the same gradient at 50% opacity.
- Sign in with GitHub to participate. Each five-second round counts the latest report received for each device once per account, including reports relayed by other managers. A device that misses a round can contribute again as soon as its next report arrives. Avatars load from GitHub.
- While signed in, the Tokens Manager uploads every five seconds by default. The toolbar shows the last successful sync and lets you request another upload.

<p align="center">
  <a href="./assets/readme/en/leaderboard.png" title="View full-size screenshot">
    <img src="./assets/readme/en/leaderboard.webp" width="266" alt="English leaderboard with a 30-day usage curve, the cutoff time, and the Speed tab">
  </a>
</p>

## 4. Supported Harnesses

**Personal Stats and leaderboard usage** read local records from 16 harnesses on both Windows and Linux: Claude Code, Claude Desktop, Codex, Gemini CLI, Grok Build, OpenCode, OpenClaw, Hermes Agent, Pi, MiniMax Code, Kimi Code, Oh My Pi, Antigravity CLI, GitHub Copilot CLI, WorkBuddy, and DeepSeek Harness. Claude Desktop usage comes from Cowork's local audit logs and usage ledger. DeepSeek Harness can use either plain or Zstd-compressed session logs.

**Orca session collection** supports these harnesses:

- Codex CLI
- Claude Code (including subagents)
- OpenCode v1 and v2
- Pi Agent
- Antigravity CLI
- Hermes Agent

## 5. Installation

Use **Orca 1.4.251 or later** on Windows or Linux. To collect usage from an SSH workspace, the remote host needs **Node.js 22.13 or later with SQLite support**.

Orca starts the Tokens Manager from `~/.orca/tpsplugin/bin/token_manager.mjs` on each connected host. The `bin` directory contains six program files. The SQLite database is at `~/.orca/tpsplugin/database/tpslugin.db`, and the installation fingerprint is in `~/.orca/tpsplugin/`.

### Orca plugin directory

Open **Settings → Plugins**, search for **TPS**, and select the entry by **jecyxyf**. Click **Install** and review the requested permissions. Orca downloads the plugin for you. [View the plugin listing](https://api.onorca.dev/plugins/jecyxyf/orca-tps-plugin)

### Local installation

Clone this repository.

```sh
git clone https://github.com/jecyxyf/Orca-TPS-Plugin.git
```

In Orca, open **Settings → Plugins → Development folders…** and add the cloned folder containing `orca-plugin.json`. Review the permissions and enable the plugin. Keep the cloned folder in place while using it.

After installation, open **TPS Plugin** in Orca’s right sidebar.

[MIT License](./LICENSE) · [Third-party notices](./THIRD_PARTY_NOTICES.md) · [Leaderboard server guide](./server/README.md)
