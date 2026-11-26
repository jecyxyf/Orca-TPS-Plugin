# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.6.7] - 2026-11-27

### Added

- Added a live **Theme** customization dialog with custom background image upload and pan/zoom editor, independent font and icon colors, translucent frosted-glass card color and opacity, star map twinkle controls, and randomized Harness icon motion intervals.
- Added Korean (`ko`) and Traditional Chinese (`zh-TW`) interface languages with country flags, bringing total supported locales to 17.
- Added aurora border sweep and rainbow stardust burst animations on incoming request cards, randomized idle Harness icon animations, spinning refresh indicators, and header links to star the GitHub repository.
- Added count-up animations, row flash highlights, and `+Δ` delta badges on Personal Stats updates, plus drop-in entrance, twinkling, and hover ripple animations on the 365-day **Activity star map**.
- Added 7 League-style royal tier badges, animated royal character poses (rocket, sports car, running, panting, flatline), and tier-colored live ECG heartbeat waves on the 1-day Leaderboard, plus animated 7-day curves and 30-day dot-matrix equalizers.

### Changed

- Redesigned **Current Data** cards with larger 36px Harness icons, compact metric rows, and unified card styling across all panels.
- Compacted **Personal Stats** into a By Day / By Hour icon capsule, `1 day / 7 days / 30 days / 365 days` tabs, iconized summary metrics, and a unified **Model data** card with a segmented share bar and Usage / Speed sort toggle.
- Combined the Leaderboard account header and `1 / 7 / 30 day` rank summary into one card, aligned Speed board rows, and capped heartbeat BPM at 200 across the five pose tiers (`0`, `1–50`, `51–100`, `101–150`, `151–200`).
- Refreshed both READMEs with single-row animated GIF previews, Theme Customization documentation, and `.gitattributes` `export-ignore` to keep release archives compact.

### Fixed

- Preserved active device 5-minute heartbeat samples on the leaderboard server when another idle device of the same account uploads, deduplicating relayed sample IDs.
- Backfilled Codex record IDs when `session_meta` arrives in a later chunk, removed the old-generation heap cap on the background Tokens Manager process, and unobserved removed ranking rows in the panel.

## [1.6.6] - 2026-11-25

### Changed

- Reduced the unpacked plugin to about 1.85 MiB by removing old previews, using one compact JPEG per README image, and shrinking the plugin icons.
- Kept the store cover and screenshots at Orca’s required dimensions.

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
- Simplified usage and leaderboard processing and removed an unused Windows executable from the plugin package.
- Unified Tokens Manager messages and heartbeats with support for older managers, and simplified notification translation, SQLite access, and leaderboard routing.

### Fixed

- Keep daily uploads moving when a conversation log is still being written, and retry leaderboard avatars after a failed load.
- Keep the sidebar and status bar in sync with active conversation changes in Orca 1.4.255 and later.
- Restore 7-day and 30-day leaderboard charts from the local cache and clear expired sessions when an HTTP 401 response has no JSON body.
- Use one timeout for leaderboard avatar lookups and downloads, and let MiniMax Code and OpenClaw database reads wait briefly for SQLite locks.

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
