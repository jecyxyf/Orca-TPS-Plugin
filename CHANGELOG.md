# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.6.5] - 2026-11-25

**Upgrading from 1.6.4:** Uninstall the old TPS Plugin in Orca, then install 1.6.5. This release changes how the plugin collects usage and connects to the leaderboard.

### Added

- Track token usage and generation speed across 16 harnesses. The plugin offers 15 interface languages and remembers the last selection.
- Review daily, hourly, and annual usage in Personal Stats. Compare models by token usage and average generation speed, and explore the yearly heatmap.
- Browse separate usage and speed leaderboards in calendar and completed-hour modes. The daily usage board shows a live usage chart, and longer periods show daily trends.

### Changed

- Tokens Managers collect usage on each device and sync it over SSH. Personal Stats and leaderboard uploads use the same device totals and count each device once.
- The leaderboard runs on the new server. Rankings, usage totals, and speed samples stay in memory, while GitHub account and sign-in state is stored separately.
- Simplified the leaderboard controls and sign-in notices. The sidebar now shows the plugin version, and both READMEs and Orca gallery images have been refreshed.

### Fixed

- Keep daily uploads moving when a conversation log is still being written, and retry leaderboard avatars after a failed load.
- Keep the sidebar and status bar in sync with active conversation changes in Orca 1.4.255 and later.

## [1.6.4] - 2026-11-19

### Fixed

- Restored live token statistics for remote workspaces in the Linux AppImage by using the bundled Orca CLI.

## [1.6.3] - 2026-11-19

### Fixed

- Personal statistics now store session totals in compressed groups to avoid exhausting Orca's storage keys. Migration can resume after a restart, and refreshes save only changed groups.

### Changed

- Corrected the name to TPS Plugin and updated the icon, README previews, and Orca directory screenshots.
- Simplified installation to using the Orca plugin directory or loading a cloned folder in Orca.

## [1.3.0] - 2026-11-07

### Changed
- **Per-Request Calculation Engine (CC Switch Parity)**: Replaced whole-turn wall-clock timing with per-API-request timing across Claude Code, Codex, OpenCode (v1 & v2), and Pi so local tool execution, shell commands, and permission approval pauses are excluded from request duration.
- **Claude Code Importer**: Merged multi-block streaming records by `message.id`, traversed `parentUuid` across `attachment` nodes to resolve accurate request start timestamps, inferred time-to-first-token (`firstTokenMs`) from `thinkingDurationMs`, and included `isSidechain` plus `<SESSION_ID>/subagents/*.jsonl` and `<SESSION_ID>/subagents/workflows/*/*.jsonl` subagent logs.
- **Codex Importer**: Implemented `RequestTimer` state machine with `token_usage_record` / model-output end boundaries, `item_completed` (`Reasoning` / `AgentMessage`) `started_at_ms` TTFT extraction, `limit_id` snapshot signature deduplication, and `normalizeCodexModel` cleanup.
- **OpenCode v1 & v2 Importer**: Counted `tokens.output + tokens.reasoning` together, prioritized `time.streamed - time.created` over `time.completed` to exclude tool execution duration, and added v2 `compaction` row support.
- **Pi Importer**: Extracted explicit `duration` or `entry.timestamp - message.timestamp` per assistant request and unpacked official `subagent` `toolResult` usage without skewing latency.
- **Strict Noise Thresholds & Formatting**: Aligned speed gates with CC Switch (`>= 200` output tokens and `>= 1000ms` duration for session-log estimated speed `≈`; `>= 100` output tokens and `>= 100ms` post-TTFT generation window for exact proxy speed), integer rounding for `TPS >= 1`, and `100%` display at `>= 99.95%` cache hit rate.

### Added
- **Read-Only CC Switch Local Proxy Integration**: Automatically upgrades matching session records (`request_id` or `±600s` semantic match) to exact post-TTFT generation speed when `~/.cc-switch/cc-switch.db` contains `2xx` `proxy` logs.
- **Panel UI Enhancements**: Added TTFT indicator (`· 首字 ≈1.8s` / `· 首字 1.2s`), `子代理` and `代理` badges, `≈` estimated duration markers, and detailed threshold reason tooltips.
- **Marketplace Metadata & CI**: Added plugin icon, 16:10 cover banner, dark/light workspace screenshots, `orca-catalog.json`, bilingual documentation, and cross-platform GitHub Actions CI.

## [1.2.0] - 2026-11-06

### Added
- Custom HTML sidebar panel (`src/panel.html`) with automatic light/dark Orca theme adaptation and compact responsive cards.
- Automatic active terminal pane tracking via read-only `profile-state.db` (`workspaceSession`) with terminal-reuse quarantine protection.
- Bottom status bar integration (`statusBar.update`) and cross-platform Linux / Windows installer scripts.
