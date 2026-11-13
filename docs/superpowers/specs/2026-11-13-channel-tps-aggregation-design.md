# 按项目频道（Worktree）聚合实时 TPS 设计说明

**日期**：2026-11-13  
**分支**：`1.5.0`

## 1. 背景与问题
在 Orca IDE 同一个项目频道（Worktree）中开启多个终端对话时，原有实现按「单个焦点终端分屏（`paneKey`）→ `sleepingAgentSessionsByPaneKey`」读取会话，存在两个问题：
1. 用户在普通终端（如 `cmd.exe` / `pwsh` / `bash`）内手动运行 `codex` / `claude` / `opencode` / `pi` 时，Orca 不会将其写入 `sleepingAgentSessionsByPaneKey`，导致第二个终端完全无法识别。
2. `controller.mjs` 在收到未识别终端返回的 `"等待 Orca 记录当前对话。"` 时触发 120 秒 `holdActivityMs` 瞬态保持，导致界面一直停留在第一个终端的记录上；且切换到同频道代码编辑页签时统计会中断。

## 2. 目标
- 将实时 TPS（底部状态栏与侧栏请求明细卡片）的统计维度改为**当前激活的项目频道（`activeWorktreeId`）**。
- 聚合当前频道下的**全部会话记录**（该频道在 `sleepingAgentSessionsByPaneKey` 中登记的所有本地分屏会话 + 本机 `cwd` 匹配该频道目录的所有会话），按请求完成时间 `completedAt` 倒序展示最近 100 次 API 请求，底部状态栏展示最新 1 次请求的速度与缓存命中率。
- 同频道内切换终端分屏或代码编辑页签时保持频道统计不中断；切换到其他项目频道时立即切换数据；父仓库与子工作树目录严格隔离。
- 每张请求卡片按各自请求来源独立展示对应的 CLI Agent 名称（如 `Claude Code`、`Codex CLI`）。

## 3. 架构与数据流

### 3.1 频道识别（`src/active-conversation.mjs`）
- `selectActiveConversation(state, options)` 以 `state.activeWorktreeId` 为频道主键（校验 `activeWorkspaceExecutionHostId` 为本地且 `activeWorkspaceKey` 已同步为 `worktree:${w}`）。
- 不再要求当前焦点页签为 `terminal`。
- 提取两类频道线索返回 `target`：
  - `worktreeId`: 当前 `activeWorktreeId`
  - `worktreePath`: 从 `<repoId>::<path>` 提取的本地绝对路径（若无 `::` 后缀且同频道有效分屏共享同一绝对 `providerSession.cwd` 则采用该路径）
  - `sessions`: 遍历 `tabsByWorktree[w]` 所有本地页签及分屏叶节点，收集 `sleepingAgentSessionsByPaneKey` 中通过重开隔离（`incarnation` + `capturedAt`）与元数据校验的会话列表 `[{ provider, sessionId, transcriptPath?, dbPath? }]`
  - `title`: 安全的频道短标题（目录末两级名称，绝不暴露完整用户主目录路径）
  - `key`: 稳定绑定 `[userDataPath, profileId, worktreeId, worktreePath]`，同频道内分屏列表变化不改变频道主键

### 3.2 双路会话发现与合并（`src/data.mjs`）
- `readTargetSession(target, options)` 保留原单会话入参兼容，同时当 `target` 为频道对象（含 `worktreePath` 或 `sessions` 数组）时执行频道聚合 `readChannelSessions`：
  1. **路径归一化（`normalizeComparePath`）**：Windows 统一分隔符为 `\`、去除非盘符末尾斜杠并转小写；POSIX 统一去除非根末尾斜杠并保留大小写。确保父目录与子工作树严格区分。
  2. **显式分屏会话读取**：逐个读取 `target.sessions`（包含无 `cwd` 的 Antigravity 会话与 Claude 子代理）。
  3. **目录匹配会话读取**：
     - JSONL 提供方（`codex`、`claude`、`pi`）：使用 `headerMetaCache`（按 `size:mtimeMs` 缓存首 `16 KiB` 解析出的 `{ sessionId, cwd }`），仅对 `cwd` 归一化后等于 `worktreePath` 的文件执行正文解析。目录发现缓存缩短为 `4s`，`options.fresh === true`（手动刷新）时穿透目录发现缓存。
     - SQLite 提供方（`opencode` / `opencode2`）：按 `session` / `session_v2` 的 `directory` 字段归一化匹配当前频道目录后读取消息。
  4. **会话级去重与代理融合**：按 `${provider}:${sessionId}` 去重（镜像日志保留记录最新、最完整的一份），逐会话融合 `~/.cc-switch/cc-switch.db` 的 `2xx` 代理记录。
  5. **请求级合并**：为每条记录附加 `provider` 字段，跨会话按唯一键合并后按 `completedAt` 倒序取前 100 条。若频道目录尚无任何会话，返回空 `records: []` 而非报错警告。

### 3.3 状态控制与面板展示（`src/controller.mjs` & `src/panel.html`）
- `controller.mjs`：
  - 支持频道级 `target` 匹配；同频道内若 `target.sessions` 列表更新，原位触发即时重读而不清空已有列表。
  - 修复初始启动 `target === null` 时 `loading` 未置为 `false` 的状态滞留问题。
  - 手动调用 `refresh()` 时向 `readSession` 传递 `fresh: true`。
- `panel.html`：
  - `recordCard(record)` 优先使用 `record.provider` 渲染卡片顶部的 Agent 标签。
  - 面板副标题显示 `<频道标题> · 最近 N 次请求`。

## 4. 测试策略
- `tests/active-conversation.test.mjs`：验证同频道双终端收集、编辑器页签不中断、远程频道拒绝、分屏终端重开隔离。
- `tests/data.test.mjs`：验证同频道「已登记 Claude + 未登记普通终端 Codex + OpenCode」合并倒序、镜像去重、父子目录隔离、每条记录携带 `provider`。
- `tests/controller.test.mjs` & `tests/panel.test.mjs`：验证频道切换清空、同频道增量刷新不闪烁、初始无目标 `loading: false`，以及面板按 `record.provider` 渲染不同终端的 Agent 标签。
