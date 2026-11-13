# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development & Verification Commands

This project is a zero-dependency Node.js ESM (`>= 22.13`) plugin for Orca IDE (`>= 1.4.251`), relying on built-in `node:sqlite` and `node:test`. There is no build or transpile step.

```sh
# Run all unit and SQLite integration tests
npm test

# Run a single test file
node --test tests/parsers.test.mjs

# Run a single test by name pattern
node --test --test-name-pattern="Antigravity" tests/antigravity.test.mjs

# Validate plugin manifest, catalog, and test suite via Orca CLI
orca plugin validate .
orca plugin validate orca-catalog.json
orca plugin inspect .
orca plugin test .
```

### Installer & Release Checks (enforced in `.github/workflows/ci.yml`)
- `orca-plugin.json` and `package.json` **must have identical `version` strings** (CI fails on mismatch); `orca-catalog.json` and `VALIDATION.json` also track release metadata.
- Linux installer syntax check: `sh -n install-linux.sh`
- Windows installer syntax check (PowerShell):
  ```powershell
  $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile("$PWD\install-windows.ps1", [ref]$null, [ref]$errors); if ($errors.Count -gt 0) { throw ($errors | Out-String) }
  ```
- Local dev load/unload in a running Orca instance: `sh install-linux.sh` or `./install-windows.ps1` (unload with `orca plugin dev unload <dir>`).

## High-Level Architecture

`src/worker.mjs` activates as an Orca `trusted-worker` plugin (`storage:own` capability) and runs two independent pipelines that feed `src/panel.html` and the bottom status bar:

### 1. Live Active Channel Pipeline (Status Bar + Per-Request Cards)
Aggregates all conversations belonging to the project channel (`activeWorktreeId`) currently active in Orca—staying active across split terminals, manual shell-launched CLIs, and code editor tabs within the same channel while never leaking across channels or parent/child worktrees:
1. **Channel Resolution (`src/active-conversation.mjs`)**: Opens Orca's `profiles/<profileId>/profile-state.db` read-only inside a single transaction. Checks `workspaceStamp` (`revision` / `legacy_revision`) first so 250ms polling skips JSON parsing when workspace state hasn't changed. Supports Orca `1.4.255+` split storage (`profile_state_document_parts` when `meta.legacy_revision === legacy.revision`) with fallback to monolithic `profile_state_documents`. Resolves `activeWorktreeId` → local `worktreePath` plus all validated local terminal pane sessions in `sleepingAgentSessionsByPaneKey` for `tabsByWorktree[w]` (retaining PTY incarnation quarantine on reopened panes).
2. **State & Fencing (`src/controller.mjs`)**: Polls focus every `250ms` (`focusPollMs`) and throttles transcript reads to `5000ms` (`pollMs`), refreshing in-place immediately when a channel's registered pane list changes. Uses monotonic `generation` counters to discard stale async reads on channel switch, holds the last active channel for `120s` (`holdActivityMs`) across transient unidentified-page states, serializes `statusBar.update` host calls, and broadcasts `tps.changed` snapshots.
3. **Bounded Channel Read (`src/data.mjs` → `readTargetSession`)**: Combines explicit channel pane sessions with local sessions whose normalized `cwd` (`normalizeComparePath`) matches `worktreePath` (using a `size:mtimeMs` JSONL header cache up to `256 KiB` for large Codex `session_meta` lines, plus OpenCode SQLite `directory` filtering). Reads at most the trailing `16 MiB` (+ `256 KiB` header) per JSONL file or `10,000` projected SQLite message rows. Deduplicates mirrored transcripts per `${provider}:${sessionId}`, merges Claude `<SESSION_ID>/subagents/*.jsonl` and `subagents/workflows/*/*.jsonl`, upgrades matching records against `~/.cc-switch/cc-switch.db` (`2xx` `proxy` rows), tags each record with `provider`, and sorts the channel's latest `100` requests newest-first.

### 2. Background Usage Index Pipeline (365-Day Heatmap, Window Totals & Model Speed Ranking)
Aggregates historical usage across all local sessions without blocking live polling:
1. **Discovery (`src/data-paths.mjs`, `src/data.mjs` → `discoverUsageUnits`)**: Scans default CLI directories plus Orca-managed multi-account homes (`codex-runtime-home`, `codex-accounts/*`, `claude-profiles/*`) for units modified within `365` days (`HISTORY_DAYS`). Deduplicates mirrored append-only transcripts (e.g., Codex logs copied into Orca's managed home) by **largest file size** (tie-breaking on `mtimeMs`). Large Codex rollouts stream in `4 MiB` chunks through incremental `createCodexParser(..., { limit: Infinity })` rather than loading into memory.
2. **Incremental Persistence (`src/usage-summary.mjs` → `createUsageIndex`)**: Stores per-unit daily summaries under `orca.storage` (`usage:unit:<sha256>`, `USAGE_SCHEMA = 2`) as `days[YYYY-MM-DD][provider][model]` 8-number arrays: `[requests, freshInput, output, cacheRead, cacheWrite, speedSamples, speedSum, estimatedSamples]`. Re-reads only changed stamps (`15s` timer while backfilling, `60s` when idle), defers growing files `> 64 MiB` to at most once every `10 minutes`, and applies exponential backoff on read errors while retaining prior counts. Note: `cc-switch.db` proxy speeds are intentionally **not** merged into this index—model speed rankings (`SPEED_MIN_SAMPLES = 5`) use local session logs only.
3. **Panel Rendering (`src/panel.html`)**: Vanilla HTML/CSS/JS communicating over `window.orca.plugin` (`tps.state`, `tps.refresh`, `tps.summary`, `tps.changed`) and `window.orca.on('theme')`. Uses `[instanceId, generation]` fencing to ignore out-of-order responses or retired worker instances across plugin reloads.

## CC Switch Parity & Safety Invariants

- **Per-Request Timing (`src/parsers.mjs`)**: Always measure individual API request windows so tool execution and approval waits are excluded:
  - *Claude Code*: Group streaming blocks by `message.id`; walk `parentUuid` (up to 32 hops, skipping `attachment`) for request start; infer TTFT from `thinkingDurationMs` on block `0`.
  - *Codex CLI*: Stateful boundary tracker (`turn_context`, non-assistant message, `*_output`, prior `token_count`) to `token_usage_record` or pre-tool model output; deduplicate `token_count` snapshots via `limit_id` signatures; `cacheInclusive: true`.
  - *OpenCode (`v1` & `v2`)*: Prefer `time.streamed - time.created` over `time.completed`; output tokens = `tokens.output + tokens.reasoning`.
  - *Pi Agent*: Explicit `duration` or `entry.timestamp - message.timestamp`; unpack `subagent` `toolResult` usage with `durationMs: null`.
  - *Antigravity CLI*: Token counts (`cacheInclusive: false`) from `brain/<id>/.system_generated/logs/transcript.jsonl` (ignoring rotated copies) paired with exact `createdMs`, `firstTokenMs`, `streamMs`, and model metadata decoded via the built-in zero-dependency protobuf wire reader (`protoFields`) from `conversations/<id>.db` (`step_type = 15` and `gen_metadata`).
- **Speed Gates & Token Formulas**:
  - *Exact proxy speed* (`dataSource === 'proxy'`): requires `outputTokens >= 100` and `durationMs - firstTokenMs >= 100ms`; `TPS = outputTokens / ((durationMs - firstTokenMs) / 1000)` (no `≈`).
  - *Session-log speed* (`dataSource !== 'proxy'`): requires `outputTokens >= 200` and `1000ms <= durationMs <= 3_600_000ms`; `TPS = outputTokens / (durationMs / 1000)` (prefixed with `≈`).
  - *Real tokens* = `freshInput + output + cacheWrite + cacheRead`. *Cache hit rate* = `cacheRead / (freshInput + cacheWrite + cacheRead)` (`>= 99.95%` formats as `100%`).
- **Read-Only & Privacy Boundary**: Every `DatabaseSync` connection must open with `{ readOnly: true, enableExtensionLoading: false }` and execute `PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;`. SQLite queries on OpenCode project only timing/token JSON fields (`projectedData()`). Prompt/response text and local filesystem paths (`transcriptPath`, `dbPath`, `cwd`) must never be persisted to `orca.storage` or exposed in controller state / panel payloads.
