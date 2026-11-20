# TPS Plugin

**English** · **[简体中文](./README.zh-CN.md)** · **[Orca plugin directory](https://api.onorca.dev/plugins/jecyxyf/orca-tps-plugin)**

[![Orca 1.4.251+](https://img.shields.io/badge/Orca-%3E%3D1.4.251-blue.svg)](https://github.com/stablyai/orca)
[![CI](https://github.com/jecyxyf/Orca-TPS-Plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/jecyxyf/Orca-TPS-Plugin/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

## 1. Project description

TPS Plugin brings token usage and generation speed to the Orca sidebar. See what the current session is doing, review your usage over time, or join the leaderboard with a GitHub account.

The plugin supports local and SSH workspaces and remembers your choice of 10 interface languages. Conversation logs are read in place. The leaderboard receives usage totals.

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
- See the model, output in KB, generation speed in tokens per second, request duration, time to first token (TTFT) when available, and cache hit rate.
- Check the latest speed and cache hit rate in the Orca status bar. Estimated speeds are marked with ≈.

<p align="center">
  <a href="./assets/readme/en/current-data.png" title="View full-size screenshot">
    <img src="./assets/readme/en/current-data.webp" width="267" alt="English Current Data tab showing request cards for Codex, Claude, Hermes, OpenCode, and Pi">
  </a>
</p>

### 3.2 Personal Stats

- Review usage and request counts for today, the last 7 days, or the last 30 days.
- Break down usage by tool and model, and compare average model generation speeds. Usage in MB includes new input, output, cache reads, and cache writes.
- Use the annual heatmap to see daily activity over the past year.
- Usage history is cached locally and restored when Orca restarts.

<p align="center">
  <a href="./assets/readme/en/personal-stats.png" title="View full-size screenshot">
    <img src="./assets/readme/en/personal-stats.webp" width="250" alt="English Personal Stats tab showing totals, model usage, average speed, and the annual heatmap">
  </a>
</p>

### 3.3 Leaderboard

- Browse today’s, 7-day, and 30-day rankings. Entries show GitHub avatars, and the top three get gold, silver, and bronze medals.
- The top 100 entries show submitted usage points for the last five minutes on Today and one point per Beijing calendar day on the 7-day and 30-day tabs. Entries also show the latest average generation speed, most-used model and CLI, and last upload time. The leaderboard refreshes every 10 seconds while open.
- Sign in with GitHub to participate. The leaderboard combines usage across installations linked to the same account. The plugin fetches avatars directly from GitHub and shows a built-in red hat avatar until one loads. Missing avatars are retried after the next sync, and a loaded avatar is reused everywhere it appears.
- While signed in, the plugin attempts to sync every 10 seconds. Manual sync shares the same interval. The account card shows the countdown, the last successful sync, and any recent error.

<p align="center">
  <a href="./assets/readme/en/leaderboard.png" title="View full-size screenshot">
    <img src="./assets/readme/en/leaderboard.webp" width="266" alt="English 7-day leaderboard showing ranks, daily usage curves, models, CLIs, and average speeds">
  </a>
</p>

## 4. Supported Harnesses

- Codex CLI
- Claude Code (including subagents)
- OpenCode v1 and v2
- Pi Agent
- Antigravity CLI
- Hermes Agent

## 5. Installation

Use **Orca 1.4.251 or later** on Windows or Linux. To collect usage from an SSH workspace, the remote host needs **Node.js 22.13 or later with SQLite support**.

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
