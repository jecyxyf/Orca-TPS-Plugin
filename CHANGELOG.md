# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed
- **Leaderboard sync no longer waits for every file**: Today's usage now uploads whatever has been read so far, and later syncs replace it as more files are read. Heavy users with a large session file that was still being written (over 64 MB) previously got "usage not ready" on almost every sync. The one-time history upload for past days still waits for complete data, because the server keeps the first total it receives for each past day.
- **Leaderboard avatars recover after a failed download**: An avatar that is still the default icon is fetched again when its leaderboard row changes after a sync, and the account avatar is retried too. A loaded avatar updates every place the same user appears and is not downloaded again. Failed downloads now wait 10 seconds (one sync interval) instead of 5 minutes.
- **Orca 1.4.255+ Active Conversation Tracking**: Adapted to Orca's split state storage (`profile_state_document_parts` and `profile_state_document_parts_meta`), resolving an issue where the sidebar and status bar stayed frozen on an older session after switching channels/tabs. Falls back seamlessly to monolithic `profile_state_documents` on earlier Orca versions.

### Changed
- The default leaderboard avatar is a black hat with a white band and a thin gray outline.
- **Sub-Second Active Tab Polling (250ms)**: Lowered focus poll interval from 1000ms to 250ms with a lightweight revision stamp check (`workspaceStamp`), avoiding full-tree re-parsing when the workspace state is unchanged, reducing channel switch latency to 0.7~1.5s.

### Added
- **Antigravity CLI support** (`antigravity` agent): token counts and cache hit rate come from the live `brain/<conversation-id>/.system_generated/logs/transcript.jsonl` (rotated copies are ignored). `input_tokens` is treated as excluding cache reads.
- Antigravity model, TTFT, and request latency come from its native store `conversations/<conversation-id>.db`, read-only and limited to step and generation metadata. Model priority: generation display name, then the latest `Model Selection` change, then the family name. Without the native store only tokens and cache are shown.
- **Usage totals panel and yearly heatmap**: 当日战况, 近一周战况 and 近一月战况 at the top of the panel, showing total tokens (new input, output, cache writes and cache reads, matching CC Switch's real total), cache hit rate and request counts, with a per-agent and per-model breakdown. A GitHub-style heatmap of the last year shows daily totals on hover. Totals come from an incremental background index of local session files (Codex, Claude Code including subagents, Pi, OpenCode sessions, and Antigravity conversations). Each file is read once and re-read only when it changes (large, still-growing files at most every 10 minutes); Codex rollouts stream through the incremental parser; identical Codex rollouts copied into Orca's managed home are counted once.
- **Model average speed ranking** (模型均速): inside the 用量统计 group, models are ranked by their mean per-request output speed (tokens/s) over the selected 当日 / 近一周 / 近一月 window, fastest first. Agents are merged per model; a model needs at least 5 requests in the window to be ranked, and models whose samples are mostly log estimates are marked `≈`. Speeds come from the same local session logs as the totals, so CC Switch proxy speeds are not included. Index units written by earlier versions are re-read once to fill in the speed counters.

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
