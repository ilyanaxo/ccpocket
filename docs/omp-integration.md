# omp provider integration design

Status: implemented on branch `feat/omp-provider`, commits `58ba8db2`…`00a076cd` after this design (`795ada07`). Where the code differs from the design, §15 "Implementation deviations" records what it does and why, and the affected sections point there. Design revision 2 after four independent reviews (bridge, app, omp, wire); every review finding is recorded in §14 "Review log". Target: omp (oh-my-pi) v18.3.2 as the third ccpocket provider `"omp"`, next to `"claude"` and `"codex"`.

Conventions used in this document:

- **OBSERVED** marks a fact measured against the real `~/.local/bin/omp` v18.3.2. `P<n>` = lead probes (`/tmp/omp-design/probes.md`), `V<n>` = omp-review probes (`/tmp/omp-design/probe-v0<n>`), `WC1` = wire-review probe (`/tmp/omp-design/probe-wc-01`).
- **SOURCE** marks a fact read from the omp v18.3.2 source (`/tmp/omp-src/packages/...`), cited as `file:line`. **DOCUMENTED** marks a fact from omp's own `docs/` without a probe.
- Repo citations are `path:line` against branch `feat/omp-provider` (HEAD `177aac14`). Bridge paths without a directory are relative to `packages/bridge/src/`; app paths without a directory are relative to `apps/mobile/lib/`.
- Decisions `D1`…`D21` are the lead's; deviations are listed in §13.1 with evidence. Deviations of the implementation from this design are listed in §15.
- Research reports `bridge-process.md`, `bridge-periphery.md`, `app-core.md`, `app-features.md`, `omp-rpc.md`, `omp-acp.md` live under `/tmp/omp-map/`; they are inputs only, and every fact this design relies on is restated here with its source.

## Contents

1. Summary and feature matrix
2. omp process lifecycle
3. Event mapping
4. Approvals, ask, dialogs
5. Input, queue, steer, interrupt, images
6. Sessions: listing, history, names, archive, resume, rewind
7. Models, thinking and approval mode at runtime
8. Periphery
9. Wire protocol changes and compatibility
10. App architecture
11. Test plan
12. Work breakdown
13. Deviations and open risks
14. Review log
15. Implementation deviations

## 1. Summary and feature matrix

### 1.1 Summary

ccpocket gets a third provider, `"omp"`. The Bridge drives one `omp --mode rpc-ui` child per Bridge session over stdio, speaking omp RPC protocol v2 (omp `docs/rpc.md`). A new `OmpProcess` plays the role `CodexProcess` plays for Codex: it owns the child, translates omp frames into the existing `ServerMessage` union (`parser.ts:567`), and exposes the duck-typed members `SessionManager` and `websocket.ts` already call (`approve`, `reject`, `answer`, `interrupt`, `sendInput`, `isWaitingForInput`, `getPendingPermission`, …; research `bridge-process.md` §1.4).

What omp does not report over RPC (recent sessions, resume history, names of stopped sessions, model catalogue) comes from omp's own files and one-shot CLI calls: session JSONL files, `omp models --json`, and `omp -p` for titles and commit messages.

Key decisions:

- **Transport** (D1, §2): `omp --mode rpc-ui` with explicit `--cwd`, `--allow-home`, `--approval-mode`, and a Bridge-owned `--config` overlay that sets `ask.timeout: 0` (OBSERVED P2f).
- **Run state** (§2.5): the Bridge goes idle when every prompt it sent has its `prompt_result` and no agent run is live. `session_settled` only marks "no background work left"; it is not the idle trigger, because omp withholds it while any async job runs (SOURCE `modes/rpc/rpc-session-settle.ts:18-27`, OBSERVED V7).
- **Tool names** (§3.3): omp tools map to the names the app renders (`Bash`, `Read`, `Write`, `Edit`, `FileChange`, `Grep`, `Glob`, `WebSearch`, `TodoWrite`, `AskUserQuestion`, `Task`); the rest keep their omp name.
- **Approvals** (D3 revised, §4): correlation uses the tool calls of the preceding assistant `message_end`, binds only on positive evidence, and always shows omp's own approval text.
- **Interrupt** (§5.4): cancel every pending dialog before `abort` (OBSERVED P4a/P4b: `abort` hangs otherwise).
- **Sessions** (D7/D8, §6): recent list and history from disk; one writer per session file, enforced by a Bridge-wide registry (§6.7).
- **Runtime changes** (D2/D12, §7): model and thinking level in place through the new client message `set_omp_model`; approval mode by respawn with `--resume` inside the same Bridge session.
- **Gating** (D16, §9): the Bridge advertises `provider_omp_v1`; the app declares `supportedProviders` in `client_capabilities`. Each side hides omp from a peer that does not declare it.
- **App** (D17, §10): `Provider.omp`, a dedicated `features/omp_session/` screen and cubit subclass, capability getters on `ChatSessionCubit` where omp shares a behaviour.

### 1.2 Feature matrix

"unsupported" rows name the reason; the app hides the control for omp.

| Capability | Claude | Codex | omp (mechanism) |
|---|---|---|---|
| Start session in project / worktree | Agent SDK `query()` | `codex app-server` `thread/start` | spawn `omp --mode rpc-ui --cwd <effectiveCwd>` (§2.1); worktree via the shared `createWorktree` path in `SessionManager.create` (`session.ts:352-385`) |
| Additional directories | `additionalDirectories` | `writable_roots` | `--add-dir <dir>` per root. OBSERVED P8: extends only the workspace roots in the system prompt, no write grant. OBSERVED V4: recorded in the header (`additionalDirectories`) and restored on resume without the flag |
| Model at start | `model` | `model` | `--model <provider>/<id>`, exact selector from the model cache only (§7.1) |
| Thinking level at start | `effort` | `modelReasoningEffort` | `--thinking <level>`, validated against the model's levels (§7.1); new wire field `thinkingLevel` |
| Model / thinking change in a running session | restart only | `set_codex_model` | new client message `set_omp_model` → RPC `set_model` + `set_thinking_level` (OBSERVED P7), applied at idle |
| Permission modes | `default/auto/acceptEdits/bypassPermissions/plan` | policy + sandbox + reviewer | `executionMode` `default→always-ask`, `acceptEdits→write`, `fullAccess→yolo` (D2). omp `write` also auto-approves MCP tools, which declare the write tier (DOCUMENTED `docs/approval-mode.md`); the app labels it accordingly (§10.4). `plan`/`auto` are not offered |
| Change permission mode at runtime | SDK `setPermissionMode` | in place when idle, else restart | respawn with `--resume <sessionFile> --approval-mode <new>` inside the same Bridge session, when idle and settled (§7.3) |
| Plan mode | `permissionMode: plan` | `collaborationMode: plan` | unsupported: RPC has no plan command or plan approval dialog (`/plan` is TUI-only, SOURCE `slash-commands/builtin-modes.ts:240-315`) |
| Sandbox toggle | `sandboxEnabled` | sandbox mode | unsupported: omp has no process sandbox |
| Codex profile, speed tier, web search, network access | – | yes | unsupported (Codex concepts) |
| Claude advanced options (max turns, budget, fallback model, fork on resume, persist) | yes | – | unsupported (Claude SDK options) |
| Streaming text | `stream_delta` | `stream_delta` | `message_update.assistantMessageEvent.text_delta` → `stream_delta` (D5) |
| Thinking display | `thinking_delta` + blocks | reasoning deltas | `thinking_delta` → `thinking_delta`; `message_end` thinking blocks (D5) |
| Tool call and result rendering | native names | mapped names | omp names mapped to app names (§3.3) |
| Diff view for edits | `Edit` input | `FileChange` result diff | replace-mode edits → `Edit {file_path, old_string, new_string}` (inline diff before and during approval); hashline edits → `FileChange` with a result diff (§3.3) |
| Todo list card | `TodoWrite` | `UpdatePlan` | `TodoWrite` built from the `todo` result `details.phases` (§3.3) |
| Tool approval | `canUseTool` | server requests | `extension_ui_request select ["Approve","Deny"]` → `permission_request` with omp's approval text; answer `extension_ui_response` (§4.1) |
| Approve always | SDK session rules | `acceptForSession` | Bridge-side per-session allow-list by omp tool name, never for safety-flagged prompts (D2, §4.2) |
| Ask user a question | `AskUserQuestion` | `requestUserInput` | omp `ask` → `AskUserQuestion`; the Bridge replays the answer into omp's select/editor chain (§4.3) |
| Other extension dialogs | – | elicitation | one-question `AskUserQuestion` (§4.4) |
| Interrupt | SDK interrupt | `turn/interrupt` | cancel pending dialogs, then RPC `abort` (§5.4) |
| Input while busy (1-slot queue, edit, cancel) | SDK queue | Bridge 1-slot queue | the same Bridge 1-slot queue, drained when the Bridge goes idle (D6, §5.2) |
| Steer queued input | – | `turn/steer` | RPC `steer` while omp is busy; a queued item is sent as a prompt when idle (§5.3) |
| Image attachments | inline base64 | `localImage` | `prompt.images` / `steer.images` (OBSERVED P6), offered for every omp model (§5.5) |
| Slash commands list | SDK commands | skills / apps / plugins | `available_commands_update` → `system/supported_commands` (§3.1) |
| `$` skills / mentions | – | yes | unsupported (Codex structured input) |
| Goals | – | `thread/goal/*` | unsupported: no RPC goal command (`/goal` is TUI-only); `goal_updated` frames are dropped |
| Tool suggestions, guardian auto-review, CLI join | – | yes | unsupported (Codex-only concepts) |
| Compaction status | `compacting` | – | `auto_compaction_start/end` → `compacting` and back to the derived status (§2.5) |
| Recent sessions list, filter, search, named-only | disk index | `thread/list` + rollouts | disk scan of the omp session store (D7, §6.1) |
| Resume | SDK resume | `thread/resume` | spawn with `--resume <sessionFile>` after the previous writer exited; history from disk; `session_created` after the handshake (§6.4) |
| History replay (incl. images) | JSONL | RPC thread items | active branch of the session JSONL; blob images registered in the image store on demand (D8, §6.2) |
| Rename running session | CLI file | `thread/name/set` | RPC `set_session_name` (OBSERVED P7) |
| Rename recent session | CLI file | `session_index.jsonl` | live session → its process; else a short-lived `--mode rpc --resume` process (D9, §6.3; OBSERVED V4) |
| Auto-rename | `claude -p` | `codex exec` | `omp -p` one-shot without tools, extensions and session, `--approval-mode always-ask` (D10, §8.1) |
| Archive | Bridge marker | `thread/archive` + marker | Bridge marker only (§6.5) |
| Conversation rewind | `resumeSessionAt` | fork | RPC `branch {entryId}` in the running process, then a new Bridge session on the branched file; rewound text goes back to the composer (D21, §6.6) |
| File rewind (code / both) | SDK checkpoints | – | unsupported: no RPC file checkpoint restore |
| Fork at a message | – | `thread/fork` | unsupported in v1 (§6.6) |
| Clear context and accept plan | yes | – | unsupported (no plan approval); `approve.clearContext` is rejected for omp |
| Retry a failed user message | resend | – (off) | off, as in the Codex screen (§10.2) |
| Per-session cost / tokens / duration | `result` | `result` | per-run sums of assistant `message_end.usage` (OBSERVED P12), emitted with each `result` (§3.4) |
| Account usage / rate limits | link to claude.ai | `account/rateLimits/read` | out of scope (§8.3) |
| Git commit message assist | `claude -p` | `codex exec` | `omp -p` with the diff on stdin (OBSERVED P11b, §8.2) |
| Push notifications | yes | yes | same Firebase path; provider-aware texts (§8.5) |
| Deep links / session link resolution | yes | yes | `provider=omp`; the link screen waits for Bridge capabilities (§10.3) |
| Copy resume command | `claude --resume` | `codex resume` | `omp --resume <sessionId> --approval-mode <mode>` (§10.3) |
| Workspace / project assignment | yes | yes | yes, keyed `omp:<sessionId>` (`workspace-store.ts:46-51`) |
| Doctor | `claude --version` + auth | `codex --version` + auth | `omp --version`; "authenticated" = `omp models --json` lists a model (§8.4) |

## 2. omp process lifecycle

`OmpProcess` (`omp-process.ts`, WP1) owns one child through a small transport (`omp-rpc-transport.ts`, WP1) for spawn, framing, chunk reassembly and request correlation. The split mirrors `codex-transport.ts` / `codex-process.ts`.

### 2.1 Spawn spec

Binary: `process.env.BRIDGE_OMP_BIN` if set and non-empty, otherwise `"omp"` resolved through `PATH` (D1). This is the first Bridge-wide `*_BIN` variable (research `bridge-periphery.md` §0.5) and is documented in the CLI help (§8.6).

Arguments, in this order:

```text
<bin> --mode rpc-ui
      --cwd <effectiveCwd>
      --allow-home
      --approval-mode <always-ask|write|yolo>
      --config <overlayPath>
      [--model <provider>/<id>]
      [--thinking <off|minimal|low|medium|high|xhigh|max>]
      [--add-dir <root>]...
      [--resume <absolute path of the session .jsonl>]
```

| Argument | Rule | Reason |
|---|---|---|
| `--mode rpc-ui` | always | Registers the `ask` tool (SOURCE `main.ts:2138`, `tools/ask.ts:785-787`); plain `rpc` has no `ask`. |
| `--cwd <effectiveCwd>` | always; `effectiveCwd` = worktree or project path from `SessionManager.create` (`session.ts:385`), or the recorded cwd on resume (§6.4) | Without it a launch cwd of `$HOME` becomes a temp dir (OBSERVED P8). The spawn `cwd` option is the same directory. |
| `--allow-home` | always | Keeps a project that *is* `$HOME` in `$HOME` (OBSERVED P8). |
| `--approval-mode` | always, from §7.3 | The schema default is `yolo` (SOURCE `tools/settings.ts:290-295`) and this user's config is `yolo`; without the flag every tool would run unprompted. Precedence: `--auto-approve`/`--yolo` force yolo on top of everything (SOURCE `tools/approval.ts:68-73`); the Bridge never passes them. |
| `--config <overlayPath>` | always | Overlay with `ask.timeout: 0`. OBSERVED P2f: with this user's `ask.timeout: 120` omp auto-selects an answer after 120 s without any frame. The overlay merges with the user config instead of replacing it (OBSERVED V1/V3), and it beats a project-level `ask.timeout` (DOCUMENTED `docs/config-usage.md:167-178`: env > runtime > overlay > project > global; `ask.timeout` has no env variable, SOURCE `modes/settings.ts:1091-1094`). A missing overlay file is a hard error (DOCUMENTED `docs/config-usage.md:190`), so it is written before every spawn. |
| `--model` | only for an exact selector present in the Bridge model cache (§7.1) | `--model` fuzzy-matches: OBSERVED WC1, `claude-opus-4-7` became `amazon-bedrock/anthropic.claude-opus-4-7`, `opus` became a Claude 3 Opus Bedrock model, `claude-opus-4-7[1m]` exited 1 before `ready`. A value that is not a cached selector is dropped with the tip `omp_model_ignored` (§6.4). |
| `--thinking` | only for a level in the selected model's `thinkingLevels` (§7.1) | OBSERVED V1 over RPC: an unsupported level is silently mapped (`minimal` → `high` on a model offering off/high/max) and an unknown level clears the setting; the Bridge validates first and reads the result back. |
| `--add-dir` | once per additional root (`additionalWritableRoots` after `normalizeAdditionalWritableRoots`, `websocket.ts:1341`, called at `:2921`) | OBSERVED P8/V4 above. |
| `--resume <file>` | resume, respawn and rename-recent | Always an absolute path: path-like values open the file directly, while id lookup prompts on a missing cwd and fails without a TTY (DOCUMENTED `docs/session-switching-and-recent-listing.md`). OBSERVED P8: model and thinking level are restored. The spawn waits until no other process holds the file (§6.7). |

Not passed: `--no-skills`, `--no-extensions`, `--no-rules`, `--no-lsp` (the user's omp environment applies to real sessions), `--no-session`, `--session-dir` (the listing scans the default store, §6.1), `--no-title` (RPC disables automatic titles, SOURCE `main.ts:1841-1847`).

Overlay file: `~/.ccpocket/omp-rpc-overlay.yml`, mode `0600`, rewritten before a spawn when its content differs:

```yaml
# Written by ccpocket Bridge. Applies only to omp processes started by the Bridge.
ask:
  timeout: 0
```

Environment: a copy of `process.env` without `TMUX_PANE`, `ZELLIJ_PANE_ID`, `CMUX_SURFACE_ID`, `KITTY_WINDOW_ID`, `WEZTERM_PANE`, `TERM_SESSION_ID`, `WT_SESSION` (omp derives its terminal breadcrumb from them; a Bridge child would otherwise overwrite the breadcrumb that the user's `omp -c` reads; the list matches the binary's `ttyid`, OBSERVED by the omp review). `OMP_PROFILE`, `PI_PROFILE`, `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` pass through unchanged; the Bridge's disk readers resolve the same values (§8.0).

Spawn options: `{ cwd, stdio: "pipe", env }`, no shell. Windows is not supported in v1 (the Codex path needs `cmd.exe` quoting, `codex-transport.ts:40-50`, and omp's Windows build was not checked). On `win32` `OmpProcess.start` emits the deferred error `omp_unsupported_platform` and `exit` (same delivery as `omp_cli_not_found`, §2.6) unless `BRIDGE_OMP_BIN` points at an `.exe`.

### 2.2 Framing

- `child.stdout.setEncoding("utf8")`; the string decoder keeps multi-byte characters intact across chunks.
- Split on `"\n"` only (D1). `readline` also splits on U+2028/U+2029 (OBSERVED on Node v24 by the omp review), which `JSON.stringify` does not escape.
- Per physical line limit 64 Mi UTF-16 code units, checked before `join` as in `CodexProcess.handleStdoutChunk` (`codex-process.ts:2381-2428`). omp's frame limit is 1 MiB (`ready.maxFrameBytes`, OBSERVED P1). Exceeding the Bridge limit fails this connection (§2.6), not the Bridge.
- Empty lines are skipped; a non-JSON line is logged and dropped (omp writes diagnostics to stderr).
- Outbound: `JSON.stringify(command) + "\n"`. Inbound frames to omp are never chunked (DOCUMENTED `docs/rpc.md`).
- stderr: 8 KiB ring buffer for error reports, logged line by line.

### 2.3 Protocol v2 and `rpc_chunk` reassembly

1. The first stdout frame must be `ready`. OBSERVED P1: `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}`.
2. Without `2` in `supportedProtocolVersions` the start fails with `omp_protocol_unsupported`.
3. Send `{"id":"<id>","type":"negotiate_protocol","protocolVersion":2}` and wait for `success:true`, `data.protocolVersion: 2` (OBSERVED P1). No other command is written before this response; commands requested earlier (for example `setModelSettings`) wait in an outbox until the handshake finishes (§2.4).
4. `rpc_chunk` frames (OBSERVED P1; SOURCE `modes/rpc/rpc-output.ts:36-46`): keys `type, chunkId, index, count, byteLength, data`; `data` is padded base64 of a 256 KiB slice of the UTF-8 JSON; the chunks of one object are written back to back.
   - One reassembly slot `{chunkId, count, byteLength, parts: Buffer[]}`; `index === 0` opens it; each next frame must carry the same `chunkId` and `index === parts.length`. Any other frame while a slot is open, a gap or a repeat discards the slot and logs a protocol error.
   - Reject `byteLength` above `min(ready.maxReassembledFrameBytes, 64 MiB)` without buffering.
   - When complete: `Buffer.concat`, check `length === byteLength`, decode UTF-8 **once** (a slice can split a character), `JSON.parse`, dispatch.
5. `rpc_frame_error {originalType, error}` also occurs under v2, for a logical frame above the 64 MiB reassembly ceiling (SOURCE `modes/rpc/rpc-frame.ts:94-99`, `:218-240`). An oversized `response` arrives instead as `success:false` "RPC response exceeded the transport limit", and an oversized `agent_end` as `{type:"agent_end", messages:[], messageCount}` without `isTerminal`/`yielded`. Handling:
   - `originalType: "tool_execution_end"`: emit an error `tool_result` for the oldest started, unended call (`content: "omp could not deliver this tool result (over 64 MiB)"`) and mark it ended.
   - `originalType: "message_end"`: finalize the assistant entry from the streamed deltas (text so far) so the app does not keep a streaming tile.
   - An `agent_end` without `isTerminal`/`yielded` is treated as a yield (omp's own rule: "older sessions omit `yielded`; only their terminal ends were yields", SOURCE `rpc-prompt-results.ts:123-124`).
   - Any other `originalType`: `omp_notice` "omp dropped an oversized <type> frame".

### 2.4 Readiness and request correlation

`OmpProcess.start(cwd, options)` returns immediately; spawn and handshake run asynchronously. `status` is `starting` throughout.

| Step | Action | On failure |
|---|---|---|
| 1 | with `--resume`: `await ompWriters.waitForRelease(file)` (§6.7; implemented as `acquire`, which waits and reserves, §15.1) | – |
| 2 | spawn | `ENOENT` → `omp_cli_not_found` (§2.6) |
| 3 | wait for `ready` (60 s; OBSERVED start-up 0.5–1.4 s, MCP servers may add more) | exit before `ready` → `omp_start_failed` with stderr tail (OBSERVED P12a: bad `--model` exits 1) |
| 4 | `negotiate_protocol` v2 | `omp_protocol_unsupported` |
| 5 | `set_interrupt_mode {mode:"wait"}` (OBSERVED V1) | logged only |
| 6 | `get_state` | `omp_start_failed` |
| 7 | register `sessionFile` in `ompWriters` (§6.7); flush the outbox; emit `system/init` (§3.1); status `idle`; resolve `waitUntilReady()`; emit `input_ready` | – |

Step 5 pins the documented `wait` behaviour (a steer is delivered after the running tool finishes) independent of user config, like `--approval-mode`. `set_steering_mode` / `set_follow_up_mode` are not pinned: the Bridge has at most one prompt or steer in flight (§5).

`get_state` is sent only here and after a `model_changed` the Bridge did not cause (§7.2): it returns the full system prompt and every tool schema (SOURCE `modes/rpc/rpc-mode.ts:1273-1300`). It supplies `sessionId`, `sessionFile`, `model`, `thinkingLevel` (can be absent, OBSERVED P10/V5), `sessionName`, `isStreaming`, `hasPendingAsyncWork`, `isSettled`. `sessionFile` is the planned path; a new session's file appears only after the first assistant message (OBSERVED P7), so every consumer checks that it exists (§6.4, §7.3). `get_state` has no cwd field (OBSERVED P8/V1); the Bridge keeps its own.

Correlation: every command gets `id: "b<n>"`; a pending map holds `{command, resolve, reject, timer}`.

- Control commands time out after 30 s. `prompt` has **no** timeout: built-in slash commands run inside the `prompt` handler before its response (SOURCE `rpc-mode.ts:1131-1216`), and a long one is legitimate. A missing `prompt` response is covered by interrupt and stop.
- `extension_ui_response` has no response frame (SOURCE `rpc-mode.ts:259-263`) and is fire-and-forget.
- `success:false` rejects with `error` and optional `code`.
- A second `response` for an id that already resolved is expected for prompts that fail before reaching the agent (OBSERVED P5/V3: `success:true`, then `success:false` with the same id, then `prompt_result`); it is logged, and the error is reported once from `prompt_result` (§3.1). Other unknown ids are logged and dropped.

### 2.5 Run state and status

`ProcessStatus` is `"starting"|"idle"|"running"|"waiting_approval"|"compacting"` (`parser.ts:1139-1144`). `OmpProcess` keeps these facts and **derives** the status from them after every frame and every Bridge action, instead of hard-coding transitions:

| Fact | Set | Cleared |
|---|---|---|
| `lifecycle: "starting"\|"ready"\|"closing"\|"exited"` | `start()` → `starting`; an approval-mode respawn (§7.3) → `starting` for its whole duration, including the old child's shutdown; handshake done → `ready`; `stop()` → `closing` | child `exit` after `stop()` or a crash → `exited` |
| `pendingPrompts: Map<id, PendingPrompt>` | Bridge writes `prompt` | its `prompt_result`; a `prompt` response with `data.agentInvoked:false` (local completion, no `prompt_result` follows, SOURCE `rpc-mode.ts:1189-1193`); process exit |
| `runLive` | `agent_start` | `agent_end` with `yielded ?? isTerminal !== false` (the rule omp uses for `prompt_result`, SOURCE `rpc-prompt-results.ts:123-124`) |
| `dialogs` | `extension_ui_request` classified as a dialog (§4) | answered, cancelled, withdrawn (`cancel {targetId}`), exit |
| `compacting` | `auto_compaction_start` | `auto_compaction_end` |
| `settled` | initialized from `get_state.isSettled` at the handshake; `session_settled`; `prompt_result {sessionSettled:true}` | `agent_start` (a prompt that fails before reaching the agent never clears it, and omp sends no `session_settled` for it) |

Derived status:

```text
lifecycle starting                      → starting
lifecycle closing | exited              → idle   (isAlive false, see below)
dialogs non-empty                       → waiting_approval
compacting                              → compacting
pendingPrompts non-empty or runLive     → running
otherwise                               → idle
```

`setStatus` emits the `status` event and a `{type:"status"}` message only when the derived value changes, as `codex-process.ts:3679-3685` does. Every change **into** `idle` while `lifecycle === "ready"` also emits `input_ready`, which drains the 1-slot queue (§5.2), applies a pending model change (§7.2) and runs the uuid backfill (§6.6).

Why `prompt_result` and not `session_settled` ends a run:

- SOURCE `modes/rpc/rpc-session-settle.ts:18-27`, `:80-97`: `session_settled` requires `!hasPendingAsyncWork()`, and the watcher waits out background work before emitting it. SOURCE `rpc-prompt-results.ts:115-156`: `prompt_result` is written at the yielding `agent_end` with `sessionSettled` computed at that moment.
- OBSERVED V7 (`bash {async:true}`): `agent_end{isTerminal:false, yielded:true}` and `prompt_result {sessionSettled:false}` at 2.97 s; `get_state` then showed `isStreaming:false, hasPendingAsyncWork:true`; a second prompt was accepted and completed at 4.16 s; `session_settled` came at 18.21 s, after omp woke itself for the job's result.
- omp auto-backgrounds bash, `task` and `eval` (DOCUMENTED `docs/rpc.md:256`), so keying on `session_settled` would hold the phone's queue for the job's lifetime (a dev server: forever).
- SOURCE `rpc-session-settle.ts:58`, `:84`: `session_settled` is emitted only after an `agent_start`, so a prompt that fails before reaching the agent (for example "No API key found", SOURCE `session/agent-session.ts:7144-7158`) never produces one (DOCUMENTED `docs/rpc.md:258`).

Ordering: `prompt_result` is written one macrotask after the `agent_end` it reports (SOURCE `rpc-prompt-results.ts:137-143`), and every message and tool frame of the run precedes that `agent_end`, so all frames of a run have arrived when the Bridge goes idle.

`session_settled` has one role: it sets `settled`, which gates the approval-mode respawn (§7.3; a respawn would kill background jobs). It does not change the status. It is sent regardless of `set_event_filter` (DOCUMENTED `docs/rpc.md:546`).

Agent-initiated runs: an `agent_start` with no pending Bridge prompt (omp woke itself for a finished async job, or a steer that arrived after idle, §5.3) makes the status `running`; its yielding `agent_end` produces the run's `result` (§3.4) and the status returns to `idle`.

Compaction: after `auto_compaction_end` the status is re-derived, so idle compaction (`reason:"idle"`, opt-in `compaction.idleEnabled`, DOCUMENTED `docs/compaction.md:137-139`, `:504`) returns to `idle`, and compaction inside a run returns to `running`. Manual `/compact` runs in the background under RPC and answers `agentInvoked:false` at once (SOURCE `slash-commands/builtin-lifecycle.ts:288-296`) without any compaction event; the Bridge shows `idle` meanwhile and relays "Compaction complete." as `command_output` (§13.2 risk 10).

`isWaitingForInput` is `status === "idle" && lifecycle === "ready"`. `isAlive` is `lifecycle === "starting" || lifecycle === "ready"`.

### 2.6 Stop, interrupt, abort, crash

- **Writes after close.** In `closing`/`exited` every write method (`sendInput`, `steer`, `approve`, `reject`, `answer`, `setModelSettings`, `setSessionName`, `branch`) writes nothing, returns `false` (or rejects), and emits `error {errorCode:"omp_process_exited"}` once. Reason: on Node v24.20.0 `child.stdin.write()` after `end()` returns `false`, fires no `error` event, and the line is lost (checked by the bridge review). The omp `input` branch (§5.1) rejects input for a process that is not alive with the same code.
- **`interrupt()`**: §5.4.
- **`stop()`** (synchronous, as `SessionManager.destroy` expects):
  1. `lifecycle = "closing"`;
  2. cancel every open dialog with `{cancelled:true}` and emit `permission_resolved` for each;
  3. if a run is live, write `abort`;
  4. end stdin. omp rejects pending UI requests, drains accepted commands, disposes the session and exits 0 (OBSERVED in every probe; V3/V4); dispose appends `custom session_exit` to the active file (OBSERVED P7);
  5. keep reading stdout until the child's `close` (D1);
  6. `SIGTERM` after 5 s, `SIGKILL` after 10 s.
  `readonly exited: Promise<number | null>` resolves on the child's `close` event, when it has exited and stdout and stderr are drained; `ompWriters` releases the file at the same moment (§6.7). Node can emit `exit` before the last stdout frames and stderr lines are read (OBSERVED on Node v24 with the event loop blocked while omp exited), so the exit handling below runs on `close`. If a grandchild keeps an inherited pipe open, the transport destroys the pipes 2 s after `exit` and settles with what it read. `runOmpPrint` and `listOmpModels` (§8.0, §7.1) settle the same way.
- **Exit before `ready`**: `{type:"error", errorCode:"omp_start_failed", message:"omp exited before it was ready (code N): <stderr tail>"}`, status `idle`, `emit("exit", code)`, `waitUntilReady()` rejects with the same code.
- **Spawn `ENOENT`**: `{type:"error", errorCode:"omp_cli_not_found", message:"omp CLI not found. Install omp or set BRIDGE_OMP_BIN."}`, then as above; deferred with `queueMicrotask` so listeners attached after `start()` see it (same reason as `sdk-process.ts:776-789`). `omp_unsupported_platform` uses the same path.
- **Exit after `ready`**: reject pending commands, `permission_resolved` for every open dialog, `{type:"error", errorCode:"omp_process_exited", message}` with the stderr tail, status `idle`, `emit("exit", code)`. `SessionManager` clears the queue and records `idle` (`session.ts:753-765`). No automatic restart; the user resumes the session, as with Codex. `resolve_session_link` for such a session (by Bridge id or omp id) answers `recent` with its recent entry, so a notification or deep-link tap resumes it and the resume replaces the exited Bridge session; without a session file it answers `live` as before.
- **stdout failure** (line limit, allocation error): as an unexpected exit, plus `SIGTERM`.
- Background jobs end with the process: stop, respawn and rewind (§6.6, `branch` cancels own async jobs, SOURCE `agent-session.ts:10470`) terminate them.

## 3. Event mapping

Source of the frame list: omp `rpc-types.ts` at v18.3.2 (outbound union, `RpcExtensionUIRequest`), `AgentEvent` (agent package `types.ts:1189-1211`), `AgentSessionEvent` (`session/agent-session-events.ts`), and the RPC-mode frames `command_output`, `session_info_update`, `config_update`, `extension_error` (`modes/rpc/rpc-mode.ts:1028-1161`). Every type below is handled explicitly; an unknown `type` is logged once per process and dropped.

### 3.1 omp frame → Bridge `ServerMessage`

| omp frame | Bridge output | Notes / reason |
|---|---|---|
| `ready` | none | handshake (§2.3) |
| `response` | none | resolves the pending command (§2.4). `command:"prompt"` with `data.agentInvoked:false` is a local completion (below) |
| `rpc_chunk` | none | reassembled (§2.3) |
| `rpc_frame_error` | per `originalType` (§2.3 step 5) | |
| `agent_start` | status re-derived (`running`) | an `agent_start` without a pending Bridge prompt starts an agent-initiated run: per-run accumulators reset (§3.4) |
| `agent_end` | a yield ends the run (§2.5); for an agent-initiated run it also emits that run's `result` (§3.4) | `agent_end.messages` is never relayed: it repeats every `message_end` of the run |
| `turn_start`, `turn_end` | none | `turn_end.toolResults` duplicates `tool_execution_end` |
| `message_start` | none | |
| `message_update` | `text_delta` → `{type:"stream_delta", text}`; `thinking_delta` → `{type:"thinking_delta", text}`; other `assistantMessageEvent` types dropped | D5. The `partial`/`message` snapshots are never relayed; `toolcall_delta` has no app view |
| `message_end` role `assistant` | `{type:"assistant", message:{id, role:"assistant", content, model}}` (§3.2) | D5: authoritative. Nothing for an empty `content` (OBSERVED P2e/P4: aborted turns end with `content: []`) |
| `message_end` other roles | none | live user messages were appended by the Bridge itself (§5); `OmpProcess` never emits `user_input` (§5.1). `toolResult` comes from `tool_execution_end`; persisted `custom_message` entries are handled in history (§6.2) |
| `tool_execution_start` | none | approval and `ask` bookkeeping (§4); the `tool_use` block was sent with the assistant `message_end` |
| `tool_execution_update`, `tool_stream_update` | none | cumulative snapshots; no app tool-progress message |
| `tool_execution_end` | `tool_result` (§3.3), preceded by a synthetic `assistant` `TodoWrite` block for `todo` | image blocks become Claude-shaped `rawContentBlocks` so `SessionManager` registers them (`session.ts:608-650`) |
| `prompt_result` | `result` (§3.4) | once per Bridge prompt, matched by `id` |
| `session_settled` | none | sets `settled` (§2.5) |
| `auto_compaction_start` | status re-derived (`compacting`) | |
| `auto_compaction_end` | status re-derived; if `aborted` or `errorMessage`: `omp_notice` | `skipped:true` is silent |
| `auto_retry_start` | `omp_notice` "Retrying (<attempt>/<maxAttempts>) in <delayMs/1000>s: <errorMessage>" | same role as `codex_warning` (`codex-process.ts:2853-2926`); not probed |
| `auto_retry_end` | none | failure surfaces through `prompt_result` |
| `retry_fallback_applied {from, to}` | `omp_notice` "Model fallback: <from> → <to>", then `system/omp_settings` with `model: to` | |
| `retry_fallback_succeeded` | none | |
| `model_changed` | if caused by a Bridge `set_model`: nothing (the response already carried the model, §7.2); otherwise `get_state`, then `system/omp_settings` | OBSERVED P7: `model_changed` carries no fields |
| `config_update {model, thinkingLevel}` | `system/omp_settings` | emitted by slash commands that change the model (SOURCE `rpc-mode.ts:1160-1162`) |
| `thinking_level_changed {thinkingLevel?}` | `system/omp_settings` | OBSERVED P7/V1; an absent field means "cleared" |
| `session_info_update {title}` | internal event `session_name` | `SessionManager` stores it (§6.3); emitted by `/rename` |
| `available_commands_update {commands}` | `{type:"system", subtype:"supported_commands", slashCommands: commands.map(c => c.name)}` | names without `/`, as Claude's `slash_commands` (`sdk-process.ts:479`); feeds the command cache (`session.ts:470-508`) |
| `command_output {text}` | `assistant` text message, ANSI escapes removed | output of local slash commands (`/context`, "Compaction complete.") |
| `notice {level:"info"}` | none | OBSERVED startup noise (`xd://` mount notice) |
| `notice {level:"warning"\|"error"}` | `omp_notice` | e.g. `source:"session-persistence"` failures |
| `extension_error` | `omp_notice` "Extension <extensionPath> failed in <event>: <error>" | |
| `extension_ui_request` | §4 | |
| `host_tool_*`, `host_uri_*` | none, logged | the Bridge registers no host tools or URI schemes |
| `subagent_lifecycle`, `subagent_progress`, `subagent_event` | none | the `task` call and result appear in the parent transcript |
| `ttsr_triggered`, `todo_reminder`, `todo_auto_clear`, `irc_message`, `advisor_cost_changed`, `advisor_yielded`, `config_warnings_changed` | none | no app surface |
| `goal_updated` | none | goals are unsupported |

`system/omp_settings` is `{type:"system", subtype:"omp_settings", sessionId, provider:"omp", model?, thinkingLevel?, thinkingLevels}` (`thinkingLevels` from the model cache, §7.1; implemented from omp's own model object, §15.1). It is state, not a transcript entry: `SessionManager` merges it into `session.ompSettings` and delivers it live **without** appending it to history, and `get_history` plus every generic `get_history_delta` for an omp session sends a fresh snapshot directly on the socket, as `sendCodexCurrentSettings` does for Codex (`websocket.ts:2187-2211`, called at `:4892`, `:5027`). The app additionally skips `omp_settings` when it replays history (§10.2).

**`prompt_result` cases** (SOURCE `rpc-prompt-results.ts`; OBSERVED P5, V3):

| Frame | Meaning | Bridge |
|---|---|---|
| `agentInvoked:true`, `status` any | the prompt's run yielded | `result` from the run accumulators with the mapped status (§3.4); remove the pending prompt |
| `agentInvoked:false`, `status:"completed"` | handled locally, e.g. a skill prompt or extension command (`completeLocal`, SOURCE `rpc-prompt-results.ts:94-97`) | `result {subtype:"success"}` without stats |
| `agentInvoked:false`, `status:"error"` | failed before reaching the agent: no model, no API key, usage preflight, busy (`fail`, SOURCE `:99-102`, reached from `reportPromptResult`, `:266-284`) | `result {subtype:"error", error: error.message}`; the earlier second `response` for the same id is not reported again |

`sessionSettled` on the frame is informational only (§2.5). The Bridge never retries a failed prompt and never keys on error text: with `streamingBehavior:"followUp"` on every prompt (§5.1) a prompt that meets a live run is queued by omp instead of failing busy.

**Local completion.** A `prompt` response with `data.agentInvoked:false` finished synchronously (a built-in slash command such as `/context`); omp discards the ticket and sends no `prompt_result` (SOURCE `rpc-mode.ts:1189-1193`). The Bridge emits `result {subtype:"success"}` without stats and removes the pending prompt. `data.agentInvoked:true` (for example `/retry`) keeps the prompt pending until its `prompt_result`.

### 3.2 Assistant content blocks

| omp block (`message_end.message.content[]`) | Bridge `AssistantContent` |
|---|---|
| `text {text}` | `{type:"text", text}` |
| `thinking {thinking, thinkingSignature?}` | `{type:"thinking", thinking}`; empty thinking dropped (as Claude, `sdk-process.ts:502-523`) |
| `redactedThinking` | dropped |
| `toolCall {id, name, arguments, intent?}` | `{type:"tool_use", id, name, input}` per §3.3; `todo` calls are held until `tool_execution_end` |
| `image`, `fallback`, `anthropicServerTool` | dropped in v1 (no probe produced them; the app has no generic assistant-image block) |

`message.id`: Bridge-generated `omp-msg-<uuid>`, because omp's `msg-N` restarts with every process. `message.model`: `<provider>/<model>`, the selector used everywhere (§7.1). Assistant messages carry no `messageUuid`; they are not rewind anchors for omp (§6.6).

`arguments.i` (the intent omp injects into every call, OBSERVED P3a) is dropped from every input; omp strips it from `tool_execution_start.args` itself (OBSERVED V2).

### 3.3 Canonical tool names

The app decides rendering by tool name: category and icon in `utils/tool_categories.dart:14-29`; one-line summaries read `file_path`/`path` (`:127`), `command` (`:149`), `pattern`/`query`/`url` (`:155`) and `description`/`prompt` (`:164`); diffs for `Edit`/`FileEdit`/`MultiEdit`/`Write`/`NotebookEdit`/`FileChange` (`widgets/bubbles/tool_result_bubble.dart:119-127`, `:182-197`, `:516`) and the inline edit diff for `Edit` input (`widgets/bubbles/inline_edit_diff.dart`); the todo card for `TodoWrite` (`widgets/bubbles/assistant_bubble.dart:243`, input read by `widgets/bubbles/todo_write_widget.dart:64`, `:188-203`); approval cards for `Bash` and `FileChange` (`models/messages.dart:2173`, `:2196`); the question UI for `AskUserQuestion` (`services/chat_message_handler.dart:498-515`, `utils/request_user_input.dart:35-90`); push texts (`websocket.ts:9376`). Codex maps onto the same names (`codex-process.ts:3106-3235`).

Wire-name aliases: `toolCall.name` and `tool_execution_start.toolName` carry the **wire** name, while approval titles carry the internal `tool.name` (SOURCE `tools/approval.ts:367`, agent `agent-loop.ts:3271-3275`). The only custom wire name in v18.3.2 is `apply_patch` for `edit` (SOURCE `edit/index.ts:378-380`). `OMP_TOOL_WIRE_ALIASES = { apply_patch: "edit" }` normalizes wire names to internal names before any mapping or approval matching.

| omp tool (internal name) | App `name` | `input` sent to the app | `tool_result` |
|---|---|---|---|
| `bash` | `Bash` | `{command, cwd?, timeout?}` | `toolName:"Bash"`, text (OBSERVED P3a) |
| `read` | `Read` | `{file_path: path}` (selector suffix such as `:50-100` stays) | `toolName:"Read"`; image blocks → `rawContentBlocks` (OBSERVED P6) |
| `write` | `Write` | `{file_path: path, content}` (the app synthesizes an all-added diff, `utils/diff_parser.dart:556-566`) | `toolName:"Write"`, text (OBSERVED P3d) |
| `edit`, replace mode (`arguments.old_string` and `new_string` are strings) | `Edit` | `{file_path: path, old_string, new_string}` | `toolName:"Edit"`; content = unified diff from `details.diff` (below), else text |
| `edit`, hashline / patch / `apply_patch` mode (`arguments.input`) | `FileChange` | `{changes:[{path, kind:"update", diff: <patch section for that path>}]}`; paths from the `[PATH#TAG]` headers of `arguments.input` (implemented: `add`/`delete` kinds and the `{path, edits}` shape too, §15.1) | `toolName:"FileChange"`; unified diff from `details.diff`, else text |
| `grep` | `Grep` | `{pattern, path?}` | text |
| `glob` | `Glob` | `{pattern: path}` (omp's glob lives in `path`, DOCUMENTED `docs/tools/glob.md`) | text |
| `web_search` | `WebSearch` | `{query}` | text |
| `todo` | `TodoWrite` | `{title:"Todo", todos}` from the **result** `details.phases` (below) | summary text |
| `task` | `Task` | `{description: intent ?? tasks[0].task, prompt: context, tasks}` (single-task shape: §15.1) | text |
| `ask` | `AskUserQuestion` | `{questions:[{id, question, header?, options:[{label, description?}], multiSelect}]}` (`multi` → `multiSelect`) | text (OBSERVED P2: "User selected: red") |
| `mcp__<server>_<tool>` | unchanged | arguments without `i` | unchanged; generic tile and MCP image preview (`tool_result_bubble.dart:129-133`) |
| any other (`eval`, `find`, `hub`, `goal`, `wait`, `learn`, `manage_skill`, extension tools) | unchanged | arguments without `i`, plus `description: intent` when the tool has no `description` argument | unchanged, text |

Rules and reasons:

- **`description: intent` for unmapped tools**: `_otherSummary` shows `description` first (`tool_categories.dart:164`), so unmapped tools get a readable summary without per-tool code.
- **`edit` in replace mode → `Edit`**: the app renders the inline diff from `old_string`/`new_string` on the tool call itself, so the user sees the change while the approval is pending, as for Claude. omp's own approval text for `edit` lists only `File: <path>` lines (SOURCE `edit/index.ts:395-404`).
- **`edit` in hashline mode → `FileChange`**: the call has a single patch string (DOCUMENTED `docs/tools/edit.md` "Input"), not old/new text; the result carries the real diff, and `FileChange` is the name for which the app builds the view from the result. For the approval, the Bridge appends the patch to the approval text (§4.1).
- **Diff conversion**: `details.diff` uses numbered rows `" 1|text"`, `"-2|text"`, `"+2|text"` (lead fact; `docs/tools/edit.md:123` calls it a unified diff, so the converter also accepts real unified diffs unchanged). The Bridge emits `--- a/<path>`, `+++ b/<path>`, `@@ -<a>,<b> +<c>,<d> @@` and one row per diff row with the number and `|` removed. A row not matching `^([ +-])\s*(\d+)\|(.*)$` starts a new hunk; `b` counts ` `/`-` rows, `d` counts ` `/`+` rows, `a`/`c` are the first old/new numbers. Missing or unmatched `details.diff` (multi-file results were not probed) → the text content.
- **`todo` → `TodoWrite` from the result**: the call is one mutation (`op: init|start|done|…`, DOCUMENTED `docs/tools/todo.md`); the result's `details.phases: {name, tasks:[{content, status, blocker?}]}[]` is the full state. Live, the block is held back at `message_end` and emitted at `tool_execution_end` as a separate `assistant` message with one `TodoWrite` block (`id` = `toolCallId`), then its `tool_result`, as Codex emits `UpdatePlan` (`codex-process.ts:2824-2846`). Status mapping: `pending`/`in_progress`/`completed` unchanged; `abandoned` → `completed` with suffix ` (dropped)`; `blocked` → `pending` with ` (blocked: <blocker>)`; `activeForm` `""`; several phases are flattened with prefix `<phase>: `. An `isError` result is a plain `tool_result` (preceded by the held call as a generic `todo` `tool_use`, §15.1).
- **`Task` naming** keeps parity with Claude transcripts; subagent progress is not shown.
- **Unmapped names stay omp names**: inventing app names for omp-only tools adds app code without a rendering gain.

### 3.4 `result`

Per-run accumulators reset when the Bridge sends a prompt and at `agent_start` of an agent-initiated run: `cost += usage.cost.total`, `input += usage.input`, `cacheRead += usage.cacheRead`, `output += usage.output` per assistant `message_end` (OBSERVED P12); `toolCalls += 1` per `tool_execution_end`; `fileEdits += 1` per successful `edit`/`write` end; `lastText` = text of the last assistant message; `lastStopReason` = its `stopReason`.

A `result` is emitted for each `prompt_result` of a Bridge prompt, and for each agent-initiated run at its yielding `agent_end`, with the status taken from `lastStopReason` (`error` → error, `aborted` → interrupted, else success; omp's own `runOutcome`, SOURCE `rpc-prompt-results.ts:158-168`).

| Status | `result` |
|---|---|
| completed | `{type:"result", subtype:"success", sessionId, result: lastText, cost, duration, stopReason, inputTokens: input, cachedInputTokens: cacheRead, outputTokens: output, toolCalls, fileEdits}` |
| aborted | `{type:"result", subtype:"interrupted", sessionId}` (Codex uses the same subtype, `codex-process.ts:2976`) |
| error | `{type:"result", subtype:"error", sessionId, error: error.message, stopReason}`; OBSERVED P12b: `error:{message, provider, model, httpStatus, retryable}` |

`duration` is milliseconds from the prompt's accept response (or `agent_start`) to the result, the unit Claude uses (`sdk-process.ts:580`). `sessionId` is the omp session id. Cost is omp's figure from its price table; unlike Claude (`sdk-process.ts:1386-1394`) it is not suppressed.

## 4. Approvals, ask, dialogs

All three arrive as `extension_ui_request` frames with an `id` and no `toolCallId` (OBSERVED P2, P3). `OmpProcess` classifies each frame, keeps `dialogs: Map<dialogId, PendingDialog>`, and answers through the existing duck-typed methods `approve`, `approveAlways`, `reject`, `answer`, `getPendingPermission` (`websocket.ts:4611-4796`; they return `boolean`, `false` → "No matching pending tool action.").

Classification of every `select`/`confirm`/`input`/`editor` frame:

1. **Approval**: `method:"select"`, `options` exactly `["Approve","Deny"]`, first title line starts with `"Allow tool: "` (SOURCE `tools/approval.ts:366-387`, `extensibility/extensions/wrapper.ts:334-341`).
2. **Ask step**: a `select` or `editor` whose normalized title matches the current question of an unfinished `ask` call (§4.3).
3. **Generic dialog**: everything else (§4.4).

### 4.1 Approvals (D3, revised correlation)

OBSERVED frames (P3a, P3c, P3d):

```text
OUT {"type":"tool_execution_start","toolCallId":"chatcmpl-tool-0a1b…","toolName":"bash","args":{"command":"echo hi"},"intent":"Running echo command"}
OUT {"type":"extension_ui_request","id":"1591a3c244dbcd78","method":"select","title":"Allow tool: bash\nCommand: echo hi","options":["Approve","Deny"]}
IN  {"type":"extension_ui_response","id":"1591a3c244dbcd78","value":"Approve"}
OUT {"type":"extension_ui_request","id":"1591a3c93f9bcd7f","method":"select","title":"Allow tool: write\nPath: note.txt\nContent:\nhello","options":["Approve","Deny"]}
```

Title layout (SOURCE `tools/approval.ts:366-387`, `wrapper.ts:334-338`): line 1 `Allow tool: <tool.name>`; optional `Origin: MCP server tool`; optional `Reason: <reason>`; the tool's `formatApprovalDetails` lines; optional `Provider safety checks:` followed by one line per check.

Parallel calls (P3c, re-observed V2): the select for the second call arrives **before** its `tool_execution_start`, and both selects can be pending at once. D3's "oldest pending `tool_execution_start`" would bind to the wrong call. Approval selects also come from tools without a parent call of their own: tools invoked inside `eval` (SOURCE `eval/preludes.ts:99`, same prompt format) and subagents. Rule:

1. At each assistant `message_end`, append its `toolCall` blocks to `calls` in order: `{toolCallId, name: alias(name), args (without "i"), approvalDialogId: null, ended: false}` (alias table §3.3). The message always precedes both starts and selects (P3c).
2. For an approval frame: `name` = text after `"Allow tool: "` on line 1; `details` = the remaining lines.
3. Candidates = `calls` with that `name`, `ended === false`, `approvalDialogId === null`.
4. Score = number of the candidate's top-level string argument values (trimmed, first 120 characters, non-empty) that occur in `details`. omp elides long values (`[…Nch elided…]`, SOURCE `tools/approval.ts:360`), so only prefixes are compared.
5. Bind to the highest-scoring candidate only when its score is **above 0**; ties go to call order. A candidate with score 0 is never bound, even if it is the only one: the frame may belong to an `eval` inner call or a subagent.
6. Bound: `candidate.approvalDialogId = dialog.id`, `toolUseId = toolCallId`; `tool_execution_end` sets `ended`. Unbound: `toolUseId = "omp-approval:" + dialog.id`.

Emitted message:

```ts
{ type: "permission_request",
  toolUseId,                                   // omp toolCallId, or "omp-approval:<dialogId>"
  toolName: bound ? canonicalToolName(name, args) : canonicalToolName(name, {}),   // §3.3
  input: {
    ...(bound ? canonicalToolInput(name, args) : {}),   // §3.3
    ...(reasonLine ? { reason: reasonLine } : {}),      // text after "Reason: "
    approvalDetails,                                    // string[]: every detail line, always
  } }
```

`approvalDetails` is omp's own text of what it is about to run: the user sees exactly what omp asks about, whether or not the binding is right. For a bound hashline `edit` the Bridge appends `"Patch:"` and the first 40 lines of that call's patch text (`"…"` when longer), because omp's edit details list only file paths (SOURCE `edit/index.ts:395-404`). The app shows `approvalDetails` as secondary detail lines of the approval card (§10.2, `models/messages.dart` `PermissionPresentation`). The `reason` key feeds the existing summary (`models/messages.dart:2173-2195`).

After emitting: status re-derived (`waiting_approval`).

Answer path:

| Bridge method | Frame sent | Follow-up |
|---|---|---|
| `approve(toolUseId)` | `{"type":"extension_ui_response","id":<dialogId>,"value":"Approve"}` | `permission_resolved {toolUseId}` |
| `approveAlways(toolUseId)` | as approve, plus §4.2 | same |
| `reject(toolUseId, message?)` | `{…,"value":"Deny"}` | `permission_resolved`. OBSERVED P3b: the tool ends "Tool call denied by user: bash" and the turn continues. A non-empty `message` is sent as RPC `steer {message}` right after the deny (approvals only, §15.2). When `reject` returns `true`, the websocket omp branch appends and broadcasts the message as `user_input` through `SessionManager.appendUserInput` (§12.4), the way a steered queue item is appended (`session.ts:1517-1522`), never as a process message (a process `user_input` would be merged into an older entry with the same text by `mergeUserInputIntoHistory`, `session.ts:1041-1071`, `:1184-1203`) |

`toolUseId` omitted (legacy clients) selects the oldest pending approval. `getPendingPermission(toolUseId?)` returns the stored `permission_request` payload for the session card (`session.ts:941-953`).

### 4.2 approve_always (D2)

- `OmpProcess.alwaysAllowedTools: Set<string>` of **internal** omp tool names (the approval title name: `bash`, `edit`, `write`, `mcp__…`).
- `approveAlways` adds the name, approves this dialog and every other pending approval with the same name that is itself eligible (next bullet).
- A later approval frame for a listed name is answered `Approve` immediately, without a `permission_request`, **only if** its details contain no `Reason:` line and no `Provider safety checks:` line. `Reason:` marks omp's safety overrides for critical patterns (DOCUMENTED `docs/approval-mode.md` "Safety overrides"; SOURCE `tools/approval.ts:275-284`), and provider safety checks may not be bypassed by any setting or yolo mode (SOURCE `wrapper.ts:315-316`). Such frames always reach the user.
- Scope: the `OmpProcess` object. It survives the internal respawn (§7.3) and ends with the Bridge session; a resumed session starts empty. This matches Codex `acceptForSession` (research `bridge-process.md` §1.7). It is not written to omp config (`tools.approval.<tool>: allow` is global user config).
- The allow covers every call of that tool (for `bash`: every command). The app says so in the approve-always label for omp (§10.4 `ompApproveAlwaysScope`; in the chat screen a note under the approval bar, §15.5).

### 4.3 ask tool → AskUserQuestion (D4)

OBSERVED frame sequences (P2a–P2f, V3):

```text
single:   select "Which color do you prefer?"  ["red","blue","Other (type your own)"]      → {value:"red"}
multi:    select "Which fruits do you like?"   ["apple","banana","cherry","Other (type your own)"] → {value:"apple"}
          select "(1 selected) Which fruits…"  […,"✔ Done selecting","Other (type your own)"]      → {value:"cherry"}
          select "(2 selected) Which fruits…"                                                       → {value:"✔ Done selecting"}
other:    select … → {value:"Other (type your own)"}
          editor "Which color do you prefer?\n\n○ red\n○ blue\n◉ Other (type your own)\n\nEnter your response:" → {value:"green"}
several:  select "Which color do you prefer? (1/2)" → …; select "Which size do you prefer? (2/2)" → …
multi in several (V3): select "(1 selected) Which fruits do you like? (1/2)" ["apple","banana","cherry","Other (type your own)"]   (no Done)
recommended: single-select label "Blue (Recommended)" must be echoed exactly
cancel:   {cancelled:true} → tool error "Ask tool was cancelled by the user", prompt_result status "aborted"
```

Done-selecting rule (SOURCE `tools/ask.ts:535-537`, `:1083-1087`): a multi-select question offers `Done selecting` only when it is the only question (`allowForward` false) **and** at least one option is selected. `Other` opens the editor; a non-empty editor answer finishes the question with the options toggled so far plus `customInput` (SOURCE `ask.ts:568-582`; OBSERVED V3: `fruits: "apple, cherry"`, `details.customInput`, then question 2). RPC cannot send the ←/→ navigation.

The first select of a call arrives just before its `tool_execution_start` (P2a) and after the assistant `message_end` containing the call; `arguments.questions` carries `id`, `question`, `options[{label, description?}]`, `multi`, `recommended`, `header`.

State per `ask` call, created at the assistant `message_end`:

```ts
interface OmpAskState {
  toolCallId: string;
  questions: OmpAskQuestion[];                 // from arguments.questions
  answers?: Map<number, string[]>;             // set by answer(); may arrive before the first frame
  plan?: Map<number, OmpAskStep[]>;            // derived per question
  requestEmitted: boolean;
  awaitingFrame?: { dialogId: string; method: "select" | "editor"; questionIndex: number; options: string[] };
}
```

Flow:

1. **First ask frame** (title matches question `k`): emit once `permission_request {toolUseId: toolCallId, toolName:"AskUserQuestion", input:{questions}}` and re-derive status. The assistant `tool_use` block already opened the app's question UI (`services/chat_message_handler.dart:498-505`), so an answer can arrive before any frame; it is stored (and then replayed without any `permission_request`, §15.1).
2. **Title normalization**, in this order (OBSERVED V3: the editor title's first line carries the prefix and suffix, followed by glyph rows): take the first line; remove a leading `^\(\d+ selected\) `; remove a trailing ` \(\d+/\d+\)$`. Compare with `questions[k].question`. Options compare after removing the suffix ` (Recommended)`; the reserved labels are `Other (type your own)` (SOURCE `ask.ts:45`) and a label ending in `Done selecting` (glyph is theme-dependent, SOURCE `ask.ts:124`).
3. **`answer(toolUseId, result)`**: parse `result` like both existing adapters (`sdk-process.ts:265-356`, `codex-process.ts` `buildUserInputAnswers`): `{answers: {<question id or text>: string | string[]}}` (sent by `widgets/bubbles/ask_user_question_widget.dart:105-124`), or a plain string for one question. Missing answers → `false`.
4. **Plan per question** (answer values `V`, `O` = values that are offered options, `F` = the rest):
   - single: `V[0]` in options → send that exact offered label; else `Other (type your own)`, then `V[0]` on the editor.
   - multi, one question, `O` non-empty, `F` empty: toggle each of `O` in option order (one select frame each), then the `Done selecting` label.
   - multi, every other case (several questions, or `F` non-empty, or `V` empty): toggle each of `O`, then `Other (type your own)`, then on the editor the `", "`-join of `O` and `F` (or `"(none)"` when `V` is empty). This is the only way to finish such a question over RPC (OBSERVED V3); `{cancelled:true}` would abort the whole turn.
5. **Frame for a question whose plan is not known yet**: kept in `awaitingFrame` until `answer()` arrives.
6. **`tool_execution_end`**: drop the state, `permission_resolved` if still open, then the `tool_result` (`details.selectedOptions` / `customInput` / `results[]`, OBSERVED P2).
7. **`reject(toolUseId)`**: `{cancelled:true}` for the awaiting frame (or the next one). OBSERVED P2e: omp aborts the **whole turn** (`prompt_result.status:"aborted"`); cancelling the editor instead returns to the select (SOURCE `ask.ts:578-580`). There is no RPC way to decline without aborting; the app shows this for omp (§10.4 `ompAskDeclineAborts`).
8. **`cancel {targetId}`** (omp withdraws the dialog, OBSERVED P4c on abort): `permission_resolved`, drop the state.

Timeout: the overlay sets `ask.timeout: 0` (§2.1). If a frame still carries `timeout` (a user with an env override that did not exist in v18.3.2), the Bridge starts a local timer; when it fires it emits `permission_resolved` and `omp_notice` "omp answered the question after its timeout", because omp auto-selects without a frame (OBSERVED P2f).

### 4.4 Other dialogs (D4)

A frame that is neither an approval nor an ask step comes from an extension or a slash command. It becomes a one-question `AskUserQuestion`, so the question UI, session card and push notification apply:

| omp frame | `permission_request.input.questions[0]` | Answer frame |
|---|---|---|
| `select {title, options, optionDetails?}` | `{id: dialogId, question: title, options: options.map((label,i) => ({label, description: optionDetails?.[i]?.description}))}` | `{value: <answer>}` if it equals an option, else `{cancelled:true}` |
| `confirm {title, message}` | `{question: title + "\n\n" + message, options:[{label:"Yes"},{label:"No"}]}` | `{confirmed: answer === "Yes"}` |
| `input {title, placeholder?}` | `{question: title, header: placeholder}` (free text) | `{value: <text>}` |
| `editor {title, prefill?}` | `{question: prefill ? title + "\n\n" + prefill : title}` | `{value: <text>}` |

`toolUseId = "omp-dialog:" + dialogId`. `reject` sends `{cancelled:true}`. A `timeout` field starts the local expiry of §4.3. `cancel {targetId}` emits `permission_resolved`.

Fire-and-forget methods:

| Method | Handling | Reason |
|---|---|---|
| `notify {message, notifyType?}` | `notifyType` `"warning"`/`"error"` → `{type:"error", errorCode:"omp_notice", message}`; `"info"` or absent → `{type:"error", errorCode:"omp_info", message}` | D4: a visible entry. The app renders `omp_notice` in the warning style and `omp_info` in a neutral style (§10.2) |
| `setStatus`, `setWidget`, `setTitle` | ignored | D4; OBSERVED noise `setWidget autoresearch` at start and each `agent_end`; `setTitle` only with `PI_RPC_EMIT_TITLE` |
| `set_editor_text {text}` | ignored | TUI composer prefill |
| `open_url {url, launchUrl?, instructions?}` | `omp_info` "omp asks to open <launchUrl ?? url>" + instructions | only `login` and extensions use it |

### 4.5 Dialog bookkeeping shared by all kinds

- A process exit, a respawn (§7.3) or `stop()` resolves every open dialog with `permission_resolved`.
- The push path needs no change: it keys on `permission_request.toolName === "AskUserQuestion"` and reads `input.questions[0].question` (`websocket.ts:9376-9392`).

## 5. Input, queue, steer, interrupt, images

### 5.1 Input while idle

`websocket.ts` `case "input"` (`websocket.ts:3133-3480`) gets an explicit omp branch after the shared part (image normalization `:3163-3170`, image-store registration `:3180-3195`, conflict check `:3197-3208`):

1. `OmpProcess` not alive (`closing`/`exited`) → `input_rejected {reason:"omp_process_exited"}` plus `error {errorCode:"omp_process_exited"}`; nothing is appended.
2. Append `user_input {text, clientMessageId?, timestamp, imageCount?, images?}` to history and broadcast it, as the generic path does at `websocket.ts:3270-3303`, without a synthetic uuid (omp uuids are backfilled, §6.6). The entry is marked as awaiting an omp entry id (§6.6).
3. `input_ack {queued:false, acceptedSeq}`.
4. `ompProc.sendInput(text, { images })` → RPC `{"id":…,"type":"prompt","message":text,"streamingBehavior":"followUp","images":[{"type":"image","data":<base64>,"mimeType":<mime>}]}`. Legacy `imageId` input resolves through `galleryStore.getImageAsBase64` first, as in the Codex branch (`websocket.ts:3336-3364`).

`streamingBehavior:"followUp"` is sent on every prompt: omp consults it only while a run is streaming (SOURCE `session/agent-session.ts:6714-6735`, re-checked after image preprocessing at `:6774-6792`), so an idle prompt starts a run as usual, and a prompt that meets an agent-initiated run (omp woke itself for an async job at the moment the Bridge sent) is queued behind that run instead of failing with "Agent is already processing" (OBSERVED P5). The Bridge has at most one prompt in flight, so omp's `followUpMode` ("all" merges several) never matters.

`input.skills`, `input.skill` and `input.mentions` are ignored for omp (Codex structured input).

### 5.2 Input while busy: the shared 1-slot queue (D6)

The Codex queue already implements one queued item, edit, cancel, steer, and drain on `input_ready`. It is enabled for omp through one helper, `providerSupportsQueuedInput(p) = p === "codex" || p === "omp"` (new export in `session.ts`, WP2). Method and field names (`queueCodexInput`, `codexQueuedInput`, …) stay; renaming them is not needed for omp and would touch every existing test.

| Location | Today | Change |
|---|---|---|
| `websocket.ts:3210` | queue when `provider === "codex"` and busy | `providerSupportsQueuedInput(session.provider)`; for omp also when `OmpProcess` is `starting` (respawn, §7.3); implemented also while the slot still holds an item, for Codex too (§15.2) |
| `websocket.ts:3228` | `userMessageUuid: nextCodexUserTurnUuid(session)` on every queued item | only when `session.provider === "codex"`; omp items carry no uuid until the backfill (§6.6) |
| `websocket.ts:3231-3232` | `skills`/`mentions` on the queued item | Codex only |
| `websocket.ts:3271-3274` | synthetic `codex:user-turn:N` uuid on idle input | stays Codex-only |
| `websocket.ts:3482`, `:3519`, `:3546` | `update_/cancel_/steer_queued_input` reject non-Codex | helper; error text "No active session with a message queue." |
| `session.ts:139-146` `QueuedCodexInput` | no `clientMessageId` | add `clientMessageId?`, carried into the drained or steered `user_input` (`buildQueuedUserInputMessage`, `session.ts:1558-1567`) so the app can match it (all queue providers; additive) |
| `session.ts:1439`, `:1449`, `:1474`, `:1486` | `queueCodexInput` / `update…` / `cancel…` / `steer…` guard `provider !== "codex"` | helper; `steer…` calls `OmpProcess.steer` for omp (§5.3) |
| `session.ts:1536-1556` `drainCodexQueue` | needs `CodexProcess` | also `OmpProcess.sendInput(text, {images})`; skips an item whose steer is in flight (§5.3) |
| `session.ts:1519-1521`, `:1545-1547` `markPendingCodexUserEcho` | called for every queue provider | Codex only (it is a Codex echo-suppression rule) |
| `session.ts:747-751` | `input_ready` listener only for `CodexProcess` | also `OmpProcess` |
| `session.ts:753-765` | exit clears the queue and broadcasts for Codex | helper |
| `session.ts:1015-1018` | `queuedInput` in the summary only for Codex | helper |
| `websocket.ts:4892-4900` (`get_history`) and the generic `get_history_delta` branch (`:5033-5069`) | queue state and settings only for Codex (`:4988-5031`) | for omp also `conversation_queue` and a direct `system/omp_settings` snapshot (§3.1) |

`conversation_queue` is already in `OPT_IN_SERVER_MESSAGES` (`websocket.ts:252-259`) and in the app's `supportedServerMessages` (`models/messages.dart:4535-4546`).

Why a Bridge-side queue and not omp's follow-up queue: omp's queue modes come from user config (OBSERVED P5: `followUpMode: "all"` merges two follow-ups into one turn), omp has no `clear_queue` command, and the app's queue panel needs edit and cancel.

### 5.3 Steer

omp never rejects a `steer` because a run ended: `steer` queues the message and, when the session is idle, schedules `agent.continue` itself; the RPC handler always answers success (SOURCE `agent-session.ts:7506-7520`, `:7675-7722`, `rpc-mode.ts:1218-1221`; OBSERVED V3: an idle `steer` started a run with a user `message_end{steering:true}` and no `prompt_result`). Therefore:

1. `steerCodexQueuedInput` for omp first checks `OmpProcess.isBusy` (status `running`/`waiting_approval`/`compacting`). Not busy → the item is drained as a normal prompt (§5.2) and the steer request answers `{ok:true}`.
2. Busy → the item is **detached** before awaiting: `session.codexQueuedInput` keeps the item (the queue broadcast is unchanged) but `session.steeringQueuedItemId = itemId` is set, and `drainCodexQueue`, `updateCodexQueuedInput` and `cancelCodexQueuedInput` refuse that item while it is set. Then `OmpProcess.steer(text, {images})` → RPC `{"type":"steer","message":…,"images":[…]}`.
3. Success → clear the slot and `steeringQueuedItemId`, append and broadcast `user_input` (existing code, `session.ts:1517-1522`). The steered text reaches omp exactly once.
4. Failure (process not alive, command error) → clear `steeringQueuedItemId`, keep the item, answer `queued_input_steer_failed`; the next `input_ready` drains it as a prompt.
5. A steer that omp received just as the run yielded starts an agent-initiated run (§2.5), which produces its own `result`.

OBSERVED P5: the steer is injected after the running tool finishes (interrupt mode pinned to `wait`, §2.4) and echoed as a user `message_end` with `steering:true`, which the Bridge drops.

### 5.4 Interrupt

`interrupt` is shared (`websocket.ts:5973`). `OmpProcess.interrupt()`:

1. Answer every open dialog with `{"type":"extension_ui_response","id":<dialogId>,"cancelled":true}` and emit `permission_resolved` for each. OBSERVED P4a: `abort` does not withdraw an approval dialog (SOURCE `wrapper.ts:342`), and `abort` plus every later command hangs until it is answered (65 s in the probe). OBSERVED P4b: `{cancelled:true}` unblocks it. Ask dialogs are withdrawn by omp itself (P4c); cancelling them first is harmless.
2. Write `{"id":…,"type":"abort"}`.
3. Expected (OBSERVED P4b/P4c, V2: abort response in 0.04 s): assistant `message_end` with `stopReason:"aborted"`, `prompt_result.status:"aborted"` → `result {subtype:"interrupted"}` → idle → `input_ready`, which drains a queued item, as for Codex.
4. No `abort` response within 30 s: `omp_notice` "omp did not confirm the interrupt". The child is not killed; `stop_session` stays available.

`interrupt()` while idle is a no-op. An interrupt during an agent-initiated run works the same way (omp aborts the live run).

### 5.5 Images

- **Outbound**: `prompt.images` / `steer.images` as `ImageContent {type:"image", data, mimeType}` (omp ai `types.ts:846`). OBSERVED P6: works with the default model; omp re-encodes the attachment (to `image/webp`) before storing it.
- **No model gate**: the app offers the image button for every omp model. omp describes images through a vision model for text-only models (SOURCE `agent-session.ts:6758-6763` for prompts, `:7633-7639` for queued messages); if that fails, the `prompt_result` error is shown like any other error. This keeps the model catalogue out of the composer (runtime behaviour for a text-only model is unverified, §13.2).
- **Live tool results**: image blocks `{type:"image", data, mimeType}` in `tool_execution_end.result.content` become `{type:"image", source:{type:"base64", data, media_type: mimeType}}` in `rawContentBlocks`; `SessionManager` registers and strips them (`session.ts:608-650`).
- **History**: §6.2.

## 6. Sessions: listing, history, names, archive, resume, rewind

Disk access lives in the new modules `omp-sessions.ts` and `omp-history.ts` (WP1). They never write omp files; every write goes through an omp process, and every omp process the Bridge starts on an existing file goes through the writer registry (§6.7).

### 6.1 Recent sessions listing (D7)

**Store location** (`resolveOmpStore(env)`, §8.0): `root = ~/<PI_CONFIG_DIR ?? ".omp">`; named profile (`OMP_PROFILE` if defined, else `PI_PROFILE`; empty, whitespace or `default` select the default profile) → `agentDir = <root>/profiles/<name>/agent`; default profile → `agentDir = PI_CODING_AGENT_DIR ?? <root>/agent` (DOCUMENTED `docs/environment-variables.md:23`, `:521-525`). Session root `<agentDir>/sessions` with one bucket directory per cwd. If `PI_CODING_AGENT_SESSION_DIR` is set, omp uses it as the session directory for every launch (SOURCE `cli/args.ts:159`, `main.ts:1199-1201` `SessionManager.create(cwd, sessionDir)`); the Bridge then lists that directory as one flat bucket instead (layout from source reading, not probed).

Storage facts (lead facts; DOCUMENTED `docs/session.md` "File Format"): `<bucket>/<ISO-ts>_<id>.jsonl`; line 1 is a fixed 256-byte title slot, line 2 the `session` header, then tree entries.

Algorithm `listOmpRecentSessions({projectPath?})`:

1. List the buckets. Missing root → `[]`.
2. **Project filter without decoding bucket names** (the encoding is lossy, research `bridge-periphery.md` §20): each bucket's cwd is read from the header of its newest file and cached by bucket mtime (implemented: the set of every file header's cwd in the bucket, §15.1). With `projectPath`, keep buckets whose `normalizeWorktreePath(cwd)` equals `projectPath` (the folding `sessions-index.ts:206-217` applies to Claude). Each file's own header is still checked in step 4.
3. **Files**: regular files directly in a bucket matching `^.+_[0-9A-Za-z-]+\.jsonl$`, then the header check (line 2 has `type:"session"` and an `id`). Current ids are uuidv7 (SOURCE `session/session-manager.ts:115-117`), but older files use other id shapes (`docs/session.md:74` shows a 16-hex id), so the name pattern stays loose. Excluded by construction: subagent transcripts in the session's artifact directory (`<stem>/<agent-id>.jsonl`), `.jsonl.*.bak` recovery files and `.jsonl.gz` archives (DOCUMENTED `docs/session.md:518-532`), because they do not end in `.jsonl` directly in a bucket.
4. **Per file**, keyed by `(path, mtimeMs, size)` in a module cache: read the first 64 KiB and the last 64 KiB (omp's own picker reads 4 KiB + 32 KiB). Parallel reads are capped at 32 (`PARALLEL_FILE_READ_LIMIT`, `sessions-index.ts:220`). A `message` line cut by a window boundary is partial-parsed: a regex finds `"role":"user"` or `"role":"assistant"` and the first `"text":"` value, and `decodeJsonStringPrefix` (moved to the new shared `jsonl-partial.ts`, §12 WP1; today a private helper at `sessions-index.ts:289-299`) decodes the cut string, as the Codex lister does (`sessions-index.ts:301-330`). If neither window yields a user message, a bounded streaming scan (stop at the first user message or after 16 MiB) looks for it before the file is excluded.
5. **Entry** (shape `SessionIndexEntry`, `sessions-index.ts:10-41`):

| Field | Source |
|---|---|
| `sessionId` | header `id` |
| `provider` | `"omp"` |
| `name` | the last `title_change.title` in the tail if it starts with the slot title (the slot truncates to 256 bytes, SOURCE `session-title-slot.ts:40-57`); else the slot `title`; else header `title`; else the last `title_change.title` (legacy files without a slot). The header is not rewritten on rename (OBSERVED V4) |
| `firstPrompt` | text of the first user `message` entry (content string or text blocks joined; `synthetic:true` skipped) |
| `lastPrompt` | the last such user text in the tail, omitted when equal to `firstPrompt` |
| `summary` | first 200 characters of the last assistant text in the tail (as Codex, `sessions-index.ts:1248-1471`) |
| `created` | header `timestamp` |
| `modified` | file mtime |
| `gitBranch` | `""` (omp does not record it) |
| `projectPath` | `normalizeWorktreePath(header.cwd)` |
| `resumeCwd` | `header.cwd` when it differs from `projectPath` |
| `isSidechain` | `false` |
| `ompSettings` | `{ model?: last model_change.model, thinkingLevel?: last thinking_level_change.thinkingLevel }` from the tail, else from the head (both are written at session start, P9 layout) |

6. **Exclusions**: files without any user message; archived ids (`sessions-index.ts:1110-1113`). Branch results (`header.parentSession`) are listed, as Codex leaves the source thread listed after a rewind. Bridge helper processes never create files (§6.3, §7.1, §8.1 use `--no-session` or an existing file).

Wiring (WP2): `getAllRecentSessions` (`sessions-index.ts:910-1190`) gets a third loader. The gates become positive per provider (`providers.includes("claude")` etc.) instead of `provider !== "codex"` / `provider !== "claude"` (`sessions-index.ts:920-921`), and the filter accepts the new `providers?: Provider[]` (§9.2) next to the single `provider`. Dedupe uses `provider:sessionId` keys. `listRecentSessions` (`websocket.ts:8569-8598`) gets an explicit omp branch using `listWorkspaceFilteredIndexedSessions`, so an omp request never merges Codex sessions. `enrichRecentSessionWorkspace` (`websocket.ts:8731`) accepts `"omp"`. `resolve_session_link` (`websocket.ts:4935-4983`) passes `provider:"omp"` through.

The module keeps `sessionId → file path` from scans; `findOmpSessionFile(sessionId)` falls back to a bucket scan for `*_<sessionId>.jsonl`.

### 6.2 History conversion (D8)

`getOmpSessionHistory(file, { untilEntryId?, limits? }) → Promise<{ messages: SessionHistoryMessage[]; lastEntryId: string | null }>` (`SessionHistoryMessage`: `sessions-index.ts:1946-1970`; implemented as `OmpSessionHistoryMessage[]`, §15.1). `messages` becomes `SessionInfo.pastMessages` and is served by the generic `past_history` path (`websocket.ts:4873-4889`, `splitPastHistoryMessages` `:1837-1884`). `lastEntryId` (the last entry in file order) seeds the uuid backfill cursor (§6.6). `limits` overrides the bounding constants for tests.

1. **Streaming read** (`fs.createReadStream`, LF split, per-line limit 64 Mi code units; a longer line becomes an "[omitted line]" marker). No whole-file string: the failure mode fixed for Codex in `docs/codex-large-history.md`.
2. **Tree**: skip the title slot and header; keep `Map<id, {parentId, compactEntry}>`, compacting at read time (step 5). Leaf = last entry in file order (SOURCE `session-manager.ts:3168-3170`; omp's own fallback, `docs/session.md:457-461`); walk `parentId` to the root with a visited set, then reverse. With `untilEntryId` the path is cut before that entry (validation, §6.6).
3. **Entries on the path**:

| Entry | History output |
|---|---|
| `message` role `user` (content a string or blocks; `synthetic` unset) | `{role:"user", uuid:"omp:entry:<id>", timestamp, content: text, imageCount?, ompImages?}` |
| `message` role `user` with `synthetic:true`, role `developer` | skipped (injected context) |
| `message` role `assistant` | `{role:"assistant", timestamp, content:[text / thinking / tool_use]}` with the §3.2–§3.3 mapping; `todo` uses the `details.phases` of its paired `toolResult` (by `toolCallId` on the path); `stopReason:"error"` with empty content → one text block `"Error: <errorMessage>"` |
| `message` role `toolResult` | `{role:"tool_result", toolUseId: toolCallId, toolName: canonical, content: text (edit → unified diff), ompImages?}` |
| `message` role `bashExecution` / `pythonExecution` | an assistant `tool_use` (`Bash {command}` / `eval {code}`) plus its `tool_result`, ids `omp:entry:<id>` (user-run commands, OBSERVED P8) |
| `custom_message` with `display:true`, `attribution:"user"` | `{role:"user", timestamp, content}` without uuid (skill invocations persist this way, SOURCE `rpc-mode.ts:174-181`; not a `branch` target) |
| `custom_message` with `display:true`, other attribution | assistant text block |
| `custom_message` with `display:false`, `custom` (`tool_execution_start`, `session_exit`, …) | skipped |
| `model_change`, `thinking_level_change`, `title_change`, `mode_change`, `service_tier_change`, `model_usage`, `label`, `ttsr_injection`, `credential_pin`, `session_init`, `reset_boundary`, `branch_summary` | skipped (metadata; omp restores model and thinking itself, OBSERVED P8) |
| `compaction` | skipped; the pre-compaction messages stay on the path, as omp's full transcript (`docs/session.md:453`) |

4. **Images** are never inlined into `pastMessages`. Each image block becomes an `ompImages` item `{blob: "<64 hex>", mimeType}` when `data` is `blob:sha256:<hex>` with `<hex>` matching `^[0-9a-f]{64}$` (no path traversal); inline base64 blocks and anything over the budget (4 images per message, 8 MiB decoded each) only count in `imageCount`. At `get_history` time, `registerPastUserMessageImages` / `registerPastToolResultImages` (`websocket.ts:2432-2548`) get an omp branch that reads `<agentDir>/blobs/<hex>` (decoded bytes, DOCUMENTED `docs/blob-artifact-architecture.md`; files above the image store's 10 MB limit are skipped) and registers it with `imageStore.registerFromBase64`, the same point where Claude and Codex register past images. `ompImages` is removed from the message sent to the client. Images that only count are loaded lazily by `get_message_images` (`websocket.ts:5942-5972`): `extractMessageImages` routes `omp:entry:` uuids to `extractOmpMessageImages(sessionId, uuid)`, which stream-scans the file for that entry. For omp user messages without `ompImages` and without a count, the omp branch skips the Claude/Codex store scan (`sessions-index.ts:2894-2910`). Reason: `splitPastHistoryMessages` spreads the whole message (`{...msg, images}`, `websocket.ts:1846-1856`), so inline base64 would be resent with every `past_history` (bridge review B11).
5. **Bounding** (constants of `codex-history.ts:3-4`, `docs/codex-large-history.md`): a tool item above 256 Ki code units has its strings cut to 16 Ki with `"[Truncated in Bridge history]"`; nesting deeper than 20 levels is replaced by a note; total retained display data is capped at 64 Mi code units, above which the load fails with `omp_history_too_large` (Codex policy: no silent loss of whole turns). Implemented in `omp-history.ts` with the same constants, because `compactCodexHistoryItem` accepts only Codex item types (`codex-history.ts:8-11`).

### 6.3 Names and rename (D9)

- **Read**: `getOmpSessionName(sessionId)` = the listing's `name` rule. `loadAndSetSessionName` (`websocket.ts:8123-8142`) gets an omp branch.
- **Running session**: `handleRenameSession` (`websocket.ts:8150-8212`) resolves the target first by Bridge id, then by omp session id among live omp sessions. A live match → `OmpProcess.setSessionName(name)` → RPC `set_session_name {name}` (OBSERVED P7/V1: `title_change {source:"user"}` plus the title slot, no event frame). This also covers renaming a live session from the recent list (bridge review B7).
- **Recent session** (no live process): `renameOmpRecentSession` awaits `ompWriters.waitForRelease(file)`, registers itself as the writer (§6.7; implemented as one `acquire`, §15.1), then runs `omp --mode rpc --cwd <header.cwd or projectPath> --allow-home --approval-mode always-ask --no-skills --no-extensions --no-rules --no-lsp --resume <file>`: handshake, `set_session_name`, close stdin, wait for exit (20 s, then `SIGTERM`). OBSERVED V4: 4.7 s, exit 0, `title_change` + `session_exit` appended. The file then moves to the top of the list, as a Claude rename does.
- **Clearing a name** (`name: null`) is unsupported: omp rejects an empty name ("Session name cannot be empty", OBSERVED V1). The Bridge answers `rename_result {success:false, error:"omp session names cannot be cleared"}`; the app hides "clear" for omp and shows `ompNameCannotBeCleared` on that result (§10.2).
- **Names set inside omp** (`/rename`) arrive as `session_info_update {title}`; `OmpProcess` emits `session_name`, `SessionManager` stores it and calls `onSessionUpdated`.
- **Rename before the file exists**: omp keeps the name in memory and writes the slot when the file materializes (DOCUMENTED `docs/session.md:486-487`). Covered by the live E2E (§11.3); OBSERVED there for v18.3.2 (step 2b, §15.6).

### 6.4 Resume

`resume_session` (`websocket.ts:5310-5914`) gets an explicit omp branch. It follows the Codex branch's readiness rule (`websocket.ts:5570-5595`: `session_created` only after `waitUntilReady()`), because omp start-up can fail after `create` (bad model, missing file, protocol mismatch; OBSERVED P12a exits 1 before `ready`), and a completed resume operation is replayed for 30 s (`websocket.ts:173`, `:7893-7946`).

1. `beginResumeOperation`; the fingerprint (`resumeRequestFingerprint`, `websocket.ts:7832-7858`) gains `thinkingLevel`.
2. `file = findOmpSessionFile(msg.sessionId)`; missing → `failResumeOperation` + `error {errorCode:"omp_session_not_found"}`.
3. **Already open**: a live Bridge session with `provider:"omp"` and `claudeSessionId === msg.sessionId` exists (implemented: its child must be alive; what counts as "edited", §15.2).
   - Plain resume (no `model`, `thinkingLevel` or `executionMode` different from the live session's) → attach: `completeResumeOperation` with a `session_created` built for the existing Bridge session (`buildSessionCreatedMessage`), no new process. The app opens the running session.
   - Edited resume → `failResumeOperation` + `error {errorCode:"omp_session_already_open", message:"Stop the running session before resuming it with other settings."}`.
4. `recordedCwd = header.cwd`. **cwd rule**: OBSERVED P8: omp uses the recorded cwd whenever it exists, even with `--cwd`; if it no longer exists it uses the launch cwd and keeps the old path in the header. So `--cwd recordedCwd` when it exists (also the Bridge's effective cwd); otherwise the worktree or project path of step 5 and the tip `omp_cwd_missing`. `isPathAllowed` applies to the directory actually used.
5. Worktree: `worktreeStore.get(sessionId)` → reuse if it exists, else recreate on the same branch (as `websocket.ts:5729-5751`).
6. **Sanitize the request** (all clients; old apps send Claude fields for every non-Codex provider, `session_resume_coordinator.dart:159-237`, and the new app must not depend on the Bridge accepting junk):
   - `model` → kept only if it equals a selector in the model cache (awaiting the in-flight refresh when the cache was never loaded, at most 15 s); otherwise dropped with tip `omp_model_ignored` (OBSERVED WC1: Claude model names become Bedrock models or exit 1).
   - `thinkingLevel` → kept only if it is in `OMP_THINKING_LEVELS` and offered by the effective model (the kept `model`, else the file's `ompSettings.model`); otherwise dropped. Implemented: kept without a known effective model (§15.2).
   - `executionMode` from `executionMode`, else from `permissionMode` via `deriveExecutionMode` with Claude semantics; `plan`/`auto` → `default` with tip `omp_mode_mapped` (never a failure). Implemented: the tip also when a valid `executionMode` comes with `planMode:true` or `permissionMode` `plan`/`auto` (§15.2).
   - `effort`, `sandboxMode`, `planMode`, Claude advanced options, Codex fields: ignored. `planMode` in `session_created` is always `false` (overriding `derivePlanMode`, `websocket.ts:2882-2885`, `:5431-5434`), and the client's `sandboxMode` is not echoed (`websocket.ts:3054-3056`).
7. `{ messages: pastMessages, lastEntryId } = await getOmpSessionHistory(file)`; `omp_history_too_large` → fail as in step 2.
8. `sessionManager.create(msg.projectPath, {autoRename:false}, pastMessages, worktreeOpts, "omp", undefined, { ompOptions: { cwd: <step 4 choice>, resumeSessionFile: file, resumeSessionId: msg.sessionId, entryCursor: lastEntryId, executionMode, model?, thinkingLevel?, additionalDirectories } })`. `msg.projectPath` is the recent entry's `resumeCwd ?? projectPath` (research `app-core.md` §2.3), so with the worktree mapping of step 5 the effective cwd of `SessionManager.create` (`session.ts:385`) equals `recordedCwd` in the normal case; a mismatch is logged, and `ompOptions.cwd` decides omp's `--cwd`. `create()` sets `claudeSessionId = resumeSessionId` and calls `saveWorktreeMapping` before `start()`, so `past_history.claudeSessionId` (`websocket.ts:4881`, `:5052`), `get_message_images` (`:5943`), `resolve_session_link` (`:4937-4944`) and `workspaceForRuntimeSession` (`:8783-8791`) see the omp id immediately (today they only get it from `system/init`, `session.ts:410-412`, `:812-814`). `model`/`thinkingLevel` are passed only when kept in step 6; a plain resume lets omp restore both from the file (OBSERVED P8).
9. `await waitUntilReady()`. Rejection → `destroySession`, `failResumeOperation`, `error {errorCode: <the rejection code: omp_start_failed | omp_cli_not_found | omp_protocol_unsupported | omp_unsupported_platform>}`.
10. `completeResumeOperation` with `session_created {provider:"omp", claudeSessionId: <omp id>, model, thinkingLevel, executionMode, permissionMode, planMode:false}`; `loadAndSetSessionName`; `broadcastSessionList`; queued tips.

Input sent for an omp session before its `session_created` is not buffered (the Claude-only buffer at `websocket.ts:3136-3141`, `:7935-7937` stays Claude-only): the app sends input only after `session_created`, as for Codex. The debug-bundle resume message (`websocket.ts:10285-10326`) gets the omp fields (`provider`, `executionMode`, `model`, `thinkingLevel`).

### 6.5 Archive

omp has no archive over RPC. `archive_session {provider:"omp"}` records the Bridge marker in `~/.ccpocket/archived-sessions.json` only (`archive-store.ts`), like Claude; the listing filters it. The `provider` literal in `archive-store.ts:8`, `:57` and the validation at `parser.ts:2156-2159` accept `"omp"`.

### 6.6 Rewind and fork (D21)

**User message uuids.** History messages carry `omp:entry:<entryId>` (§6.2). Live user messages are appended by the Bridge without a uuid and marked as awaiting one (§5.1, §5.2, §5.3). On every transition into `idle` (§2.5) `OmpProcess` sends `get_entries {since: cursor}` (SOURCE `rpc-mode.ts:1321-1335`, `rpc-compat.ts:14-23`: the entries after `since` in file order plus `leafId`) and advances `cursor` to the last returned entry. The initial cursor is `entryCursor` from the history load (resume, rewind), or none for a new session (the first call then returns only this session's entries). From the returned entries it computes the new user entries on the active path: walk `parentId` from `leafId` through the returned entries, keep `message` entries with `role:"user"` (not `synthetic`, `attribution` absent or `"user"`) in file order, and emit `user_entries [{entryId, text}]`.

`SessionManager.backfillOmpUserUuids(session, entries)` assigns them to the session's `user_input` history entries that await an omp id, **monotonically**: each entry id goes to the first awaiting `user_input` after the previously assigned one whose text equals the entry text; an id that is already assigned or present in `pastMessages` is never used; a `user_input` without a match stays uuid-less (for example a prompt that omp expanded, `expandPromptTemplate`, SOURCE `agent-session.ts:7511`). Each assignment re-broadcasts the entry so the app updates `UserChatEntry.messageUuid`. Why not `get_branch_messages`: it lists every user entry in the file, including abandoned in-file branches (SOURCE `agent-session.ts:11108-11123`; OBSERVED V4: active path ONE → SIDE returned ONE, TWO, SIDE), so a live "yes" could get the id of an earlier "yes" and rewind would cut at the wrong turn. `get_entries` returns `unknown_since` if the cursor vanished (SOURCE `rpc-compat.ts:21`); the Bridge then stops the backfill for this process and logs it (live messages stay non-rewindable until the next resume).

The Claude disk backfill (`backfillUserUuidsFromDisk`, run after every `result`, `session.ts:688-690`, scanning `~/.claude/projects/*`, `:1812-1842`) is gated to `provider === "claude"`.

**Rewind** (`rewind {mode:"conversation", targetUuid}`, handler `websocket.ts:7321-7464`) gets `rewindOmpConversation`, shaped like `rewindCodexConversation` (`websocket.ts:1562-1715`), which also forks inside the running process before it replaces the Bridge session:

1. `mode` must be `conversation`; `code`/`both` fail with "omp only supports conversation rewind". `rewind_dry_run` answers `canRewind:false` with the same reason for those modes.
2. Preconditions: `OmpProcess` alive and idle, no open dialog, no queued input, `targetUuid` = `omp:entry:<id>`, `sessionFile` exists.
3. Validate without side effects: `getOmpSessionHistory(sessionFile, {untilEntryId: id})` must find `id` as a user entry on the active path; else `rewind_result {success:false, error:"Invalid omp rewind target"}`.
4. `await ompProc.branch(id)` → RPC `branch {entryId}`, then `get_state` for the new `sessionFile`/`sessionId`. SOURCE `agent-session.ts:10429-10500`, `session-manager.ts:3223-3290`: `branch` writes the new file immediately (`#rewriteSynchronously`) with `parentSession`, the kept path, the session title, and preserved entry ids, cancels the process's own async jobs, and switches the process to it (OBSERVED V4: file exists right after `branch`). For a target without a parent entry omp starts a fresh lazy session instead (`newSession`, `:10482-10486`), which has no file yet. Failure or `cancelled:true` (an extension vetoed) → `rewind_result {success:false, error}`; the Bridge session is unchanged.
5. Capture `projectPath`, worktree options, workspace (`workspaceForRuntimeSession`), `session.name`, and the omp settings. `destroySession(old)`; the old child's dispose appends `session_exit` to the branched file.
6. Branched file exists → `{messages, lastEntryId} = await getOmpSessionHistory(newFile)`, then `create(…, "omp", undefined, {ompOptions: {resumeSessionFile: newFile, resumeSessionId: newId, entryCursor: lastEntryId, executionMode, additionalDirectories}})`; the spawn waits for the old child's exit (§6.7). No file (root target) → `create` without `resumeSessionFile`, with the current `model`/`thinkingLevel` passed explicitly, and `setSessionName(name)` after the handshake when a name existed. Then `attachWorkspaceToRuntimeSession(newId, workspace)` (as Codex, `websocket.ts:1664`, `:1693`) and `session.name = name`.
7. `await waitUntilReady()`. Rejection → `destroySession(new)`, `rewind_result {success:false, error:"omp could not reopen the rewound session: <message>"}`. The old Bridge session is already gone; the branched file is listed under recent sessions and can be resumed (§13.2 risk 3).
8. `rewind_result {success:true}`, `session_created {sourceSessionId: old}`, `sendSessionList`. The app's follow-the-new-session flow and the Codex rewind dialog put the rewound text into the composer (`features/codex_session/widgets/codex_rewind_dialog.dart`, research `app-features.md` §4).

Why a new Bridge session: the existing rewind flow of Claude (`session.ts:1639-1690`) and Codex replaces the Bridge session (new id, `session_created {sourceSessionId}`), and there is no machinery to move a live process between Bridge sessions. Branching in the running process first keeps a failed branch free of side effects, and the registry keeps one writer per file (§6.7).

**Fork at a message** (Codex-only action, `features/chat_session/widgets/chat_message_list.dart:636-641`): unsupported in v1. Keeping the original session alive next to a branched one needs two processes, and `--fork <path>` copies the whole session without a cut point (DOCUMENTED `docs/session-operations-export-share-fork-resume.md` "CLI --fork"). The `fork` handler (`websocket.ts:7466`) answers omp with an error; the app hides the action. `approve.clearContext` (`websocket.ts:4628-4686`, which would recreate the session as an `SdkProcess`) is rejected for omp with `omp_mode_unsupported`.

### 6.7 One writer per session file

omp writes a session file with an expected-size check and no cross-process lock (SOURCE `session-manager.ts` `#rewriteSynchronously`). The Bridge itself could start a second writer: `resume_session` has no live-session check (`websocket.ts:5310-5453`), a recent-list rename of a live session would spawn a rename process (`websocket.ts:8157`, `:8189-8212`), and `stop_session` returns while the old child still disposes for up to 10 s (§2.6).

`omp-writers.ts` (WP1) keeps a Bridge-wide registry `sessionFile → { owner: string; sessionId: string; exited: Promise<void> }`:

- `OmpProcess` registers its `sessionFile` after the handshake and after `branch`/respawn (with `owner = bridgeSessionId`; a `branch` moves the registration from the old file to the new one), and releases it when the child exits.
- `renameOmpRecentSession` registers for the lifetime of its short process.
- `waitForRelease(file, timeoutMs = 15000)` resolves when no owner holds the file; on timeout it rejects with `omp_session_busy`.
- `ownerBySessionId(ompSessionId)` serves the live checks of §6.3 and §6.4.
- Implemented additionally: `acquire` (wait and reserve in one step), `release` and `files()`; `register` remains for files known only after the handshake (§15.1).

Every spawn with `--resume <file>` (resume, respawn, rewind, rename) awaits `waitForRelease` first (§2.4 step 1; implemented as `acquire`, §15.1). Writers outside the Bridge (the user's own terminal `omp`) are not visible; see §13.2 risk 3.

## 7. Models, thinking and approval mode at runtime

### 7.1 Model catalogue (D12)

Source: `omp models --json` (helper `listOmpModels` in `omp-sessions.ts`, WP1), not a short-lived RPC process. OBSERVED P10: `{models:[{provider, kind, id, selector, name, contextWindow, maxTokens, reasoning, thinking, input, cost}]}`, the same pairs as RPC `get_available_models`, with a ready `selector` and `thinking: string[] | null`. OBSERVED V5 with extensions enabled (as the Bridge runs it): 214 models in 1.46 s, `selector === provider + "/" + id` for all, no provider contains `/`.

- Invocation: `spawn(bin, ["models", "--json"], {cwd: homedir(), env: sanitized})`, stdin ignored, 15 s timeout, 8 MiB output cap.
- Thinking levels per model: `["off", ...thinking].filter(l => OMP_THINKING_LEVELS.includes(l))`, or `["off"]` for `thinking: null`. The filter keeps the list inside what the Bridge parser accepts; omp's effort list can grow (SOURCE agent `thinking.ts:8-17`).
- Wire shape `OmpModelInfo`: `{selector, provider, name, thinkingLevels, input}`.
- Availability: `ompAvailability: "available" | "not_installed" | "no_models"` (`not_installed` = spawn `ENOENT`; `no_models` = exit 0 with an empty list, i.e. no provider credentials, or a non-zero exit).
- Cache in `BridgeWebSocketServer`: `ompModels`, `ompAvailability`, `ompModelsRevision` (increments when either changes), one in-flight request shared by callers (pattern of `codexMetadataRequest`, `websocket.ts:830`). Refresh on client connect inside `refreshConnectionMetadata` (`websocket.ts:2747-2760`), after an omp start or resume (next to `websocket.ts:3082-3086`), and when a session reports a selector that is not cached. A failed refresh keeps the previous list.
- Delivery: `session_list` fields `ompModels`, `ompAvailability`, `ompModelsRevision`, only to clients that declared omp support (§9.5), and only after the first refresh finished (before that the fields are absent, so the app shows "loading", not "not detected"). The per-client `sendSessionList` (`websocket.ts:8228-8253`) always includes them; `broadcastSessionList` (`:8271-8296`, 24 call sites) only when the revision changed since its previous broadcast, because the 214 models serialize to 33,761 bytes. The app keeps its cache when the fields are absent (§10.2). When the first refresh finishes, each declared client gets a `sendSessionList`.
- No `defaultOmpModel`: omp's default comes from user config; a session started without `--model` reports its model in `system/init`, and the new-session sheet offers "omp default" (§10.2).

### 7.2 Model and thinking level in a running session

Client message (§9): `{type:"set_omp_model", sessionId, model?: string, thinkingLevel?: OmpThinkingLevel}`, at least one field.

Bridge validation before `OmpProcess`: `model` must be a cached selector and `thinkingLevel` must be offered by the target model; otherwise `error {errorCode:"set_omp_model_failed", message}` without touching the process. A session whose child has exited (§2.6) gets the same error at once, before the catalogue check and without the `omp_change_deferred` tip, since no later turn applies the change. A non-omp session → `set_omp_model_unsupported`.

`OmpProcess.setModelSettings({model?, thinkingLevel?})`:

1. Queued in the outbox while `starting` (§2.3) and kept pending while not idle (the websocket handler sends the tip `omp_change_deferred` when it forwards a change while `isWaitingForInput` is false); applied at the next transition into `idle`, before the queue drains. omp's behaviour for `set_model` during a run was not probed, and applying between runs gives the "next turn" semantics of `set_codex_model`. A newer request replaces a pending one.
2. `model` → `set_model {provider, modelId}` with `provider` = the part before the first `/` and `modelId` the rest (`zai-org/GLM-5.3-Fast` contains a slash). OBSERVED P7: returns the full `Model` and emits `model_changed` (which the Bridge then ignores, §3.1). OBSERVED P12c: unknown model → `success:false` "Model not found: …", current model kept → `error {errorCode:"set_omp_model_failed"}`.
3. After a model change `set_thinking_level` is always sent, because the level disappears for a non-reasoning model and stays absent after switching back (OBSERVED P10/V5). Target = requested level, else the previous level; if the new model does not offer it, the highest non-`off` level of a reasoning model, else `off`.
4. The resulting `thinking_level_changed` gives the level actually applied (OBSERVED V1: omp maps silently); the Bridge emits `system/omp_settings` with the model from the `set_model` response and that level. No `get_state` (it carries the full system prompt and tool schemas, §2.4), except once after a partial failure (§15.1).

Persistence: only the session file (`model_change`, `thinking_level_change`); `config.yml` stays untouched (OBSERVED P7). A resumed session restores both (OBSERVED P8).

Compatibility: an old Bridge answers `unsupported_message`; the app lists `set_omp_model` in `_unsupportedActions` with the update hint, like `set_codex_model` (`services/chat_message_handler.dart:141-179`). The app does not send it at all without `provider_omp_v1` (§9.5).

### 7.3 Approval mode (D2)

Mapping: `executionMode` `default` → `always-ask`, `acceptEdits` → `write`, `fullAccess` → `yolo`. `executionMode` is derived with Claude semantics (`deriveExecutionMode`, `websocket.ts:511-533`); omp call sites pass `provider:"omp"`. Legacy `permissionMode`: `default`, `acceptEdits`, `bypassPermissions` (`modesToLegacyPermissionMode`, `websocket.ts:547-563`). `set_permission_mode` with `plan` or `auto` → `error {errorCode:"omp_mode_unsupported"}`, mode unchanged. (Start and resume map them to `default` instead, §6.4.)

What `write` means in omp (DOCUMENTED `docs/approval-mode.md` "Modes"; SOURCE `tools/approval.ts:183-185`, `:260-320`): every tool up to the write tier runs unprompted, including MCP server tools (they declare `write`) and bash commands matching the user's `bash.patterns` allow rules; shell and eval commands otherwise ask. User `tools.approval.<tool>: allow` rules apply in every mode. This is broader than Claude's acceptEdits, so the app labels it separately (§10.4).

omp has no RPC command to change the approval mode (OBSERVED V1: "Unknown command: set_approval_mode"). `set_permission_mode` for an omp session calls `OmpProcess.setApprovalMode(mode)`:

1. Unchanged mode → no-op, `{applied:"now"}`.
2. Not (`idle` and `settled`) → kept pending (a newer request replaces it), `{applied:"deferred"}`; applied at the next moment both hold. `settled` is required because the respawn ends omp's background jobs (§2.6); a job that never ends (a dev server) keeps the change pending until the user stops the session (§13.2 risk 11). Codex restarts a busy session at once (`websocket.ts:3855`), which aborts the turn; D2 limits the omp respawn to idle.
3. Apply → respawn inside the same Bridge session: `lifecycle` becomes `starting`, open dialogs are resolved, stdin is closed as in `stop()` steps 4–6 but without emitting `exit`, the old child's `exited` is awaited, then the child is spawned with the new `--approval-mode` and `--resume <sessionFile>` if that file exists (the spawn waits for the registry, §6.7). If it does not exist yet (no assistant message so far), spawn without `--resume` but with the current `--model`/`--thinking`; nothing was persisted, the new omp session id arrives through `system/init`, and the backfill cursor resets.
4. After the handshake: `system {subtype:"set_permission_mode", sessionId, permissionMode, executionMode}` (the message the Codex in-place path broadcasts, `websocket.ts:3819-3829`) and `broadcastSessionList()`. A failed respawn → `error {errorCode:"omp_respawn_failed", message}` with the stderr tail, then as an unexpected exit (§2.6).

The Bridge session id stays the same, so the app keeps its screen; input sent during the respawn is queued (§5.2). The approve-always list survives (§4.2). A deferred change (`{applied:"deferred"}`) is announced by the websocket handler with the tip `omp_change_deferred` (only the Bridge knows `settled`), and `system/set_permission_mode` follows when it is applied.

`set_sandbox_mode` for omp → `error {errorCode:"omp_sandbox_unsupported"}`.

## 8. Periphery

### 8.0 Shared helpers (WP1)

- `resolveOmpBin(env)`: `BRIDGE_OMP_BIN` or `"omp"`.
- `resolveOmpStore(env)`: `{ root, agentDir, sessionsDir, flatSessionDir?, blobsDir }` by the rules of §6.1 (`PI_CONFIG_DIR`, `OMP_PROFILE`/`PI_PROFILE`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`). XDG relocation (`$XDG_DATA_HOME/omp`, DOCUMENTED `docs/config-usage.md:85`) is not supported in v1; doctor warns when such a directory exists.
- `sanitizedOmpEnv(env)`: §2.1 breadcrumb variables removed.
- `runOmpPrint({cwd, prompt, stdin?, model?, timeoutMs = 60000}): Promise<string>`:
  - `spawn(bin, ["-p", "--no-session", "--no-tools", "--no-skills", "--no-extensions", "--no-rules", "--no-lsp", "--no-title", "--approval-mode", "always-ask", ...(model ? ["--model", model] : []), "--thinking", "off", prompt], {cwd, env: {...sanitized, OMP_MCP_TIMEOUT_MS: "3000"}, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]})`; with `stdin`, write it and call `child.stdin.end()` at once.
  - Resolves with trimmed stdout on exit 0, once stdout and stderr are drained (§2.6); rejects with the stderr tail on a non-zero exit, and kills the child (`SIGTERM`, then `SIGKILL` after 2 s) on timeout. Output cap 1 MiB.
  - Why `spawn` and not `execFile(..., {input})`: `input` exists only for `execFileSync`/`spawnSync`; async `execFile` leaves the child's stdin open (checked by the omp review: `execFile("cat", {input:"hello", timeout:1500})` was killed with empty stdout), and `omp -p` reads a non-TTY stdin until EOF (SOURCE `main.ts:239-259`; OBSERVED V6: still blocked after 20 s with an open pipe, exit 0 in 7.85 s with stdin closed). A synchronous variant would block the Bridge event loop, and every session's stdout reader with it, for 3–8 s per call.
  - Why `--approval-mode always-ask`: `--no-tools` disables built-in tools only (`omp --help`), MCP server tools still load (OBSERVED P11c), and the user's default mode is `yolo` (SOURCE `tools/settings.ts:290-295`). Print mode has no UI, so under `always-ask` every write- or exec-tier call fails closed (SOURCE `extensibility/extensions/wrapper.ts:315-330`), and MCP tools declare the write tier (DOCUMENTED `docs/approval-mode.md:12`). Auto-rename feeds transcripts that may contain untrusted text; without this flag injected instructions could make the helper call MCP tools unattended. Verified from source only (§13.2 risk 1).
  - Why every `@` in the prompt and stdin gets a U+2060 WORD JOINER in front: omp reads each file or directory named as `@path` in the first message (stdin plus prompt) into the model context before the first turn, with no tool call and no approval, so neither `--no-tools` nor `always-ask` covers it (SOURCE `utils/file-mentions.ts` in the v18.3.2 binary: a mention counts at the start or after whitespace, a bracket or a quote). A staged diff that mentions `@.env` would send the gitignored file to the provider (OBSERVED with a staged README line naming `@.env`: 2 `fileMention` messages carrying the file content without the guard, 0 with it). The joiner is invisible and not accepted before a mention; `runOmpPrint` removes it from the answer, so a copied mention does not carry it into a commit message or title.
  - OBSERVED P11: stdout holds only the answer plus `\n`, stderr `Working...`, exit 0 in 2.7–4.1 s; stdin is combined with the prompt argument (P11b); an unknown model exits 1 with the reason on stderr (P11f). `OMP_MCP_TIMEOUT_MS=3000` caps the wait for MCP servers (default 30 s, DOCUMENTED `docs/mcp-config.md:112`).
- Assist model: `BRIDGE_OMP_ASSIST_MODEL` if set, else the session's current model selector (mirrors `BRIDGE_CODEX_ASSIST_MODEL`, `codex-assist.ts:1-25`); `--thinking off` keeps the call fast (OBSERVED P11d).
- `jsonl-partial.ts`: `decodeJsonStringPrefix(fragment)`, moved out of `sessions-index.ts:289-299` so the Codex and omp listers share one implementation (§6.1).

### 8.1 Auto-rename (D10)

- `generateAutoRenameName` (`auto-rename.ts:104-122`) becomes `async` and returns `Promise<string | null>` for every provider (Claude and Codex keep their synchronous `execFileSync` bodies, now inside the async function); the omp branch is `await runOmpPrint({cwd: projectPath, prompt: buildAutoRenamePrompt(transcript), model})`, then `sanitizeAutoRenameName`. Today every non-Codex provider runs `claude -p`.
- `SessionManager.autoRenameSession` (`session.ts:1351-1373`) awaits it, passes `session.ompSettings.model` for omp, and `persistSessionName` (`session.ts:1375-1403`) calls `OmpProcess.setSessionName(name)` for omp (today it returns `false` for other providers and drops the name). When the child has exited or is stopping by the time the name arrives (stop, crash, idle eviction during the 3–8 s `omp -p` run), it writes the name through `renameOmpRecentSession` (§6.3) instead, as the Codex branch falls back to `renameCodexSession`.
- `autoRename` is set only for new sessions; `create()` also clears it when `ompOptions.resumeSessionFile` is present, next to the checks at `session.ts:403-408`.
- App: setting `autoRenameOmpSessions`, default `true` (RPC disables omp's own titles).

### 8.2 Git commit message assist

`generateCommitMessage` (`git-assist.ts:20-53`) becomes `async` (`Promise<string>`) for every provider; the omp branch is `await runOmpPrint({cwd, prompt: COMMIT_MESSAGE_PROMPT, stdin: diff, model})`, first non-empty line as the message (OBSERVED P11b). The caller (`websocket.ts:6895-6916`, today a synchronous IIFE) awaits it and passes `session.ompSettings.model` for omp instead of falling through to `codexSettings.model`. `omp commit` is not used: it also updates changelogs (research `bridge-periphery.md` §11).

### 8.3 Usage

- **Per session**: `result` carries `cost`, `duration`, tokens, `toolCalls`, `fileEdits` (§3.4), so the usage bar Claude uses (`UsageSummaryBar`, research `app-features.md` §4) works for omp.
- **Account usage / rate limits**: out of scope. `omp usage --json` returned `reports: []` on this machine, so the schema is unverified, and omp is multi-provider/multi-account, which does not fit `UsageInfo {provider, fiveHour, sevenDay}` (`usage.ts:6-16`). `fetchAllUsage` (`usage.ts:129-135`) stays unchanged.

### 8.4 Doctor

`checkCliProviders` (`doctor.ts:113-240`) gets a third block:

- installed/version: `<bin> --version` (prints `omp/18.3.2`, OBSERVED); below 18.3.2 → `warn` "untested omp version; RPC v2 is negotiated at start".
- authenticated: `listOmpModels()` returns at least one model ("N models from M providers"); empty → not authenticated, remediation "Run omp and log in (/login), or set a provider API key".
- store: the resolved `agentDir` and session directory, the active profile, and warnings for an XDG data directory, a `PI_CODING_AGENT_SESSION_DIR` override, and any live omp session whose `sessionFile` lies outside the resolved session directory (the listing would miss it).
- The "none installed" remediation (`doctor.ts:219-230`) and the function comment name all three CLIs.

### 8.5 Push notifications

- Data already carries `provider: session.provider` (`websocket.ts:9395-9400`, `:9485-9491`). Goal pushes (`:9449-9469`, hard-coded `"codex"`) cannot occur for omp.
- `ask_default_body` is "Claude is asking a question" in all four locales (`push-i18n.ts:15`, `:37`, `:59`, `:81`) and is used for every provider. It becomes `"{agent} is asking a question"` (ja `{agent} が質問しています`, zh `{agent} 正在提问`, ko `{agent}이(가) 질문하고 있습니다`), `agent` = `Claude` / `Codex` / `omp`.
- The completion push formats `duration` as seconds without dividing (`` `${msg.duration.toFixed(1)}s` ``, `websocket.ts:9480`), while Claude reports milliseconds (`sdk-process.ts:580`), omp does too (§3.4), Codex sends no `duration`, and the app divides by 1000 (`widgets/bubbles/result_chip.dart:35-36`). It becomes `(msg.duration / 1000).toFixed(1)`. This also corrects Claude pushes, which show "12345.0s" today; the fix is at the single shared line.
- iOS stays on the existing Firebase path (lead fact).

### 8.6 Setup, CLI help

- `setup-systemd.ts:97-180` and `setup-launchd.ts:48-155` persist `BRIDGE_OMP_BIN`, `BRIDGE_OMP_ASSIST_MODEL`, `OMP_PROFILE`, `PI_PROFILE`, `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` when set, next to `BRIDGE_CODEX_ASSIST_MODEL` (`setup-systemd.ts:105`, `:170`; `setup-launchd.ts:56`, `:135`). The omp store must match between the user's shell and the service, or the Bridge lists a different store. `PATH` already contains `~/.local/bin` under systemd (`setup-systemd.ts:80`, `:94`); launchd uses a login shell (`setup-launchd.ts:169-172`).
- `cli.ts:15-56` help: `BRIDGE_OMP_BIN` ("path to the omp CLI, default: omp on PATH"), `BRIDGE_OMP_ASSIST_MODEL`, and the extended "setup persists" list.
- No new CLI flags (`cli-args.ts:1-16` unchanged).

### 8.7 Other Bridge files

- `workspace-store.ts:7`, `:85`: `WorkspaceProvider` and `validAssignment` accept `"omp"` (today omp assignments would be dropped on load).
- `resume-metrics.ts:13` follows the `Provider` type.
- `protocol-version.ts`: `BRIDGE_PROTOCOL_CAPABILITIES` (§9.1). `version.ts:52-65`: `/version` adds `protocolCapabilities`.
- `index.ts`, `project-history.ts`: no change.

## 9. Wire protocol changes and compatibility

All changes are additive under protocol version 1 (`protocol-version.ts:1-3`; `docs/protocol-versioning.md` "Change policy"): optional fields, one new client command, one new `system` subtype, one capability string, and one client declaration. The new provider value `"omp"` in existing `provider` fields is **not** additive for old apps, so it is only sent to clients that declare it (§9.5).

### 9.1 Capability

`protocol-version.ts` exports `BRIDGE_PROTOCOL_CAPABILITIES = ["project_request_correlation_v1", "session_context_v1", "provider_omp_v1"] as const`. It replaces the two literal lists in `sendSessionList` and `broadcastSessionList` (`websocket.ts:8246-8249`, `:8289-8292`), is added to `/version` (`version.ts:52-65`, already fetched by the app's machine manager, `machine_manager_service.dart:850`), and is read by the contract test. `provider_omp_v1` means: this Bridge accepts `provider:"omp"` wherever a provider is accepted, `thinkingLevel`, `providers[]`, `set_omp_model`, and sends omp data to clients that declare `supportedProviders` containing `"omp"`. It is advertised even when omp is not installed; availability travels in `ompAvailability` (§7.1). `docs/protocol-versioning.md` records the capability and its deletion condition (§9.5).

### 9.2 Bridge types (`parser.ts`, `session.ts`, `sessions-index.ts`)

```ts
// parser.ts:71
export type Provider = "claude" | "codex" | "omp";
// parser.ts:1161
const PROVIDERS = ["claude", "codex", "omp"] as const;

// imported from omp-types.ts (WP1): OmpThinkingLevel, OMP_THINKING_LEVELS, OmpModelInfo, OmpSettings, OmpAvailability
//   OmpThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

// ClientMessage changes
//   client_capabilities.supportedProviders?: Provider[]            (validated: array of known providers; unknown strings ignored; implemented as string[], §15.2)
//   start / resume_session.thinkingLevel?: OmpThinkingLevel          (validated in hasValidSessionOptions, parser.ts:1228-1257)
//   list_recent_sessions.provider?: Provider                          (was "claude" | "codex", parser.ts:246)
//   list_recent_sessions.providers?: Provider[]                       (non-empty; mutually exclusive with provider)
| { type: "set_omp_model"; sessionId: string; model?: string; thinkingLevel?: OmpThinkingLevel }

// ServerMessage "system" additions (parser.ts:567-640)
//   thinkingLevel?: OmpThinkingLevel; thinkingLevels?: OmpThinkingLevel[];
//   subtype "omp_settings": {sessionId, provider:"omp", model?, thinkingLevel?, thinkingLevels}

// session_list additions
//   ompModels?: OmpModelInfo[]; ompAvailability?: "available" | "not_installed" | "no_models"; ompModelsRevision?: number

// OmpModelInfo: { selector: string; provider: string; name: string; thinkingLevels: OmpThinkingLevel[]; input: string[] }

// session.ts SessionSummary / SessionInfo, sessions-index.ts SessionIndexEntry
ompSettings?: OmpSettings;   // { model?: string; thinkingLevel?: OmpThinkingLevel }
```

Validation changes that exist only because the checks are literals today: `resolve_session_link` (`parser.ts:1589-1593`), `list_recent_sessions` (`:1644-1648`) and `archive_session` (`:2158`) use `PROVIDERS`. `set_omp_model` requires a non-empty `sessionId` and at least one of a non-empty `model` or a valid `thinkingLevel`.

### 9.3 Messages per flow

| Flow | Client → Bridge | Bridge → Client |
|---|---|---|
| capabilities | `client_capabilities {…, supportedProviders:["claude","codex","omp"]}` | a fresh `session_list` including omp data (§9.5) |
| start | `start {provider:"omp", projectPath, model?, thinkingLevel?, executionMode?, permissionMode?, additionalWritableRoots?, useWorktree?, worktreeBranch?, existingWorktreePath?, projectId?, autoRename?, requestId}` | `system {subtype:"session_created", sessionId, provider:"omp", model?, thinkingLevel?, executionMode, permissionMode, planMode:false, …}`, then `system/init {sessionId:<omp id>, provider:"omp", model, thinkingLevel, thinkingLevels, executionMode, permissionMode}` (on the wire `sessionId` is the Bridge id and the omp id travels as `claudeSessionId`, §15.3) |
| resume | `resume_session {sessionId:<omp id>, provider:"omp", projectPath, executionMode?, model?, thinkingLevel?, resumeRequestId}` | `session_created` after the handshake (§6.4), or `session_resume_failed` + `error {errorCode}`; `past_history` on `get_history` |
| model | `set_omp_model {sessionId, model?, thinkingLevel?}` | `system/omp_settings`, or `error {errorCode:"set_omp_model_failed"}` |
| mode | `set_permission_mode {sessionId, mode, executionMode}` | `system/set_permission_mode {…}` when applied, or `error {errorCode:"omp_mode_unsupported" \| "omp_respawn_failed"}` |
| metadata | – | `session_list {…, ompModels?, ompAvailability?, ompModelsRevision?}` (§7.1 presence rule) |
| recent | `list_recent_sessions {provider?:"omp" \| providers?:[…], …}` | `recent_sessions` entries with `provider:"omp"`, `ompSettings`, `resumeCwd?` |

`session_created` for omp is built by `buildSessionCreatedMessage` (`websocket.ts:1366-1560`) with an omp block next to the Codex block (`:1527-1557`: `model`, `thinkingLevel` from `session.ompSettings`, `claudeSessionId`), and explicit omp cases in the `executionMode`/`planMode` derivation (`:1451-1497`, `planMode:false`). `start` sanitizes like resume (§6.4 step 6), awaits the model cache the same way, sends `session_created` without waiting for readiness (§15.2), and emits `omp_cli_not_found` / `omp_unsupported_platform` / `omp_start_failed` as deferred `error` messages with their code plus `exit`, not as "Failed to start session: …" without a code (`websocket.ts:3121-3128`).

New `errorCode` values (on `error` messages, rendered by the app, §10.2): `omp_cli_not_found`, `omp_start_failed`, `omp_protocol_unsupported`, `omp_process_exited`, `omp_unsupported_platform`, `omp_notice` (warning style), `omp_info` (neutral style), `omp_session_not_found`, `omp_session_already_open`, `omp_session_busy`, `omp_history_too_large`, `omp_mode_unsupported`, `omp_respawn_failed`, `omp_sandbox_unsupported`, `set_omp_model_failed`, `set_omp_model_unsupported`. New tip codes (`system/tip`, `websocket.ts:1819-1834`): `omp_cwd_missing`, `omp_model_ignored`, `omp_mode_mapped`, `omp_change_deferred`.

### 9.4 App types (`apps/mobile/lib/models/messages.dart`)

```dart
enum Provider { claude('claude', 'Claude'), codex('codex', 'Codex'), omp('omp', 'omp'); … }
Provider? providerFromValue(String? raw);   // single converter replacing the ad-hoc ones (§10.2)

enum OmpThinkingLevel { off, minimal, low, medium, high, xhigh, max }   // value == name
enum OmpAvailability { available, notInstalled, noModels }              // wire: available | not_installed | no_models

class OmpModelInfo {
  final String selector, provider, name;
  final List<String> thinkingLevels;
  final List<String> input;
  factory OmpModelInfo.fromJson(Map<String, dynamic> json);
}

// SessionListMessage: List<OmpModelInfo>? ompModels; OmpAvailability? ompAvailability; int? ompModelsRevision;   (null = absent → keep cache)
// SystemMessage: String? thinkingLevel; List<String> thinkingLevels;
// RecentSession / SessionInfo: String? ompModel; String? ompThinkingLevel;   (flattened from ompSettings, like codexSettings)
// PermissionRequestMessage input: approvalDetails (List<String>) read by PermissionPresentation
// ClientMessage.clientCapabilities(..., supportedProviders: ['claude','codex','omp'])
// ClientMessage.start(..., String? thinkingLevel) / ClientMessage.resumeSession(..., String? thinkingLevel)
// ClientMessage.listRecentSessions(..., List<String>? providers)
// ClientMessage.setOmpModel(String sessionId, {String? model, String? thinkingLevel})
```

### 9.5 Compatibility

**Bridge side: omp is invisible to clients that do not declare it.** `clientSupportedProviders: Map<WebSocket, Set<Provider>>` is filled from `client_capabilities.supportedProviders` (absent → `{claude, codex}`). `prepareServerMessageForClient` (`websocket.ts:9553-9580`), which both `send` (`:9708-9713`) and `broadcast` (`:9543-9551`) already call per client, drops for an undeclared client: omp entries in `session_list.sessions` and `recent_sessions.sessions`, the fields `ompModels`/`ompAvailability`/`ompModelsRevision`, every message whose `sessionId` belongs to a live omp Bridge session (stream, status, permission, `omp_settings`, `session_created`, …), and `session_link_resolution` for omp sessions (answered as `unavailable`). The first `session_list` is sent on connect before `client_capabilities` arrives (`websocket.ts:2685`), so it treats the client as undeclared; a `client_capabilities` that declares `omp` triggers `sendSessionList(ws)` again. Requests from an undeclared client that name `provider:"omp"` get `unsupported_message`.

Reasons: old apps map unknown providers to Claude (`main.dart:470-472`, research `app-core.md` §5) and would open omp sessions in the Claude screen, resume them with a Claude model (OBSERVED WC1: switches the session to a Bedrock model or fails), copy `claude --resume <ompId>`, and start Claude from "new from recent" (`session_list_screen.dart:126`, `:1139`). Hiding is the same answer D16 gives in the other direction. Push notifications are per device, not per app version; an old app that taps an omp push gets "unavailable".

**App side: omp messages are gated once, in `BridgeService.send()`.** At the point where a message would be written to the socket (after protocol negotiation, `bridge_service.dart:1504-1513`, which is also the path of every offline-queue flush, `:1795-1812`), a message that needs omp (`start`/`resume_session`/`resolve_session_link`/`list_recent_sessions`/`archive_session`/`rename_session` with `provider:"omp"` or `providers` containing `omp`, and `set_omp_model`) is not written when the connected Bridge lacks `provider_omp_v1`. Instead:

- an offline start/resume action moves to the new `OfflinePendingActionState.bridgeUpdateRequired` (the pending card shows `ompStartNeedsBridgeUpdate` and can be cancelled); implemented as the flag `OfflinePendingAction.bridgeUpdateRequired` on an action that stays queued and is sent once a capable Bridge connects (§15.4);
- a resume emits a local `session_resume_failed` for its `resumeRequestId`, then a local `ErrorMessage(errorCode: 'bridge_update_required')`;
- a start, link resolution or other request emits a local `ErrorMessage(errorCode: 'bridge_update_required')` (`widgets/bubbles/error_bubble.dart:24`, `:49`), and a pending omp start page resolves to that error (the session list opens no pending page when it knows the gate will fire, §15.5; other request kinds also get a local failure result, §15.4).

This gate also covers Bridges up to v1.72.1, where provider validation did not exist yet (first in commit `609e406a`, tag `bridge/v1.72.2`) and `start {provider:"omp"}` would have run a Claude SDK process under an "omp" label (`git show bridge/v1.72.1:packages/bridge/src/websocket.ts:2343`, `session.ts:310`). As a second line, a `session_created` whose `provider` differs from the requested one fails the pending start (implemented for omp starts only, §15.4). Capability state is three-valued (§10.2): until the first `session_list` of a connection the app neither shows nor hides omp permanently.

| Combination | Behaviour |
|---|---|
| new app + new Bridge | full feature set |
| new app + Bridge v1.72.2 … current | no `provider_omp_v1` → the app hides the omp tab, filter and settings chip, and the `send()` gate stops omp messages. An omp deep link or push shows `bridgeUpdateRequiredForOmp` (§10.3). `set_omp_model` is also in `_unsupportedActions` (CLAUDE.md rule). |
| new app + Bridge ≤ v1.72.1 | as above; the gate prevents the Claude-under-omp-label start |
| old app + new Bridge | omp sessions, omp data and omp session traffic are invisible to that client; Claude and Codex work unchanged |

Deletion condition for these fallbacks: when the minimum supported Bridge advertises `provider_omp_v1` and the minimum supported app declares `supportedProviders` (after the next protocol version bump, `docs/protocol-versioning.md` "Protocol v2 readiness checklist").

### 9.6 Fixtures and docs

New shared fixtures under `test/fixtures/protocol/v1/` (WP0, §12); the existing four stay frozen (`protocol-contract.test.ts:11-38`):

| Fixture | Direction | Content |
|---|---|---|
| `omp-client-capabilities.json` | client | `client_capabilities` with `supportedProviders` |
| `omp-start.json` | client | `start {provider:"omp", model, thinkingLevel, executionMode}` |
| `omp-resume.json` | client | `resume_session {provider:"omp", executionMode}` (plain resume) |
| `legacy-app-omp-resume.json` | client | the exact resume payload of the current app for an omp session (Claude `model`, `effort`, `planMode`, `sandboxMode`, `permissionMode:"plan"`, `session_resume_coordinator.dart:159-237`) |
| `omp-set-model.json` | client | `set_omp_model` |
| `omp-list-recent-sessions.json` | client | `list_recent_sessions {providers:["claude","codex"]}` and a `provider:"omp"` variant |
| `omp-resolve-session-link.json`, `omp-archive-session.json` | client | the two literal checks being widened |
| `omp-session-list.json` | server | `session_list` with `provider_omp_v1`, one running omp session (`ompSettings`), `ompModels` with a reasoning and a non-reasoning model, `ompAvailability`, `ompModelsRevision: 1` |
| `omp-recent-sessions.json` | server | `recent_sessions` with one omp entry (`ompSettings`, `resumeCwd`) |
| `omp-session-created.json`, `omp-init.json`, `omp-settings.json` | server | `system/session_created`, `system/init`, `system/omp_settings` for omp |

Consumers: `packages/bridge/src/protocol-contract.test.ts` (WP2: `parseClientMessage` accepts every client fixture; the server fixtures equal what the Bridge builds for the same state (implemented as key-subset matches for most server fixtures, §15.3), including `sendSessionList` for `omp-session-list.json`; the legacy payload is parsed and a websocket test asserts that `--model` and `planMode` are dropped, §11.1) and `apps/mobile/test/protocol_contract_test.dart` (WP3: server fixtures parse into `SessionListMessage`/`RecentSession`/`SystemMessage`; `ClientMessage` builders serialize to the client fixtures). The server fixtures are also parsed once by the app from `main` (§11.4 step 0) to show that old apps would at least not crash on them.

Docs (WP2): `docs/agent-project-reference.md` (provider list, new modules, message types, env vars), `docs/protocol-versioning.md` (capability, client declaration, deletion condition), `packages/bridge/README.md` configuration table and persisted-variable list (`README.md:39-55`, `:228-236`); `packages/bridge/CHANGELOG.md` at release time.

## 10. App architecture

Paths are relative to `apps/mobile/lib/`. The app follows the Codex pattern (D17): a dedicated route, screen and cubit subclass, sharing `ChatSessionCubit`, `ChatMessageList`, `ChatInputWithOverlays`, `SessionModeBar` and the bubbles. Most provider decisions today are `isCodex` booleans or `== 'codex' ? codex : claude` ternaries, so a third value would silently get Claude behaviour (research `app-core.md` §5, `app-features.md` §8); every such site on an omp path becomes explicit. Widget-level `isCodex` parameters (`ChatMessageList` `:160`, `:187`; `MessageBubble` `:45`, `:83`, `:173`, `:232`) stay: each guards a Codex-only behaviour (fork, plan updates, `$` entities), and the omp screen passes `false`.

### 10.1 `ChatSessionCubit` (WP3)

Capability getters next to `isCodex` (`features/chat_session/state/chat_session_cubit.dart:67`), each with real call sites:

| Getter | Value | Used at |
|---|---|---|
| `isOmp` | `provider == Provider.omp` | omp branches below |
| `supportsQueuedInput` | Codex, omp | replaces `isCodex` at `:254` (restore delivery-pending), `:1371` (one queued item), `:1388-1392` (offline queue panel), `:1425`, `:1458`, `:1523`, `:1561`, `:1572` (update / steer / cancel queued input) |
| `supportsRuntimeModelChange` | Codex, omp | model chip tap target in `session_mode_bar.dart` (WP4) |
| `supportsSandboxToggle` | Claude | only the `if (!isCodex) SandboxModeChip` branch of `session_mode_bar.dart:129-150` (WP4) |

`:343` (`_applySessionContext` sandbox source) and `:2009` (`patchSessionSandboxMode`, a Codex cache) keep `isCodex`: they select the Codex data source, not a shared behaviour. Codex-only behaviours keep `isCodex`: the optimistic `codex:user-turn:N` uuid (`:1399`), `$` structured mentions (`:1378`, and `_extractCodexStructuredInputs` in `updateQueuedInput`, `:1525`, which becomes Codex-only), goals, fork.

Further cubit changes:

- Constructor (`:98-113`): omp derives `executionMode` from `initialPermissionMode` (`default`→`default`, `acceptEdits`→`acceptEdits`, `bypassPermissions`→`fullAccess`; the mapping is bijective for omp's three modes, so no new parameter), sandbox `off`, no Codex fields.
- `_applySessionContext` (`:333-420`): the provider check uses `providerFromValue`; for omp it copies `ompModel`/`ompThinkingLevel` from the context (as it copies `codexModel` today) and derives `ompThinkingLevels` from `bridge.ompModels` by selector.
- Per-session settings: omp uses the existing per-session store `claude_session_settings_<providerSessionId>` through `_SessionSettingsHelper` (`:2351-2378`), keyed by the omp session id (ids never collide across providers, each store key is the provider's own id). All existing writers already store `permissionMode`/`executionMode` (`:1777`, `:1840`, `:2064`, `:2089`); the first-id write (`:838-847`) changes from "when `claudeSessionId` is first known" to "whenever it changes" (a respawn without a file gets a new omp id, §7.3) and for omp writes `{permissionMode, executionMode}` (implemented: "whenever it changes" for omp only, §15.4). omp does not store model or thinking level: omp restores them from the session file.
- `setSessionModes` (`:1781-1846`): `legacyPermissionModeFromModes(provider, …)` with an omp case (Claude semantics); the Codex permissions triple stays Codex-only.
- `setOmpModel({String? model, String? thinkingLevel})`: optimistic state update, `BridgeService.patchSessionOmpModel`, `ClientMessage.setOmpModel`; the previous values are kept in `_pendingOmpModelRollback` and restored on `set_omp_model_failed`/`set_omp_model_unsupported`, cleared on the next `omp_settings`. (`setCodexModel`, `:1964-1992`, has no rollback; omp gets one because the Bridge validates.)
- `_isPermissionModeFailure` (`:2106-2113`) also matches `omp_mode_unsupported` and `omp_respawn_failed`, so the chip rolls back.
- `features/chat_session/state/chat_session_state.dart:11-74` (+ `chat_session_state.freezed.dart`): `ompModel`, `ompThinkingLevel`, `ompThinkingLevels`.
- New `features/omp_session/state/omp_session_cubit.dart`: `OmpSessionCubit extends ChatSessionCubit` with `provider: Provider.omp`, registered as `BlocProvider<ChatSessionCubit>` (as `features/codex_session/state/codex_session_cubit.dart:10-26`).

### 10.2 File list

WP0 = foundation (§12), WP3 = App-Core (models, services, state, router, notifications, deep links), WP4 = App-UI (screens, widgets, theme, l10n). §12 lists exact ownership per phase.

| File | WP | Change | Reason |
|---|---|---|---|
| `models/messages.dart` | 0, 3 | WP0: `Provider.omp`, `providerFromValue`. WP3: `OmpThinkingLevel`, `OmpAvailability`, `OmpModelInfo`, `SessionListMessage.ompModels/ompAvailability/ompModelsRevision`, `SystemMessage.thinkingLevel/thinkingLevels`, `RecentSession`/`SessionInfo` `ompModel`/`ompThinkingLevel`, `ClientMessage.clientCapabilities(supportedProviders)` (default `['claude','codex','omp']`), `start`/`resumeSession(thinkingLevel)`, `listRecentSessions(providers)`, `setOmpModel`; `deriveExecutionMode` / `legacyPermissionModeFromModes` (`:429-477`) and the Claude fallbacks at `:4113`, `:4377` get omp cases; `PermissionPresentation` (`:2079-2330`) shows `input['approvalDetails']` lines as secondary details (deduped against the primary target) for every card | §9.4, §4.1 |
| `models/new_session_params.dart` (new) | 0, 3 | WP0: `NewSessionParams`, `sandboxModeFromRaw`, `sessionStartDefaultsToJson/FromJson` moved verbatim from `widgets/new_session_sheet.dart:22-442`, all importers updated. WP3: omp fields (`ompModel`, `ompThinkingLevel`, `executionMode` for omp), omp defaults JSON, `_providerFromRaw` via `providerFromValue` (today falls back to Codex, `:293-294`) | lets WP3 own the params and their codec without editing the sheet (app review A24) |
| `models/new_session_tab.dart` | 0, 3, 4 | WP0: `NewSessionTab.omp` (`toProvider`, label literal `omp`). WP3: `Set<Provider> enabledProvidersFromTabs(tabs)`, `List<NewSessionTab> tabsWithProvider(tabs, provider, enabled)`, `Set<Provider> effectiveProviders(enabledTabs, OmpSupport)` (below). WP4: deletes `EnabledAgentsMode`, `enabledAgentsModeFromTabs`, `tabsWithEnabledAgentsMode` (`:30-74`; in the code `tabsForEnabledAgentsMode`) once the settings screen no longer uses them. `defaultNewSessionTabs` is `[codex, claude, omp]`, with a one-time migration of stored tab lists (lead amendment A1, §15.4); `visibleNewSessionTabs` added (§15.4) | D17; omp enabled by default (A1) |
| `models/offline_pending_action.dart` | 3 | `OfflinePendingActionState.bridgeUpdateRequired` (implemented as the bool `OfflinePendingAction.bridgeUpdateRequired`, §15.4) | §9.5 |
| `features/settings/state/settings_cubit.dart`, `settings_state.dart` (+ freezed) | 3, 4 | WP3: `setAgentEnabled(Provider, bool)` (the last enabled agent cannot be disabled), `autoRenameOmpSessions` (default `true`) next to `settings_cubit.dart:68-71`. WP4: deletes `setEnabledAgentsMode` (`:489-491`) | |
| `features/session_list/state/session_list_state.dart` (+ freezed), `session_list_cubit.dart` | 0, 3 | WP0: `ProviderFilter.omp`, `_providerToString` omp case. WP3: `_loadPreferences` restores `omp` explicitly (`:97-102`); `providerFiltersForEnabledTabs` (`:435-455`) and `toggleProviderFilter` (`:224-235`, cycle All → Codex → Claude → omp over the allowed set) work on `effectiveProviders`; "All" sends `providers: effectiveProviders` when that set is a strict subset of what the Bridge supports, else no provider (implemented: `provider` for a single provider, §15.4); a filter change caused by coercion while `ompSupport` is `unknown` is applied in memory but **not persisted** (implemented for `unknown` and `unsupported`, A1, §15.4) | app review A4/A15, wire W5/W11 |
| `features/session_list/services/session_start_defaults_store.dart` | 0, 3 | WP0: key `session_start_defaults_omp_v1` in `_keyFor` (`:129-132`). WP3: cleanup list (`:115`), `_providerFromRaw` (`:134-138`), omp fields | per-provider defaults |
| `features/session_list/services/session_resume_coordinator.dart` | 3 | explicit omp branch (`:155-287`, today `isCodex` else Claude): `provider:"omp"`, `executionMode` from `claude_session_settings_<ompId>` or the omp start defaults, **no** `model`/`thinkingLevel`/Claude/Codex fields (omp restores the model, OBSERVED P8); the post-resume save (`:266-279`) writes only `{permissionMode, executionMode}` for omp | plain resume |
| `features/session_link/state/session_link_cubit.dart`, `session_link_state.dart` (+ freezed) | 3 | new state `bridgeUpdateRequired`; `resolve()` first waits until `ompSupport` is known (connected and first `session_list`, at most 10 s) for an omp link, then either sends `resolve_session_link {provider:"omp"}` or emits `bridgeUpdateRequired` (today an old Bridge ends in `openLegacy`, `:44-46`) | app review A11 |
| `services/bridge_service.dart` | 3 | `OmpSupport ompSupport` (`unknown`/`supported`/`unsupported`): `supported`/`unsupported` from the current connection's `session_list`; while disconnected, the last value seen for the same Bridge target in this app run (in memory), else `unknown`. `ompModels`/`ompAvailability`/`ompModelsRevision` cache kept when a `session_list` omits them, reset on Bridge switch (`:1285-1295`). The `send()` gate of §9.5 (`:1489-1525`). `patchSessionOmpModel` next to `patchSessionCodexModel`; `_patchSessionSystemSettings` (`:3913-3950`) and `_patchSessionLastMessage` (`:3954-3977`) keep omp fields. `switchFilter(providers:)`. A `session_created` whose provider differs from the pending start's fails that start (omp starts only, §15.4) | §9.5, wire W2/W3 |
| `services/chat_message_handler.dart` | 3 | keeps its `isCodex:` parameter and gains `isOmp:` (§15.4) (omp takes the non-Codex side: hidden `init` `:947-952`, no `$` entities, no plan-update detection `:521`, no Codex approval policy `:905-914`). New: `system` messages with `provider:"omp"` (`init`, `omp_settings`, `session_created`) fill `ompModel`/`ompThinkingLevel`/`ompThinkingLevels` live (next to the Codex read at `:926-934`) and in `_handleHistory` (`:716-724`, through new `ChatStateUpdate` omp fields, keyed on `m.provider == 'omp'`); the history filter (`:670-676`) also skips `omp_settings`; `rename_result {success:false}` for omp surfaces `ompNameCannotBeCleared` (today only logged, `:332-338`); `_unsupportedActions` (`:141-179`) gains `set_omp_model` | app review A2/A3/A12 |
| `services/session_runtime_store.dart` | 3 | filters `omp_settings` out of the timeline like `codex_settings` (`:236`) | |
| `services/connection_url_parser.dart` | 3 | accepts `provider=omp` (`:41-43`) | deep links |
| `main.dart` | 3 | `_normalizeProvider` (`:470-472`) accepts `omp` (JSON payloads are already accepted, `:427-436`) | notification taps |
| `router/omp_session_route.dart` (new) | 3 | `@RoutePage(name: 'OmpSessionRoute') class WorkspaceOmpSessionScreen` building `WorkspaceSessionRouteAdapter(selection: WorkspaceSessionSelection(provider: Provider.omp, …))`, the thin wrapper of `features/codex_session/codex_session_screen.dart:129-181` | routing in WP3 without the WP4 screen |
| `router/app_router.dart`, `app_router.gr.dart` (generated) | 3 | `AutoRoute(page: OmpSessionRoute.page, path: '/omp-session/:sessionId')` next to `:34-36` | |
| `router/session_stack_navigation.dart`, `router/session_route_observer.dart` | 3 | `OmpSessionRoute` ↔ `'omp'` next to the Claude/Codex cases (`session_stack_navigation.dart:142-151`, `session_route_observer.dart:50-63`) | |
| `features/omp_session/state/omp_session_cubit.dart` (new) | 3 | §10.1 | |
| `features/chat_session/state/chat_session_cubit.dart`, `chat_session_state.dart` (+ freezed) | 3 | §10.1 | |
| `features/omp_session/omp_session_screen.dart` (new) | 4 | `OmpSessionScreen` with the Codex screen structure (`codex_session_screen.dart`) and `OmpSessionCubit`: queue panel, conversation rewind (`CodexRewindDialog`), usage bar, `PlanApprovalUiMode.codex` approval labels, ask agent name `omp` plus `ompAskDeclineAborts` under the decline action (an omp-screen decline bar, §15.5), placeholder `ompMessagePlaceholder`; **no** retry of failed messages (as Codex, `codex_session_screen.dart:1472`: a retry while busy would be queued and drained as a second entry), goal card, tool suggestion card, CLI-join button or fork; local notification payload `jsonEncode({sessionId, provider:'omp'})`, body `ompSessionDone` | D17, app review A14 |
| `features/chat_session/widgets/queued_input_panel.dart` (new), `features/chat_session/utils/session_usage.dart` (new) | 4 | `CodexQueuedInputPanel` moved out of `codex_session_screen.dart:2001`; `_collectTokenUsage`/`_collectToolUsage` moved out of `claude_session_screen.dart:1831-1860`; both old screens import them | the omp screen needs both; no third copy (app review A24) |
| `features/codex_session/codex_session_screen.dart`, `features/claude_session/claude_session_screen.dart` | 4 | import the moved helpers; no behaviour change | |
| `features/omp_session/widgets/omp_model_chip.dart`, `omp_settings_sheet.dart` (new) | 4 | chip "model · thinking" (`ValueKey('omp_model_chip')`); sheet (`omp_settings_sheet`) with models grouped by `OmpModelInfo.provider` (`omp_model_option_<selector>`), an "omp default" entry (only as the selected row while the model is unknown, §15.5), the selected model's thinking levels (`omp_thinking_level_<level>`, descriptions reuse `reasoningEffort*Desc`, `off` → `reasoningEffortNoneDesc`, title reuses `reasoning`); calls `setOmpModel` | D12 |
| `features/chat_session/widgets/session_mode_bar.dart` | 4 | omp branch (`:70-150`): `OmpModelChip` + `ExecutionModeChip` opening an omp approval menu (`omp_approval_menu`, items `omp_approval_mode_<mode>` with `<mode>` = `default`, `acceptEdits` or `fullAccess`, labels `ompApproval*` §10.4); chip labels `ompApprovalChip*`; no plan chip; sandbox chip only when `supportsSandboxToggle` | §7 |
| `features/chat_session/widgets/chat_input_with_overlays.dart` | 4 | `$` trigger unchanged (Codex-only, `:297`, `:1145-1146`); image button always on for omp; fallback slash commands empty for omp (`:179-181`); `ComposerTokenConfig(provider: cubit.provider)` instead of `isCodex ? codex : claude` (`:206`) | §5.5 |
| `widgets/bubbles/error_bubble.dart` | 4 | titles, hints and styles for the §9.3 codes: `omp_notice` warning, `omp_info` neutral (new style), no copyable install command for `omp_cli_not_found` | titles stay English literals like the Codex ones (`:14-30`) |
| `widgets/bubbles/tip_chip.dart` | 4 | tip codes `omp_cwd_missing`, `omp_model_ignored`, `omp_mode_mapped`, `omp_change_deferred` (`:17`) | |
| `widgets/new_session_sheet.dart` | 4 | omp page: project, worktree, additional dirs (`ompAdditionalDirsDescription`, not the Codex `config.toml` text at `:2220`, `:2393`), model (`dialog_omp_model`, grouped, "omp default"), thinking level (`dialog_omp_thinking_level`; only with a catalogue model, §15.5), approval mode (`dialog_omp_approval_mode`); explicit omp cases in `NewSessionParams` construction (`:96-120`), `_buildParams` (`:1322-1374`, today `!isCodex` fills Claude fields), the permission field (`:2904-2940`, Claude sheet with plan/auto), the advanced options (`:3387`, Codex web search/network), the sandbox accessor (`:646-653`, Codex default on), `_applyInitialParams` (`:941-970`) and `:1592`; "Start with omp"; tabs from `effectiveProviders` | app review A10 |
| `features/session_list/session_list_screen.dart` | 0, 4 | WP0: compile placeholders at `:109` and `:1429` (omp → Claude values). WP4: `_startNewSession` (`:852-982`) omp field set and no sandbox; `_resumeSessionWithParams` (`:1498-1607`, today `!isCodex` saves Claude settings) and `_newSessionFromRecentSession` (`:1136-1215`) omp; `buildResumeCommand` (`:122-165`) → `omp --resume <sessionId> --approval-mode <mode>` (`always-ask`, `write` or `yolo`) from the per-session store (fallback `always-ask`), so the caller passes the loaded settings; `autoRenameForProvider` (`:107-112`) → `autoRenameOmpSessions`; `_navigateToChat` (`:1428-1452`) → `OmpSessionRoute`; running-session tap (`:2016`); archive (`:1366-1374`); rename with `allowClear: false` for omp; `visibleTabs` (`:845`) from `effectiveProviders` | app review A4/A16 |
| `features/session_list/workspace_shell_screen.dart` | 0, 4 | WP0: placeholder at `:1096`. WP4: `Provider.omp` → `OmpSessionScreen`; registry strings (`:247-249`, `:268-270`) | |
| `features/session_list/widgets/session_filter_bar.dart`, `home_content.dart` | 0, 4 | WP0: omp label in the exhaustive switch (`session_filter_bar.dart:93`). WP4: omp chip; provider comparisons (`home_content.dart:510`, `:790`, `:806-810`); the pending card shows `ompStartNeedsBridgeUpdate` for `bridgeUpdateRequired` actions | |
| `widgets/session_card.dart` | 4 | omp settings summary (model, thinking, approval mode) instead of the Claude one (`:2925`); `_ToolApprovalArea` (`:270`, `:317`, `:780-787`) gets a `sessionScopedAlways` flag: omp shows the session wording and `ompApproveAlwaysScope`, not Claude's "Permanently" | app review A17 |
| `theme/provider_style.dart` | 0 | omp: `colorScheme.tertiary`, `Icons.pie_chart_outline` (`:22-39`); `providerFromRaw` uses `providerFromValue` | exhaustive switch; Claude primary, Codex secondary |
| `features/settings/settings_screen.dart`, `widgets/new_session_tabs_bottom_sheet.dart` | 4 | AGENTS section: three `FilterChip`s (`agent_filter_chip_<provider>` for `codex`, `claude`, `omp`) replacing the `SegmentedButton<EnabledAgentsMode>` (`settings_screen.dart:610-648`, key `enabled_agents_selector`); the omp chip is disabled with `ompNotAvailableOnBridge` when `ompSupport == unsupported`, shows `ompNotDetected` for `not_installed` and `ompNoModels` for `no_models`; `autoRenameOmpSessions` toggle next to `:692-752`; the tab-order sheet (`:55-60`) offers only `effectiveProviders` | app review A4 |
| `features/session_link/session_link_screen.dart` | 4 | renders the `bridgeUpdateRequired` state with `bridgeUpdateRequiredForOmp`; provider normalization (`:118-133`) | |
| `widgets/rename_session_dialog.dart`, `widgets/session_name_title.dart` | 4 | `showRenameSessionDialog(allowClear:)` (empty result = clear, `rename_session_dialog.dart:27-31`); every caller passes `allowClear: provider != Provider.omp`, including `session_name_title.dart:49-56` | app review A12 |
| `l10n/app_ja.arb` (template), `app_en.arb`, `app_ko.arb`, `app_zh.arb`, generated `app_localizations*.dart` | 4 | keys in §10.4 | ja is the template (`apps/mobile/l10n.yaml`) |

`features/workspace/state/workspace_navigation_cubit.dart` needs no change: it compares `Provider.value` (`:16-17`).

**Effective providers** (WP3, `models/new_session_tab.dart`): `effectiveProviders(enabledTabs, ompSupport) = enabledProvidersFromTabs(enabledTabs) ∩ ({claude, codex} ∪ (ompSupport == supported ? {omp} : ∅))`; if the result is empty, `{claude, codex} ∩ enabled`, and if that is empty too, `{claude, codex}`. Used for the new-session tabs, the tab-order sheet, the allowed filters, and the "All" request. `unknown` hides omp without persisting anything.

### 10.3 Notifications, deep links, resume command

- FCM data carries `provider`; `main.dart` routes `provider:"omp"` to `SessionLinkRoute(sessionId, provider:'omp')` once `_normalizeProvider` accepts it. The link cubit waits for capabilities before deciding (§10.2), so a cold-start tap right after connect does not show a false "update required".
- Local fallback notifications are fired by the screens; the omp screen sends a JSON payload `{sessionId, provider}`, which `main.dart:427-436` already accepts. (Claude and Codex screens pass a bare id, which `main.dart` treats as Claude. WP2 makes `resolve_session_link` match a live session by **Bridge id** regardless of the requested provider, among the providers the client declared (§9.5), and answer with the real provider; this also resolves those Codex taps. Matching by provider session id stays provider-scoped.)
- Deep link `ccpocket://session/<id>?provider=omp` is parsed by `connection_url_parser.dart` and resolved through `resolve_session_link {provider:"omp"}` (§6.1).
- Resume command: `omp --resume <sessionId> --approval-mode <mode>`: omp resolves an id prefix globally (research `omp-rpc.md` §10); `--approval-mode` keeps the session's ccpocket mode instead of the user's config default (`yolo` here). `--add-dir` is not needed: omp restores additional directories from the header (OBSERVED V4).

### 10.4 l10n keys (WP4)

Brand names (`omp`, `Claude`, `Codex`) are literals, as `newSessionTabCodex` is `"Codex"` everywhere. Thinking-level descriptions reuse `reasoningEffortNoneDesc` … `reasoningEffortMaxDesc`, and the level title reuses `reasoning` (`app_en.arb:374`).

| Key | en | ja | ko | zh |
|---|---|---|---|---|
| `ompMessagePlaceholder` | Message omp... | omp にメッセージ... | omp에게 메시지... | 给 omp 发消息... |
| `autoRenameOmpSessions` | Auto Rename (omp) | 自動Rename (omp) | 자동 Rename (omp) | 自动 Rename (omp) |
| `autoRenameOmpSessionsSubtitle` | Name omp sessions automatically after the first agent response | 最初のエージェント応答後に omp セッションへ自動で名前を付ける | 첫 에이전트 응답 후 omp 세션 이름을 자동으로 지정합니다 | 在首次智能体回复后自动为 omp 会话命名 |
| `ompDefaultModel` | omp default | omp の既定 | omp 기본값 | omp 默认 |
| `ompApprovalMenuTitle` | omp approval mode | omp の承認モード | omp 승인 모드 | omp 审批模式 |
| `ompApprovalAlwaysAsk` | Ask every time | 毎回確認 | 매번 확인 | 每次询问 |
| `ompApprovalAlwaysAskDescription` | Ask before edits, commands and MCP tools | 編集・コマンド・MCP ツールの前に確認する | 편집, 명령, MCP 도구 실행 전에 확인합니다 | 编辑、命令和 MCP 工具执行前先询问 |
| `ompApprovalWrite` | Allow writes | 書き込みを許可 | 쓰기 허용 | 允许写入 |
| `ompApprovalWriteDescription` | Edits and MCP tools run without asking; commands still ask. Your omp allow rules also apply. | 編集と MCP ツールは確認なしで実行し、コマンドは確認する。omp の許可ルールも適用される | 편집과 MCP 도구는 확인 없이 실행하고 명령은 확인합니다. omp 허용 규칙도 적용됩니다 | 编辑和 MCP 工具无需询问即可执行，命令仍需询问。omp 的允许规则同样生效 |
| `ompApprovalYolo` | Run everything | すべて実行 | 모두 실행 | 全部执行 |
| `ompApprovalYoloDescription` | Run everything without asking | 確認せずにすべて実行する | 확인 없이 모두 실행합니다 | 无需询问，全部执行 |
| `ompApprovalChipAlwaysAsk` / `ompApprovalChipWrite` / `ompApprovalChipYolo` | Ask / Writes / All | 確認 / 書込 / 全て | 확인 / 쓰기 / 전체 | 询问 / 写入 / 全部 |
| `ompApproveAlwaysScope` | Allows every call of this tool in this session | このセッションでこのツールのすべての呼び出しを許可します | 이 세션에서 이 도구의 모든 호출을 허용합니다 | 在此会话中允许此工具的所有调用 |
| `ompAskDeclineAborts` | Declining stops omp's current turn | 断ると omp の現在のターンが停止します | 거절하면 omp의 현재 턴이 중지됩니다 | 拒绝将停止 omp 当前的回合 |
| `ompChangeDeferredTip` | The change applies when omp is idle and its background jobs have finished | omp が待機状態になり、バックグラウンド処理が終わったら適用されます | omp가 대기 상태가 되고 백그라운드 작업이 끝나면 적용됩니다 | 将在 omp 空闲且后台任务结束后生效 |
| `ompAdditionalDirsDescription` | Extra directories omp may read and work in. They do not grant write access by themselves. | omp が参照・作業できる追加ディレクトリ。これ自体は書き込み権限を与えません | omp가 읽고 작업할 수 있는 추가 디렉터리입니다. 이것만으로 쓰기 권한이 부여되지는 않습니다 | omp 可读取并在其中工作的额外目录。其本身不授予写入权限 |
| `ompNotDetected` | omp was not found on this Bridge | この Bridge で omp が見つかりません | 이 Bridge에서 omp를 찾을 수 없습니다 | 此 Bridge 上未找到 omp |
| `ompNoModels` | omp has no usable model. Log in with omp first. | omp で使えるモデルがありません。先に omp でログインしてください | omp에서 사용할 수 있는 모델이 없습니다. 먼저 omp에서 로그인하세요 | omp 没有可用模型。请先在 omp 中登录 |
| `ompNotAvailableOnBridge` | Update the Bridge to use omp | omp を使うには Bridge を更新してください | omp를 사용하려면 Bridge를 업데이트하세요 | 请更新 Bridge 以使用 omp |
| `ompStartNeedsBridgeUpdate` | This Bridge cannot start omp sessions. Update the Bridge. | この Bridge では omp セッションを開始できません。Bridge を更新してください | 이 Bridge에서는 omp 세션을 시작할 수 없습니다. Bridge를 업데이트하세요 | 此 Bridge 无法启动 omp 会话。请更新 Bridge |
| `bridgeUpdateRequiredForOmp` | This omp session needs a newer Bridge | この omp セッションには新しい Bridge が必要です | 이 omp 세션에는 최신 Bridge가 필요합니다 | 此 omp 会话需要更新的 Bridge |
| `ompNameCannotBeCleared` | omp session names cannot be cleared | omp のセッション名は消去できません | omp 세션 이름은 지울 수 없습니다 | 无法清除 omp 会话名称 |
| `ompSessionDone` | omp session done | omp セッション完了 | omp 세션 완료 | omp 会话已完成 |
| `ompCwdMissingTip` | The recorded directory no longer exists; omp continues in the project directory | 記録されたディレクトリが存在しないため、omp はプロジェクトディレクトリで続行します | 기록된 디렉터리가 없어 omp가 프로젝트 디렉터리에서 계속합니다 | 记录的目录已不存在，omp 将在项目目录中继续 |
| `ompModelIgnoredTip` | The requested model is not available in omp; the session keeps its model | 指定されたモデルは omp で使えないため、セッションのモデルを使います | 요청한 모델은 omp에서 사용할 수 없어 세션의 모델을 유지합니다 | 请求的模型在 omp 中不可用，会话保留原模型 |
| `ompModeMappedTip` | omp has no plan or auto mode; the session asks before actions | omp には plan/auto モードがないため、操作前に確認するモードで開始しました | omp에는 plan/auto 모드가 없어 작업 전에 확인하는 모드로 시작했습니다 | omp 没有 plan/auto 模式，会话将在操作前询问 |
| `enabledAgentsAtLeastOne` | Keep at least one agent enabled | 少なくとも1つのエージェントを有効にしてください | 에이전트를 하나 이상 켜 두세요 | 请至少保留一个已启用的智能体 |

The implementation adds one key that this table lacks, `ompRewindFailed` ("Rewind failed: {error}", §15.5).

## 11. Test plan

Commands (`.claude/skills/test-bridge/SKILL.md`, `.claude/skills/test-flutter/SKILL.md`; toolchain facts from the lead):

```bash
npx tsc --noEmit -p packages/bridge/tsconfig.json
cd packages/bridge && npx vitest run [src/<file>.test.ts]
export PATH=~/.local/share/flutter-shims:~/.local/share/flutter-3.47.4/bin:$PATH
cd apps/mobile && dart analyze [paths]
cd apps/mobile && flutter test [test/<file>_test.dart]
dart format <changed Dart files>
```

### 11.1 Bridge unit tests

Harness: the Codex pattern (`codex-process.test.ts:8-41`): `vi.hoisted({spawnMock, fakeChildren})`, `FakeChildProcess` with `FakeReadable` stdout/stderr and a `FakeWritable` stdin that records writes and models `end()` (writes after `end()` are dropped, as on Node v24), `vi.mock("node:child_process", () => ({ spawn: spawnMock }))`. Frames are verbatim OBSERVED frames, stored as `packages/bridge/src/omp-fixtures/<probe>-*.jsonl` (WP1) and replayed through `child.stdout.emit("data", …)` in single frames and arbitrary chunk splits.

WP1 (new test files):

| File | Cases |
|---|---|
| `omp-rpc-transport.test.ts` | argv order and flags (§2.1), `BRIDGE_OMP_BIN`, breadcrumb env removed, overlay content/mode; LF-only framing with U+2028 inside a string; per-line limit; `rpc_chunk` reassembly incl. a multi-byte character split across chunks, gap, repeat, interleaved frame, `byteLength` mismatch, oversize announcement; v2 negotiation success and `ready` without v2; outbox held until negotiation; correlation (ids, 30 s control timeout with fake timers, no timeout for `prompt`, `success:false` with `code`, second response for a resolved id); exit before `ready` with stderr tail; `ENOENT`; `win32` deferred error |
| `omp-process.test.ts` | §3 mapping per frame type incl. dropped ones; deltas without snapshots; assistant blocks and `i` stripping; tool table §3.3 incl. `apply_patch` alias, replace-mode `Edit` vs hashline `FileChange`, diff conversion and fallback, todo deferral and status mapping, `description: intent`. **Run state** (§2.5): idle + `input_ready` at `prompt_result {sessionSettled:false}` (V7 replay: async bash) before `session_settled`; agent-initiated run → `running` → `result` at its yield; non-yield `agent_end` keeps `running`; local completion (`agentInvoked:false` response, no `prompt_result`); `prompt_result {agentInvoked:false, status:"error"}` → error `result` and idle, the second `response` not reported twice; every prompt carries `streamingBehavior:"followUp"`; idle compaction returns to `idle`, compaction inside a run to `running`; `rpc_frame_error` per `originalType` and `agent_end` without `isTerminal`. **Approvals**: P3a/P3b/P3c (select before its start, out-of-order answers)/P3d; score-0 candidate not bound (parallel `[eval, bash]` with an inner bash approval); `approvalDetails` always present; hashline patch appended; `Reason:` → `reason`. **Approve-always**: parallel pending approvals, `Reason:` and `Provider safety checks:` never auto-approved. **Ask**: P2a–P2f; multi-select in a two-question ask (V3: no Done → toggles, `Other`, joined editor text); zero-selection → `(none)`; title normalization order with glyph rows; answer before first frame; timeout notice. Generic dialogs; `cancel {targetId}`; `notify` info → `omp_info`, warning → `omp_notice`. **Interrupt** P4a/P4b ordering (`cancelled:true` written before `abort`), P4c. **Steer**: only while busy; idle steer path not taken. **Writes after close**: every write method returns false and emits `omp_process_exited` once. `setModelSettings`: outbox while starting, deferred while running, validation, thinking re-apply (P10), level read back from `thinking_level_changed` (V1), no `get_state`. `setApprovalMode`: deferred until idle **and** settled, respawn with/without file, no `exit` event, allow-list kept, cursor reset without file, `omp_respawn_failed`. `branch()` success, `cancelled:true`, error. `setSessionName`. `user_entries` from `get_entries {since}`: only new entries on the `leafId` path (in-file branch fixture), `unknown_since` stops the backfill. `stop()` sequence with fake timers; `exited` promise |
| `omp-tool-mapping.test.ts` | every row of §3.3 incl. the `apply_patch` alias, replace-mode `Edit` vs hashline `FileChange` with per-path patch sections, diff conversion (numbered rows, a real unified diff passed through, no matching row → text), todo status mapping and phase flattening, `description: intent` only when the tool has no `description`, `i` stripped |
| `omp-writers.test.ts` | register/release; `waitForRelease` waits for `exited`; timeout → `omp_session_busy`; `ownerBySessionId` |
| `omp-sessions.test.ts` | temp store via `PI_CODING_AGENT_DIR`; `PI_CONFIG_DIR`, profile and `PI_CODING_AGENT_SESSION_DIR` resolution; listing fields from files built like P7/P9; loose file-name pattern incl. a 16-hex id; bucket filter via header cwd incl. worktree normalization and colliding bucket names; exclusions (artifact subdirectory, `.bak`, `.gz`, no user message); a first prompt longer than 64 KiB (partial parse) and one behind more than 64 KiB of entries (bounded scan); name rule (slot truncated vs longer `title_change`, header unchanged); settings from tail else head; mtime/size cache; `findOmpSessionFile`; `renameOmpRecentSession` waits for the registry; `listOmpModels` (P10 shape, `thinking: null`, unknown levels filtered, `ENOENT` → `not_installed`, empty → `no_models`) |
| `omp-history.test.ts` | active branch of a branched file (leaf = last entry, cycle guard); `untilEntryId` and `OmpHistoryTargetNotFoundError`; user content as string and as blocks; assistant/toolResult/bashExecution/custom_message (`attribution:"user"` → user) mapping; `model_usage`/`developer` skipped; `todo` pairing; `ompImages` refs (valid blob, invalid hex, inline base64 counted only, budget); `extractOmpMessageImages`; `limits` for compaction and the total cap (`omp_history_too_large`); line above the injected line limit; `lastEntryId` |
| `omp-print.test.ts` | argv incl. `--approval-mode always-ask`; stdin written and ended; stdin `"ignore"` without input; `OMP_MCP_TIMEOUT_MS`; trimming; exit 1 → rejection with stderr; timeout kills the child |
| `jsonl-partial.test.ts` | `decodeJsonStringPrefix` on cut escapes and surrogate pairs |

WP2 (existing test files; `websocket.test.ts:46-103` also mocks `./omp-sessions.js`, `./omp-print.js` and `./omp-writers.js`, so no test runs the real `omp`):

| File | Cases |
|---|---|
| `parser.test.ts` | `provider:"omp"` for start, resume, `resolve_session_link`, `list_recent_sessions` (`provider` and `providers`), `archive_session`; `thinkingLevel` enum; `set_omp_model` validation; `client_capabilities.supportedProviders` |
| `protocol-contract.test.ts` | every WP0 fixture (§9.6): client fixtures parse; `sendSessionList` for the fixture state equals `omp-session-list.json`; frozen v1 fixtures unchanged; `BRIDGE_PROTOCOL_CAPABILITIES` in both session-list paths and `/version` |
| `session.test.ts` | `vi.mock("./omp-process.js")` fake like the Codex/Sdk fakes (`session.test.ts:9-31`, `:77-112`); `create(…, "omp", undefined, {ompOptions})` prefills `claudeSessionId` and saves the worktree mapping before start; `input_ready` drains the queue; queued, steered and drained omp items carry no `codex:` uuid and keep `clientMessageId`; steer detaches the item (drain during an in-flight steer sends nothing; failure restores it); exit clears the queue; `backfillOmpUserUuids` with duplicate texts across past and live messages, never reusing past or assigned ids; `omp_settings` merged and not appended to history; `session_name`; `persistSessionName`; auto-rename awaited with the omp model and cleared on resume; Claude disk backfill not run for omp; summary fields |
| `websocket.test.ts` (implemented in the new `websocket-omp.test.ts`, §15.6) | start and resume branches: cwd rule (existing and missing recorded cwd), `session_created` only after `waitUntilReady` (resume only; start sends it at once, §15.2), never-ready and exit-1-before-ready → `session_resume_failed` + code + destroyed session, no 30 s replay of a failed resume; the legacy-app payload (`legacy-app-omp-resume.json`): Claude `model` dropped with `omp_model_ignored`, `planMode:false`, `plan` → `default` with `omp_mode_mapped`, `sandboxMode` not echoed; attach to a live session vs `omp_session_already_open` for an edited resume; resume while the previous child is still disposing waits for the registry; `set_omp_model` validation and forwarding; `set_permission_mode` (mapping, `plan`/`auto` rejected, deferred answer); tool actions route to `OmpProcess`; `reject` with a message appends one `user_input` without merging into an older same-text entry; `approve.clearContext` rejected for omp; queue handlers; `get_history` and the generic delta send queue state and an `omp_settings` snapshot; `past_history` carries no `imageBase64`/`ompImages` and registers blob images; `list_recent_sessions {provider:"omp"}` without a Codex merge and `{providers}`; rename running, recent-while-live (goes to the live process), recent, clear; archive; rewind (conversation only, preconditions, invalid target has no side effect, branch failure leaves the session intact, new-process failure answers `success:false`, workspace and name carried over) and `rewind_dry_run`; `fork` error; per-client visibility: an undeclared client gets no omp sessions, fields or session traffic, a declaring client gets a second `session_list`; `resolve_session_link` by Bridge id across providers; `set_sandbox_mode` error; push ask body with agent name and duration in seconds; model cache presence rule and `ompAvailability`; `git_commit` for omp awaits the async assist |
| `sessions-index.test.ts` | third loader, positive gates, `providers` filter, `provider:sessionId` dedupe, `extractMessageImages` omp routing, shared `decodeJsonStringPrefix` |
| `auto-rename.test.ts`, `git-assist.test.ts` | async signatures for all providers; omp branch through a mocked `runOmpPrint` |
| `doctor.test.ts`, `push-i18n.test.ts`, `setup-systemd.test.ts`, `setup-launchd.test.ts`, `cli.test.ts`, `workspace-store.test.ts`, `version.test.ts` (if present, else a new case in `protocol-contract.test.ts`) | omp branches (§8), persisted variables, `/version` capabilities |

### 11.2 App unit and widget tests

WP0: the existing suite stays green after the enum baseline and the `NewSessionParams` move (`flutter test`), plus `messages_test.dart` for `providerFromValue`.

WP3: `messages_test.dart` (omp parse/serialize incl. `supportedProviders`, `providers`, `approvalDetails` in `PermissionPresentation`), `session_start_defaults_store_test.dart` (omp key and fields), `session_resume_coordinator_test.dart` (omp JSON without model/thinking, `executionMode` from the per-session store, post-resume save), `chat_message_handler_test.dart` (omp `init` hidden, `omp_settings` live and skipped in history, history restores `ompModel`/`ompThinkingLevel`, `set_omp_model` update hint, `rename_result` failure for omp), `chat_session_cubit_test.dart` (getters, queue for omp, no optimistic uuid, no mention extraction for omp, `_applySessionContext` applies omp model and level, `setOmpModel` rollback, permission rollback on `omp_mode_unsupported`/`omp_respawn_failed`, per-session store write on id change), `session_list_cubit_test.dart` (filter cycle, omp filter persisted and restored, effective providers, "All" with `providers`, no persistence while `unknown`), `settings_cubit_text_scale_test.dart` (`setAgentEnabled`), `session_stack_navigation_test.dart`, `session_route_observer_test.dart`, `workspace_navigation_test.dart`, `connection_url_parser_test.dart` (omp accepted; the "unknown value is coerced" case at `:187-193` switches to a truly unknown value), `session_link_cubit_test.dart` (waits for capabilities, `bridgeUpdateRequired`), `services/bridge_service_usage_test.dart` (`ompSupport` three states and last-known value while disconnected, cache kept when fields are absent, `send()` gate for each omp message kind, offline action → `bridgeUpdateRequired`, local `session_resume_failed`, provider mismatch on `session_created`), `protocol_contract_test.dart` (omp fixtures).

WP4: new `omp_session_screen_test.dart` (mode bar with model chip and approval chip, no plan chip, sandbox chip only for Claude, Codex approve labels, queue panel, rewind dialog, usage bar, no retry), new `new_session_sheet_omp_test.dart` (grouping, thinking levels per model, approval modes, "omp default", params carry only omp fields, additional-dirs text), `session_mode_bar_test.dart`, `session_card_test.dart` (omp summary, session-scoped approve-always label), `home_screen_test.dart` (provider colours, pending card with `bridgeUpdateRequired`; the pending card is tested in `home_content_skeleton_test.dart`, §15.6), `settings_usage_visibility_test.dart` (`:935-1063` look for `enabled_agents_selector`, replaced by the `agent_filter_chip_*` keys; disabled chip without capability; last agent cannot be disabled), `codex_queue_panel_test.dart` (import from the moved `queued_input_panel.dart`), `workspace_shell_screen_test.dart` (omp routing), `session_link_screen_test.dart` (`bridgeUpdateRequired` UI), `chat_input_bar_test.dart` (image button for omp, no `$` button), `error_bubble_test.dart` (omp codes, `omp_info` neutral), a rename dialog test for `allowClear: false`; existing Claude/Codex screen tests keep passing (`chat_screen/helpers/chat_test_helpers.dart`).

### 11.3 Live E2E against the real omp (after WP2)

New script `packages/bridge/test-omp-e2e.mjs` (WP2; plain Node + `ws`, next to `test-client.mjs`). It never touches port 8765 and stops only what it started.

```bash
E2E_DIR=$(mktemp -d /tmp/omp-e2e-XXXX); mkdir "$E2E_DIR/project"
BRIDGE_PORT=8766 BRIDGE_HOST=127.0.0.1 BRIDGE_DISABLE_MDNS=1 \
BRIDGE_ALLOWED_DIRS="$E2E_DIR" npm run bridge        # started by the script, PID recorded
node packages/bridge/test-omp-e2e.mjs --url ws://127.0.0.1:8766 --project "$E2E_DIR/project" [--model <selector>]
```

The user's omp store is used, because credentials live there; sessions land in the temp-root bucket of `$E2E_DIR`. The implemented script isolates the test Bridge's own state and can redirect the sessions with `--session-dir` (§15.6). The script prints the session files it created and deletes them only with `--cleanup` and only when their header `cwd` is inside `$E2E_DIR`. Prompts are tiny and harmless.

| Step | Action | Assert |
|---|---|---|
| 1 | connect with `client_capabilities {supportedProviders:[…,"omp"]}` | a second `session_list` with `provider_omp_v1`, `ompAvailability:"available"`, non-empty `ompModels` |
| 1b | a second socket without `supportedProviders` | no omp sessions, fields or traffic on it for the whole run |
| 2 | `start {provider:"omp", executionMode:"default"}` | `session_created` + `system/init` with an omp session id |
| 3 | "Reply with exactly: OK" | ≥1 `stream_delta`, assistant text `OK`, `result success` with `cost` and tokens, `status idle` |
| 4 | "Run: echo hi" | `permission_request Bash {command:"echo hi"}` with `approvalDetails` → `approve` → `tool_result` contains `hi` |
| 5 | "Run: echo bye" → `reject {message:"not now"}` | denied tool result, one `user_input` "not now", turn completes |
| 6 | "Use the ask tool to ask me which color I prefer: red or blue" | `permission_request AskUserQuestion` with 2 options → `answer` blue → "User selected: blue" |
| 7 | "Use the ask tool to ask me two questions: which fruits I like (multiple choice: apple, banana, cherry) and which size I prefer (small or large)" | multi-select answer `[apple, cherry]` and `small` complete without abort |
| 8 | "Run: echo hi" and `interrupt` while the approval is pending | `result interrupted` within 10 s, `status idle` |
| 9 | `set_permission_mode {executionMode:"fullAccess"}` | `system/set_permission_mode`, same Bridge session id |
| 10 | "Run in the background: sleep 20 && echo done" (bash async) | `result success` and `status idle` before `session_settled`; a second input then gets `input_ack {queued:false}`; a later agent-initiated run is reported as `running` → `result` |
| 11 | "Run: sleep 5 && echo done" + second input while running | `input_ack {queued:true}`, `conversation_queue` 1 item without `codex:` uuid, drained after the first `result` |
| 12 | long run + queued "Also add the word PINEAPPLE to your final reply." + `steer_queued_input` | final text contains `PINEAPPLE`, the text appears once in history |
| 13 | `set_omp_model` second selector + `thinkingLevel:"off"` | `system/omp_settings` with both |
| 14 | image prompt | `result` (success, or a visible error for a model without vision support) |
| 15 | `rename_session` running, then `list_recent_sessions {provider:"omp"}`, then `rename_session` of the same id from the recent path | name in the recent entry; the second rename goes to the live process (no second omp process in `pgrep`) |
| 16 | `stop_session`, immediately `resume_session`, `get_history` | the resume waits for the old child; `past_history` with earlier user texts and `omp:entry:` uuids; a second `resume_session` of the same id attaches |
| 17 | `rewind {mode:"conversation"}` to the second user message | `rewind_result success`, `session_created {sourceSessionId}`; the branched file has `parentSession`; the next prompt lands in it |
| 18 | `archive_session {provider:"omp"}` | entry gone from `list_recent_sessions` |
| 19 | teardown | stop the sessions and the Bridge the script started; `pgrep -f "omp --mode rpc"` shows none of the script's children |

### 11.4 Flutter web + Playwright UI smoke (after WP2 and WP4)

dart-mcp and Marionette are unavailable (lead fact), so runtime UI checks use the web build (`.claude/skills/web-preview/SKILL.md`): `bash .claude/skills/web-preview/scripts/web-preview.sh .`, the test Bridge on 8766, `playwright-cli open http://127.0.0.1:8888`. The build renders with CanvasKit; the smoke first enables Flutter semantics (click the `flt-semantics-placeholder` element), then locates widgets by accessible label (the `ValueKey`s of §10.2 are used by the widget tests).

0. Parse the WP0 server fixtures with the app from `main` (a throwaway `flutter test` run in a `main` worktree) to show old apps do not crash on them.
1. Connect to `ws://127.0.0.1:8766` → Settings: enable omp (chip enabled) → new-session sheet: omp page, pick a model group and a thinking level, approval "Ask every time" → start → "Run: echo hi" → approval card with omp's approval text and the session-scoped always label → approve → Bash tile and result → model chip → change thinking level → session list: omp filter chip, card with model summary and omp colour. Screenshot per step.
2. Against a Bridge from `main` (no omp wiring; same port after stopping the first): omp tab, filter and new-session page hidden, settings chip shows `ompNotAvailableOnBridge`, an omp deep link shows `bridgeUpdateRequiredForOmp`.
3. The app from `main` against the new Bridge: list, open a Claude session, resume, and a notification-tap link; no omp session is visible.

## 12. Work breakdown

### 12.1 Phases and ownership rule

| Phase | Packages (parallel inside a phase) | Starts when |
|---|---|---|
| 0 | **WP0** Foundation | now |
| 1 | **WP1** Bridge-Core ∥ **WP3** App-Core | WP0 committed |
| 2 | **WP2** Bridge-Wiring ∥ **WP4** App-UI | WP1 and WP3 committed (WP2 needs WP1, WP4 needs WP3) |
| 3 | lead: integration verification (§12.7) | WP2 and WP4 committed |

Ownership is exclusive **within a phase**:

- Phase 0: WP0 owns exactly the files in §12.2.
- Phase 1: WP1 owns only the **new** files of §12.3 and must not edit any existing file under `packages/`; WP3 owns `apps/mobile/**`.
- Phase 2: WP2 owns `packages/bridge/**`, `test/fixtures/protocol/v1/**` (additions only) and the docs of §12.4; WP4 owns `apps/mobile/**`.
- The Bridge and the app never share a file; they meet only through the WP0 wire fixtures and §9.
- Each package's file list is its intended change set. A package may additionally edit any test inside its owned tree that its own change breaks, and records such edits in its commit message.
- This document belongs to the lead. A package that must deviate from it stops and reports the deviation with evidence instead of silently diverging.

Commits (Conventional Commits, one or more per package): WP0 `test(protocol): add omp contract fixtures` and `refactor(app): add omp provider enum baseline`; WP1 `feat(bridge): add omp process and session store modules`; WP2 `feat(bridge): wire omp provider` plus `fix(bridge): show push durations in seconds`; WP3 `feat(app): add omp provider core`; WP4 `feat(app): add omp session UI`. The commits as made: §15.6.

### 12.2 WP0: Foundation

Owned files:

| File | Change |
|---|---|
| `test/fixtures/protocol/v1/omp-*.json`, `legacy-app-omp-resume.json` (new) | the fixtures of §9.6, written from the shapes in §9.2–§9.4 |
| `apps/mobile/lib/models/messages.dart` | `Provider.omp('omp', 'omp')`, `Provider? providerFromValue(String? raw)` |
| `apps/mobile/lib/models/new_session_params.dart` (new) | verbatim move of `NewSessionParams`, its helpers (`sandboxModeFromRaw`, the effort helpers it uses, `_providerFromRaw`) and `sessionStartDefaultsToJson/FromJson` from `widgets/new_session_sheet.dart:22-442`; no behaviour change |
| `apps/mobile/lib/widgets/new_session_sheet.dart` | remove the moved code, import the new file |
| `apps/mobile/lib/features/claude_session/claude_session_screen.dart`, `features/codex_session/codex_session_screen.dart`, `features/session_list/services/session_start_defaults_store.dart`, `features/session_list/session_list_screen.dart`, `test/home_screen_test.dart`, `test/new_session_directory_browser_test.dart`, `test/session_start_defaults_store_test.dart`, `test/worktree_test.dart` | import `models/new_session_params.dart` where they use the moved symbols |
| `apps/mobile/lib/models/new_session_tab.dart` | `NewSessionTab.omp` (`toProvider` → `Provider.omp`, label literal `omp`) |
| `apps/mobile/lib/features/session_list/state/session_list_state.dart`, `session_list_cubit.dart` | `ProviderFilter.omp`; `_providerToString` → `'omp'` |
| `apps/mobile/lib/features/session_list/services/session_start_defaults_store.dart` | `_keyFor` omp → `session_start_defaults_omp_v1` |
| `apps/mobile/lib/theme/provider_style.dart` | omp colour and icon (§10.2, final) |
| `apps/mobile/lib/features/session_list/widgets/session_filter_bar.dart` | omp label in the exhaustive switch (`:93`) |
| `apps/mobile/lib/features/session_list/session_list_screen.dart` | placeholders `Provider.omp => settings.autoRenameClaudeSessions` (`:109`) and `Provider.omp => <the Claude route>` (`:1429`), each marked `// omp: replaced in WP4` |
| `apps/mobile/lib/features/session_list/workspace_shell_screen.dart` | placeholder `Provider.omp => <the Claude screen>` (`:1096`), marked the same way |
| any further site that `dart analyze` reports as a non-exhaustive switch after the enum additions | final value when §10.2 defines it, else a marked placeholder listed in the WP0 commit message |
| `apps/mobile/test/messages_test.dart` | `providerFromValue` cases |

Acceptance:

```bash
python3 -c "import json,glob; [json.load(open(f)) for f in glob.glob('test/fixtures/protocol/v1/*omp*.json')]"
(cd packages/bridge && npx vitest run src/protocol-contract.test.ts)      # frozen fixtures unaffected
export PATH=~/.local/share/flutter-shims:~/.local/share/flutter-3.47.4/bin:$PATH
(cd apps/mobile && dart analyze && flutter test)
(cd apps/mobile && dart format $(git ls-files --modified --others --exclude-standard -- '*.dart' | grep -v -E '\.(g|freezed|gr)\.dart$'))   # changed, non-generated files
grep -rn "omp: replaced in WP4" apps/mobile/lib        # lists every placeholder for WP4
```

### 12.3 WP1: Bridge-Core (new files only)

Owned files (all new, `packages/bridge/src/`):

| File | Content |
|---|---|
| `omp-types.ts` | shared omp types (below) |
| `omp-env.ts` | `resolveOmpBin`, `resolveOmpStore`, `sanitizedOmpEnv`, `OMP_BREADCRUMB_ENV_VARS`, `writeOmpRpcOverlay` (§2.1, §8.0) |
| `omp-rpc-transport.ts` | spawn, framing, v2 negotiation, outbox, chunk reassembly, correlation (§2.2–§2.4) |
| `omp-tool-mapping.ts` | wire-name aliases, canonical names and inputs, edit diff conversion, todo mapping (§3.3), shared by live and history |
| `omp-process.ts` | `OmpProcess` (§2–§7) |
| `omp-writers.ts` | writer registry (§6.7) |
| `omp-sessions.ts` | store listing, header, names, file lookup, recent rename, model catalogue (§6.1, §6.3, §7.1) |
| `omp-history.ts` | history conversion, bounding, image refs, blob reading, lazy image extraction (§6.2) |
| `omp-print.ts` | `runOmpPrint` (§8.0) |
| `jsonl-partial.ts` | `decodeJsonStringPrefix` (§8.0; WP2 switches `sessions-index.ts` to it) |
| `omp-*.test.ts`, `jsonl-partial.test.ts`, `omp-fixtures/*.jsonl` | §11.1 |

Interfaces provided (the design contract; the implemented signatures extend it, §15.1):

```ts
// omp-types.ts
export type OmpThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const OMP_THINKING_LEVELS: readonly OmpThinkingLevel[];
export type OmpExecutionMode = "default" | "acceptEdits" | "fullAccess";
export type OmpApprovalMode = "always-ask" | "write" | "yolo";
export type OmpLegacyPermissionMode = "default" | "acceptEdits" | "bypassPermissions";
export type OmpAvailability = "available" | "not_installed" | "no_models";
export function approvalModeFor(mode: OmpExecutionMode): OmpApprovalMode;
export function legacyPermissionModeFor(mode: OmpExecutionMode): OmpLegacyPermissionMode;
export interface OmpModelInfo { selector: string; provider: string; name: string; thinkingLevels: OmpThinkingLevel[]; input: string[] }
export interface OmpSettings { model?: string; thinkingLevel?: OmpThinkingLevel }
export interface OmpStartOptions {
  bridgeSessionId: string;          // owner id for the writer registry
  cwd?: string;                     // resume: omp's --cwd per §6.4 step 4; default: the cwd passed to start()
  executionMode: OmpExecutionMode;
  model?: string;                   // exact selector, already validated by the caller
  thinkingLevel?: OmpThinkingLevel; // already validated by the caller
  additionalDirectories?: string[];
  resumeSessionFile?: string;       // absolute path of an existing .jsonl
  resumeSessionId?: string;         // omp session id of that file
  entryCursor?: string | null;      // last entry id read from that file (§6.6)
}
export interface OmpSystemMessage {   // messages ServerMessage cannot express until WP2 widens parser.ts
  type: "system";
  subtype: "init" | "omp_settings" | "supported_commands" | "set_permission_mode";
  sessionId?: string; provider: "omp"; model?: string;
  thinkingLevel?: OmpThinkingLevel; thinkingLevels?: OmpThinkingLevel[];
  executionMode?: OmpExecutionMode; permissionMode?: OmpLegacyPermissionMode;
  slashCommands?: string[];
}
export type OmpProcessMessage = ServerMessage | OmpSystemMessage;
export interface OmpRecentSession extends Omit<SessionIndexEntry, "provider" | "codexSettings" | "permissionMode"> {
  provider: "omp"; ompSettings?: OmpSettings;
}
export interface OmpImageRef { blob: string; mimeType: string }   // pastMessages field `ompImages`
export const OMP_ENTRY_UUID_PREFIX = "omp:entry:";

// omp-process.ts
export class OmpProcess extends EventEmitter<{
  message: [OmpProcessMessage]; status: [ProcessStatus]; exit: [number | null];
  input_ready: []; session_name: [string]; user_entries: [Array<{ entryId: string; text: string }>];
}> {
  constructor(options?: { platform?: NodeJS.Platform; writers?: OmpWriterRegistry });
  readonly status: ProcessStatus;
  readonly isWaitingForInput: boolean;   // idle and ready
  readonly isBusy: boolean;              // running | waiting_approval | compacting
  readonly isAlive: boolean;             // starting | ready
  readonly isSettled: boolean;           // §2.5 `settled`
  readonly isRunning: boolean;
  readonly sessionId: string | null;
  readonly sessionFile: string | null;
  readonly executionMode: OmpExecutionMode;
  readonly permissionMode: OmpLegacyPermissionMode;
  readonly settings: OmpSettings;
  readonly exited: Promise<number | null>;   // current child; replaced on respawn
  start(cwd: string, options: OmpStartOptions): void;   // returns at once; spawn + handshake async
  waitUntilReady(): Promise<void>;                        // rejects with Error & {code}
  stop(): void;
  interrupt(): void;
  sendInput(text: string, options?: { images?: Array<{ base64: string; mimeType: string }> }): boolean;
  steer(text: string, options?: { images?: Array<{ base64: string; mimeType: string }> }): Promise<void>;
  approve(toolUseId?: string): boolean;
  approveAlways(toolUseId?: string): boolean;
  reject(toolUseId?: string, message?: string): boolean;   // sends the steer itself; caller appends user_input
  answer(toolUseId: string, result: string): boolean;
  getPendingPermission(toolUseId?: string): { toolUseId: string; toolName: string; input: Record<string, unknown> } | undefined;
  setModelSettings(settings: OmpSettings): Promise<void>;                        // Error & {code:"set_omp_model_failed"}
  setApprovalMode(mode: OmpExecutionMode): Promise<{ applied: "now" | "deferred" }>;
  setSessionName(name: string): Promise<void>;
  branch(entryId: string): Promise<{ cancelled: boolean; sessionId: string; sessionFile: string | null }>;
}

// omp-writers.ts
export interface OmpWriterRegistry {
  register(file: string, owner: { owner: string; sessionId: string; exited: Promise<unknown> }): void;
  waitForRelease(file: string, timeoutMs?: number): Promise<void>;   // Error & {code:"omp_session_busy"}
  ownerBySessionId(sessionId: string): { owner: string; file: string } | undefined;
}
export const ompWriters: OmpWriterRegistry;

// omp-sessions.ts
export function listOmpRecentSessions(options?: { projectPath?: string; env?: NodeJS.ProcessEnv }): Promise<OmpRecentSession[]>;
export function findOmpSessionFile(sessionId: string): Promise<string | null>;
export function readOmpSessionHeader(file: string): Promise<{ id: string; cwd: string; timestamp: string; title?: string; parentSession?: string } | null>;
export function getOmpSessionName(sessionId: string): Promise<string | null>;
export function renameOmpRecentSession(params: { sessionId: string; name: string }): Promise<boolean>;
export function listOmpModels(options?: { env?: NodeJS.ProcessEnv }): Promise<{ models: OmpModelInfo[]; availability: OmpAvailability }>;

// omp-history.ts
export class OmpHistoryTargetNotFoundError extends Error {}
export interface OmpHistoryLimits { maxToolItemChars: number; truncatedStringChars: number; maxDepth: number; maxTotalChars: number; maxLineChars: number }
export function getOmpSessionHistory(file: string, options?: { untilEntryId?: string; limits?: Partial<OmpHistoryLimits> }):
  Promise<{ messages: SessionHistoryMessage[]; lastEntryId: string | null }>;   // Error & {code:"omp_history_too_large"}
export function readOmpBlob(hash: string): Promise<{ base64: string } | null>;   // hash validated, ≤ 10 MB
export function extractOmpMessageImages(sessionId: string, messageUuid: string): Promise<Array<{ base64: string; mimeType: string }>>;

// omp-print.ts
export function runOmpPrint(options: { cwd: string; prompt: string; stdin?: string; model?: string; timeoutMs?: number }): Promise<string>;

// jsonl-partial.ts
export function decodeJsonStringPrefix(fragment: string): string;
```

Consumes (read-only imports): `parser.ts` (`ServerMessage`, `ProcessStatus`, `AssistantContent`), `sessions-index.ts` (`SessionIndexEntry`, `SessionHistoryMessage`, `normalizeWorktreePath`).

Acceptance:

```bash
npx tsc --noEmit -p packages/bridge/tsconfig.json
(cd packages/bridge && npx vitest run src/omp-rpc-transport.test.ts src/omp-tool-mapping.test.ts src/omp-process.test.ts src/omp-writers.test.ts src/omp-sessions.test.ts src/omp-history.test.ts src/omp-print.test.ts src/jsonl-partial.test.ts)
(cd packages/bridge && npx vitest run)        # the existing suite stays green
test -z "$(git diff --name-only HEAD -- packages)"   # WP1 adds files only; no tracked file under packages/ is modified
```

### 12.4 WP2: Bridge-Wiring

Change set: `packages/bridge/src/{parser,session,websocket,sessions-index,auto-rename,git-assist,doctor,push-i18n,setup-systemd,setup-launchd,cli,workspace-store,archive-store,protocol-version,version}.ts` and their tests (`parser`, `protocol-contract`, `session`, `websocket`, `sessions-index`, `auto-rename`, `git-assist`, `doctor`, `push-i18n`, `setup-systemd`, `setup-launchd`, `cli`, `workspace-store`); new `packages/bridge/test-omp-e2e.mjs`; docs `docs/agent-project-reference.md`, `docs/protocol-versioning.md`, `packages/bridge/README.md`.

Work (details in the referenced sections):

- `parser.ts`: §9.2; `OmpThinkingLevel` imported from `omp-types.ts`.
- `protocol-version.ts`, `version.ts`: `BRIDGE_PROTOCOL_CAPABILITIES`, `/version.protocolCapabilities` (§9.1).
- `session.ts`:
  - `SessionInfo.process: SdkProcess | CodexProcess | OmpProcess`; `SessionInfo.ompSettings`, `steeringQueuedItemId`; `SessionSummary.ompSettings`.
  - `create()` 7th parameter becomes `{ deferProcessMessages?: boolean; ompOptions?: Omit<OmpStartOptions, "bridgeSessionId"> }`; the omp branch creates `OmpProcess`, fills `bridgeSessionId`, prefills `claudeSessionId` from `resumeSessionId`, calls `saveWorktreeMapping`, clears `autoRename` on resume (§6.4, §8.1). The Claude/Codex `if/else` blocks at `:335`, `:510-576`, `:830-835` become three explicit branches.
  - `providerSupportsQueuedInput`, queue changes and steer detach (§5.2, §5.3); `clientMessageId` on queued items; `markPendingCodexUserEcho` Codex-only.
  - listeners `input_ready`, `session_name`, `user_entries`; `backfillOmpUserUuids` (§6.6); Claude disk backfill gated to Claude (`:688-690`).
  - `omp_settings` merged into `ompSettings`, delivered live, not appended to history (§3.1).
  - `persistSessionName`, async auto-rename with the omp model (§8.1); `buildSessionSummary` omp fields; `rewindFiles`/`rewindConversation` reject omp with a reason (`:1613-1700`).
  - a `SessionManager.appendUserInput(session, {text})` helper (append to history, broadcast, mark as awaiting an omp entry id) for the omp reject path (§4.1); steer and drain keep their existing append code.
- `websocket.ts`: explicit omp branches for every site in research `bridge-process.md` §2.0 and `bridge-periphery.md` §17, plus the sites of bridge review B17: start (sanitize §6.4 step 6, deferred errors §9.3), input (§5.1), queue handlers (§5.2), `set_permission_mode`, `set_sandbox_mode`, tool actions, `approve.clearContext` rejection, `get_history`/generic delta (queue + `omp_settings` snapshot), `registerPast*Images` omp branch and `ompImages` stripping (§6.2), resume (§6.4, fingerprint with `thinkingLevel`, readiness, attach, sanitizing), rename (§6.3), archive, rewind/dry-run/fork (§6.6), async `git_commit` (§8.2), recent listing with `providers` (§6.1), workspace enrichment, `session_list` capability constant and model fields with the presence rule (§7.1), model cache refresh, `set_omp_model` (§7.2), per-client visibility in `prepareServerMessageForClient` and the re-send after `client_capabilities` (§9.5), `resolve_session_link` by Bridge id across providers (§10.3), push `agent` parameter and duration fix (§8.5), debug summary default (`:10174-10176`) and debug-bundle resume fields (`:10285-10326`).
- `sessions-index.ts`: third loader, positive gates, `providers`, `SessionIndexEntry.provider`/`ompSettings`, `extractMessageImages` routing (§6.1, §6.2), `decodeJsonStringPrefix` from `jsonl-partial.ts`.
- `auto-rename.ts`, `git-assist.ts` (async), `doctor.ts`, `push-i18n.ts`, `setup-*.ts`, `cli.ts`: §8. `workspace-store.ts`, `archive-store.ts`: provider unions and validation.

Interfaces provided to the app: exactly §9 (fixtures of §9.6 are the contract).

Acceptance:

```bash
npx tsc --noEmit -p packages/bridge/tsconfig.json
(cd packages/bridge && npx vitest run)
# live, real omp, test Bridge on 8766 only (§11.3); the script stops what it started:
node packages/bridge/test-omp-e2e.mjs --url ws://127.0.0.1:8766 --project "$E2E_DIR/project"
```

### 12.5 WP3: App-Core

Change set (`apps/mobile/lib/`): `models/messages.dart`, `models/new_session_params.dart`, `models/new_session_tab.dart`, `models/offline_pending_action.dart`, `services/bridge_service.dart`, `services/chat_message_handler.dart`, `services/session_runtime_store.dart`, `services/connection_url_parser.dart`, `main.dart`, `router/app_router.dart`, `router/app_router.gr.dart` (generated), `router/session_stack_navigation.dart`, `router/session_route_observer.dart`, new `router/omp_session_route.dart`, `features/chat_session/state/chat_session_cubit.dart`, `chat_session_state.dart` (+ `.freezed.dart`), new `features/omp_session/state/omp_session_cubit.dart`, `features/session_list/state/session_list_cubit.dart`, `session_list_state.dart` (+ `.freezed.dart`), `features/session_list/services/session_start_defaults_store.dart`, `features/session_list/services/session_resume_coordinator.dart`, `features/session_link/state/session_link_cubit.dart`, `session_link_state.dart` (+ `.freezed.dart`), `features/settings/state/settings_cubit.dart`, `settings_state.dart` (+ `.freezed.dart`); the tests of §11.2 WP3.

Interfaces provided to WP4 (Dart):

```dart
// models/messages.dart
enum Provider { claude, codex, omp }                    // from WP0
Provider? providerFromValue(String? raw);               // from WP0
enum OmpThinkingLevel { off, minimal, low, medium, high, xhigh, max }
enum OmpAvailability { available, notInstalled, noModels }
class OmpModelInfo { final String selector, provider, name; final List<String> thinkingLevels, input; }
// RecentSession / SessionInfo: String? ompModel, ompThinkingLevel
// ClientMessage.start(..., {String? thinkingLevel}); ClientMessage.resumeSession(..., {String? thinkingLevel});
// ClientMessage.setOmpModel(String sessionId, {String? model, String? thinkingLevel})
// PermissionPresentation shows input['approvalDetails']

// models/new_session_params.dart: NewSessionParams gains String? ompModel, String? ompThinkingLevel (executionMode reused)
// models/new_session_tab.dart
Set<Provider> enabledProvidersFromTabs(List<NewSessionTab> tabs);
List<NewSessionTab> tabsWithProvider(List<NewSessionTab> tabs, Provider provider, bool enabled);
Set<Provider> effectiveProviders(List<NewSessionTab> enabledTabs, OmpSupport ompSupport);
// models/offline_pending_action.dart: OfflinePendingActionState.bridgeUpdateRequired   (implemented: bool OfflinePendingAction.bridgeUpdateRequired, §15.4)

// services/bridge_service.dart
enum OmpSupport { unknown, supported, unsupported }     // implemented in models/messages.dart, re-exported here (§15.4)
OmpSupport get ompSupport; Stream<OmpSupport> get ompSupportStream;
List<OmpModelInfo> get ompModels; OmpAvailability? get ompAvailability; int? get ompModelsRevision;
void patchSessionOmpModel(String sessionId, {String? model, String? thinkingLevel});


// features/chat_session/state
// ChatSessionCubit: isOmp, supportsQueuedInput, supportsRuntimeModelChange, supportsSandboxToggle,
//   void setOmpModel({String? model, String? thinkingLevel});
// ChatSessionState: String? ompModel, ompThinkingLevel; List<String> ompThinkingLevels
// OmpSessionCubit({required sessionId, required bridge, required streamingCubit, initialProjectPath, initialWorktreePath,
//   initialGitBranch, initialPermissionMode, initialExplorerCurrentPath, initialRecentPeekedFiles})

// router: OmpSessionRoute(sessionId:, projectPath:, workspace:, gitBranch:, worktreePath:, isPending:,
//   initialPermissionMode:, pendingSessionCreated:, onBackToSessions:, hideSessionBackButton:)

// state
// ProviderFilter.omp (WP0); SettingsCubit.setAgentEnabled(Provider, bool); SettingsState.autoRenameOmpSessions;
// SettingsCubit.setAutoRenameOmpSessions(bool); SessionLinkState.bridgeUpdateRequired
```

Acceptance:

```bash
export PATH=~/.local/share/flutter-shims:~/.local/share/flutter-3.47.4/bin:$PATH
(cd apps/mobile && dart run build_runner build --delete-conflicting-outputs)   # router and freezed outputs
(cd apps/mobile && dart analyze && flutter test)                               # full suite; the WP0 baseline keeps it compiling
(cd apps/mobile && dart format $(git ls-files --modified --others --exclude-standard -- '*.dart' | grep -v -E '\.(g|freezed|gr)\.dart$'))   # changed, non-generated files
```

### 12.6 WP4: App-UI

Change set (`apps/mobile/lib/`): new `features/omp_session/omp_session_screen.dart`, `features/omp_session/widgets/omp_model_chip.dart`, `features/omp_session/widgets/omp_settings_sheet.dart`, new `features/chat_session/widgets/queued_input_panel.dart`, new `features/chat_session/utils/session_usage.dart`, `features/codex_session/codex_session_screen.dart`, `features/claude_session/claude_session_screen.dart`, `features/chat_session/widgets/session_mode_bar.dart`, `features/chat_session/widgets/chat_input_with_overlays.dart`, `widgets/bubbles/error_bubble.dart`, `widgets/bubbles/tip_chip.dart`, `widgets/new_session_sheet.dart`, `widgets/session_card.dart`, `widgets/rename_session_dialog.dart`, `widgets/session_name_title.dart`, `features/session_list/session_list_screen.dart`, `features/session_list/workspace_shell_screen.dart`, `features/session_list/widgets/session_filter_bar.dart`, `features/session_list/widgets/home_content.dart`, `features/settings/settings_screen.dart`, `features/settings/widgets/new_session_tabs_bottom_sheet.dart`, `features/session_link/session_link_screen.dart`, `l10n/app_{ja,en,ko,zh}.arb` and the generated `l10n/app_localizations*.dart`; deletions only in `models/new_session_tab.dart` (`EnabledAgentsMode`, `enabledAgentsModeFromTabs`, `tabsWithEnabledAgentsMode`, named `tabsForEnabledAgentsMode` in the code), `features/settings/state/settings_cubit.dart` (`setEnabledAgentsMode`) and their tests; the tests of §11.2 WP4. Every WP0 placeholder (`grep -rn "omp: replaced in WP4"`) is replaced.

Consumes: every WP3 interface; wire behaviour only through the app models.

Acceptance:

```bash
export PATH=~/.local/share/flutter-shims:~/.local/share/flutter-3.47.4/bin:$PATH
(cd apps/mobile && flutter gen-l10n && dart run build_runner build --delete-conflicting-outputs)
(cd apps/mobile && dart analyze && flutter test)
(cd apps/mobile && dart format $(git ls-files --modified --others --exclude-standard -- '*.dart' | grep -v -E '\.(g|freezed|gr)\.dart$'))   # changed, non-generated files
! grep -rn "omp: replaced in WP4\|EnabledAgentsMode" apps/mobile/lib
```

### 12.7 Phase 3: integration verification (lead)

1. `npx tsc --noEmit -p packages/bridge/tsconfig.json`, `cd packages/bridge && npx vitest run`, `cd apps/mobile && dart analyze && flutter test` on the merged branch (once; not repeated without new changes).
2. §11.4 web smoke (both passes and the `main`-app pass) with screenshots.
3. §11.3 E2E only if WP4 or the merge changed Bridge files after WP2's run.
4. `/self-review` skill (`.claude/skills/self-review/SKILL.md`) on the combined diff, because the change crosses the protocol boundary.

## 13. Deviations and open risks

### 13.1 Deviations from the lead's decisions

| Decision | Deviation | Evidence |
|---|---|---|
| D2 "runtime mode change = stop + respawn when idle" | respawn only when idle **and** `session_settled` was seen since the last activity (§7.3) | the respawn kills omp's background jobs (§2.6), and idle no longer implies "no background work" (§2.5, OBSERVED V7) |
| D3 "oldest pending `tool_execution_start` with that toolName" | correlate against the tool calls of the preceding assistant `message_end`, bind only with a positive argument score, always send omp's approval text (§4.1) | OBSERVED P3c/V2: the select for the second parallel call arrives before its `tool_execution_start`; SOURCE `eval/preludes.ts:99`: inner `eval` tools raise approvals without a parent call |
| D5 "`prompt_result` → result" | also one `result` per agent-initiated run at its yielding `agent_end` (§3.4); the Bridge's idle trigger is the last `prompt_result`, not `session_settled` (§2.5) | SOURCE `rpc-session-settle.ts:18-27`, `:80-97`; OBSERVED V7 |
| D9 "running session → set_session_name; recent → short-lived process" | a recent-list rename of a session that is live in the Bridge goes to the live process (§6.3) | a short-lived `--resume` process would be a second writer on the live file (§6.7) |
| D12 "exposes them in session_list" | still `session_list`, but only to clients that declare omp, only after the first refresh, and in broadcasts only when `ompModelsRevision` changed (§7.1) | measured 33,761 bytes for 214 models; 24 `broadcastSessionList` call sites; `[]` before the first refresh would falsely read as "not installed" |
| D16 "Bridge advertises provider_omp_v1; the app offers omp only when present" | additionally the app declares `supportedProviders`, and the Bridge hides omp from clients that do not (§9.5); the app gates omp messages once in `BridgeService.send()` | old apps open omp sessions in the Claude screen and resume them with a Claude model (OBSERVED WC1); Bridges ≤ v1.72.1 run `start {provider:"omp"}` as a Claude SDK process (`git show bridge/v1.72.1:…/websocket.ts:2343`) |
| D21 "rewind via RPC branch {entryId}" | `branch` runs in the running process, then the Bridge session is replaced by a new one on the branched file (§6.6) | the app's rewind flow (Claude, Codex) replaces the Bridge session; a failed `branch` then has no side effect; one writer per file (§6.7). The draft's reason "the branched file appears only after the next assistant message" was wrong: SOURCE `session-manager.ts:3223-3290` writes it at once, OBSERVED V4 |

Additions that do not contradict a decision: the `--config` overlay with `ask.timeout: 0` (OBSERVED P2f), the `set_interrupt_mode wait` pin and `streamingBehavior:"followUp"` on every prompt (§2.4, §5.1) extend D1; cancelling pending dialogs before `abort` (OBSERVED P4) is required for interrupts; the writer registry (§6.7) protects D7–D9 and D21.

Decisions taken here because the lead left them open: fork at a message unsupported in v1 (§6.6); Windows unsupported in v1 (§2.1); account usage out of scope (§8.3); clearing an omp name unsupported (§6.3); omp opt-in in the agent settings (§10.2; replaced by lead amendment A1, omp enabled by default, §15.4); retry of failed messages off, as in the Codex screen (§10.2); images offered for every omp model (§5.5); omp reuses the existing per-session settings store keyed by the omp session id (§10.1); the push duration fix applies to every provider (§8.5).

### 13.2 Open risks

1. **Unverified omp paths**: auto-retry on 429/5xx; `set_model` during a run (avoided by deferral); rename before the file exists (since OBSERVED in the live E2E, §15.6); `details` of multi-file edit results; subagent tool approvals (fallback id); images for text-only models; the effect of `--approval-mode always-ask` on MCP tools in print mode (source only); the flat layout of `PI_CODING_AGENT_SESSION_DIR` (source only); the frames of real pre-agent failures such as "No API key" (source and docs only, not triggerable without changing omp config); Windows. Each has a defined fallback and a unit or E2E check (§11).
2. **String contracts inside omp**: approvals rely on `"Allow tool: "`, `["Approve","Deny"]`, `Reason:` and `Provider safety checks:`; ask handling on `"Other (type your own)"`, the `Done selecting` suffix, `" (Recommended)"`, `(N selected) ` and ` (i/n)`. omp v18.4.2 is already released (research `omp-rpc.md` header); a change silently turns approvals into generic dialogs (still answerable) or breaks multi-select. Mitigation: probe fixtures in the unit tests, doctor's version warning, rerunning §11.3 before raising the supported omp version.
3. **Writers outside the Bridge**: a session open in the user's terminal `omp` while the Bridge resumes, renames or rewinds it has two writers; omp exposes no lock over RPC. The rewind has a second failure point after the old session is gone (§6.6 step 7), which leaves the branched session only in the recent list.
4. **History size**: resume fails with `omp_history_too_large` above 64 Mi code units of display data, like Codex; the peak memory for a multi-GB file was not measured.
5. **Store location**: named profiles, `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` are supported by rule, XDG relocation is not. A service environment that differs from the user's shell lists a different store; setup persists the variables and doctor reports the resolved store.
6. **Cost figures**: `result.cost` is omp's price-table figure; for subscription-backed providers it can be notional.
7. **Old apps**: omp sessions are invisible to them (§9.5). Pushes are per device, so an old app that taps an omp push sees "unavailable".
8. **Existing gaps left as they are**: `unsupported_message` has no `sessionId`, so chat-level `_unsupportedActions` hints do not reach `ChatSessionCubit` with the real `BridgeService` (research `app-core.md` §3); the Claude and Codex assist helpers still block the event loop with `execFileSync` inside the now-async functions (§8.1, §8.2).
9. **E2E side effects**: the live E2E uses the user's omp credentials, spends a few cents, and writes sessions into the user's store (temp-root bucket).
10. **Manual `/compact`** runs in the background under RPC without compaction events (SOURCE `builtin-lifecycle.ts:288-296`); the session shows `idle` until "Compaction complete." arrives.
11. **Approval-mode change with long background jobs**: the respawn waits for `session_settled`, so a never-ending job (a dev server) keeps the change pending until the user stops the session; the tip `omp_change_deferred` says so.
12. **Background jobs end with the process**: stop, approval-mode respawn and rewind terminate omp's async jobs (§2.6).

## 14. Review log

Four reviews of revision 1: bridge (B1–B25), app (A1–A24), omp (O1–O21), wire (W1–W14). Each finding was checked against the repo, the omp v18.3.2 source or a probe before the verdict.

| Id | Verdict | Check and resolution |
|---|---|---|
| B1 | ACCEPTED | SOURCE `rpc-session-settle.ts:18-27`, `:80-97`, `rpc-prompt-results.ts:115-156`. Idle at the last `prompt_result`, `session_settled` only gates the respawn (§2.5, §7.3); tests §11.1, E2E step 10 |
| B2 | ACCEPTED | `websocket.ts:3228` sets `nextCodexUserTurnUuid` for every queued item. Codex-only (§5.2); test in `session.test.ts` |
| B3 | ACCEPTED | SOURCE `agent-session.ts:7506-7520`, `:7675-7722`, `rpc-mode.ts:1218-1221`; `session.ts:1494-1515` keeps the item while awaiting. Steer only while busy, item detached, drain skips it (§5.3) |
| B4 | ACCEPTED | `session.ts:410-412`, `:812-814`, 6th parameter is Codex-normalized (`:320-333`). `ompOptions` in the 7th parameter, id prefill and `saveWorktreeMapping` before start (§6.4 step 8, §12.4) |
| B5 | ACCEPTED | `websocket.ts:5839-5848`, replay `:173`, `:7893-7946`. Resume awaits `waitUntilReady`, failure destroys and fails the operation (§6.4 step 9) |
| B6 | ACCEPTED | `session_resume_coordinator.dart:159-237` sends Claude fields. Sanitizing for all clients (§6.4 step 6); fixture `legacy-app-omp-resume.json` |
| B7 | ACCEPTED | no live check in `resume_session`; rename path `websocket.ts:8157`, `:8189-8212`; `stop()` returns before the child exits. Writer registry (§6.7), attach or `omp_session_already_open` (§6.4 step 3), live rename (§6.3) |
| B8 | ACCEPTED | Node v24 behaviour as reported. `closing`/`exited` lifecycle, writes refused with `omp_process_exited` (§2.6), input branch check (§5.1) |
| B9 | ACCEPTED | SOURCE `agent-session.ts:11108-11123` iterates all file entries; OBSERVED V4. `get_entries {since}` + leaf path + monotonic matching (§6.6) |
| B10 | ACCEPTED | SOURCE `session-manager.ts:3223-3290` writes the branch at once. Branch in the running process first, readiness before `rewind_result`, workspace and name carried, reason corrected (§6.6, §13.1) |
| B11 | ACCEPTED | `websocket.ts:1846-1856` spreads the message incl. `imageBase64`. `ompImages` refs, registration at `get_history`, stripped before sending (§6.2 step 4) |
| B12 | ACCEPTED | window cut lines were skipped. Partial parse with a shared `decodeJsonStringPrefix`, bounded scan, settings from tail else head (§6.1) |
| B13 | ACCEPTED | SOURCE `eval/preludes.ts:99`. Bind only with score > 0, `approvalDetails` always sent (§4.1) |
| B14 | ACCEPTED | SOURCE `wrapper.ts:315-345`. No auto-approve with `Provider safety checks:` or `Reason:` (§4.2) |
| B15 | ACCEPTED | `execFile` has no `input`; callers are synchronous today (`git-assist.ts:20-53`, `auto-rename.ts:104-122`). `spawn`-based `Promise<string>`, async callers (§8.0–§8.2) |
| B16 | ACCEPTED | `protocol_contract_test.dart:9` reads the shared fixtures. Fixtures moved to WP0 (§12.2) |
| B17 | ACCEPTED | each site checked in `session.ts`/`websocket.ts`: Claude backfill gated (§6.6), `approve.clearContext` rejected (§6.6), resume input buffer stays Claude-only (§6.4), fingerprint with `thinkingLevel` (§6.4), reject reason appended by `SessionManager` (§4.1), debug-bundle fields (§6.4), `sandboxMode` not echoed (§6.4) |
| B18 | ACCEPTED | `websocket.ts:4988-5031` is the Codex-only branch. Queue state and `omp_settings` snapshot in `get_history` and the generic delta (§3.1, §5.2) |
| B19 | ACCEPTED | SOURCE `rpc-mode.ts:1131-1216`, `builtin-lifecycle.ts:288-296`. No `prompt` timeout, derived status after compaction (§2.4, §2.5); manual `/compact` as risk 10 |
| B20 | ACCEPTED | SOURCE `rpc-mode.ts:1273-1300`. `get_state` only at start and for foreign `model_changed`; settings changes wait in the outbox (§2.4, §7.2) |
| B21 | ACCEPTED | `broadcast` prepares per client (`websocket.ts:9543-9551`). Wrong reason removed; old clients are now filtered (§9.5) |
| B22 | ACCEPTED | `websocket.ts:3121-3128`. Deferred `error` with code plus `exit` (§2.1, §9.3) |
| B23 | ACCEPTED | DOCUMENTED `environment-variables.md:23`, `:523-524`. `PI_CONFIG_DIR` resolved and persisted, doctor warns about sessions outside the store (§6.1, §8.4, §8.6) |
| B24 | ACCEPTED | DOCUMENTED `approval-mode.md` Modes table. Separate omp labels and descriptions (§7.3, §10.4) |
| B25 | ACCEPTED | `websocket.test.ts:46-103`. Mocks for `omp-sessions`, `omp-print`, `omp-writers`; `limits` option; tests for B1–B14 (§11.1) |
| A1 | ACCEPTED | same as B16; WP0 owns the fixtures (§12.2) |
| A2 | ACCEPTED | `chat_session_cubit.dart:333-420`, `chat_message_handler.dart:716-724`. Context and history restore, `patchSessionOmpModel`, levels from the cache (§10.1, §10.2) |
| A3 | ACCEPTED | `chat_message_handler.dart:670-676`, `system_chip.dart:17`. Filter in history replay, and the Bridge no longer stores `omp_settings` in history (§3.1, §10.2) |
| A4 | ACCEPTED | `session_list_screen.dart:845`, `new_session_tabs_bottom_sheet.dart:55-60`, `parser.ts:1644-1648`. `effectiveProviders`, `providers[]` for "All", no persistence while unknown (§10.2) |
| A5 | ACCEPTED | same as B2 (§5.2) |
| A6 | ACCEPTED | FileChange card shows paths only (`models/messages.dart:2196-2220`); omp edit details are paths only (SOURCE `edit/index.ts:395-404`). Replace mode → `Edit` with inline diff; hashline patch in `approvalDetails` (§3.3, §4.1) |
| A7 | ACCEPTED | same as B24 (§10.4) |
| A8 | ACCEPTED, different fix | writers at `chat_session_cubit.dart:1777`, `:1840`, `:2018`, `:2064`, `:2089` confirmed. Instead of a new store, omp reuses the existing per-session store keyed by the omp id, so every writer already covers it; the first-id write now fires on id change (§10.1). Test: change mode, resume, assert `executionMode` |
| A9 | ACCEPTED | `:2009` patches the Codex cache. `:343`/`:2009` stay `isCodex`; `supportsPlanMode`/`supportsFileRewind` dropped; `supportsSandboxToggle` only in the mode bar (§10.1) |
| A10 | ACCEPTED | sites in `new_session_sheet.dart` confirmed by line. Listed in the WP4 row with explicit omp cases (§10.2) |
| A11 | ACCEPTED | `session_link_screen.dart:27-32` resolves immediately. `SessionLinkState.bridgeUpdateRequired`, waiting for capabilities in the cubit (§10.2) |
| A12 | ACCEPTED | `rename_session_dialog.dart:27-31`, `chat_message_handler.dart:332-338`. `allowClear`, error surfaced (§6.3, §10.2) |
| A13 | ACCEPTED | `_isPermissionModeFailure` `:2106-2113`, `setCodexModel` has no rollback. `omp_respawn_failed`, rollback checks, real model rollback; the deferral hint is a Bridge tip `omp_change_deferred`, because only the Bridge knows whether background jobs are pending (§7.2, §7.3, §10.1) |
| A14 | ACCEPTED | `:1525` extracts Codex mentions; retry while busy duplicates entries. Mentions Codex-only; retry off as in Codex (§10.1, §10.2) |
| A15 | ACCEPTED | `session_list_cubit.dart:97-102`. Explicit omp restore (§10.2) |
| A16 | ACCEPTED | Claude copy command carries the mode (`session_list_screen.dart:143-158`). `--approval-mode` appended (§10.3) |
| A17 | ACCEPTED | `session_card.dart:270`, `:317`, `:780-787`. Session-scoped wording and `ompApproveAlwaysScope` (§4.2, §10.2) |
| A18 | ACCEPTED | `offline_pending_action.dart:3`. `bridgeUpdateRequired` state, pending card text (§9.5, §10.2) |
| A19 | ACCEPTED | `main.dart:427-436` already accepts JSON; `workspace_navigation_cubit.dart:16-17` compares values; no `initialExecutionMode` parameter exists. Rows corrected; the cubit derives `executionMode` from `initialPermissionMode` instead of adding a parameter (§10.1, §10.2) |
| A20 | ACCEPTED | `app_en.arb:374`, `:378-379`. `ompAdditionalDirsDescription`, `ompStartNeedsBridgeUpdate`, menu title and mode texts added; `reasoning` reused (§10.4) |
| A21 | ACCEPTED | `error_bubble.dart:27`, `:97`. `omp_info` neutral style (§4.4, §10.2) |
| A22 | ACCEPTED | `settings_usage_visibility_test.dart:935-1063`, `codex_queue_panel_test.dart`, `workspace_shell_screen_test.dart` exist. Added to §11.2 |
| A23 | ACCEPTED | ValueKeys named in §10.2; semantics enabling in §11.4 |
| A24 | PARTIALLY ACCEPTED | `NewSessionParams` moved to `models/` in WP0 and the freezed outputs assigned (§12); queue panel and usage collectors extracted (§10.2). Rejected: extracting `_switchSession`/`_resolveSession`/draft migration from both existing screens, because it changes two working screens beyond what omp needs; the omp screen copies that part of the Codex structure (D17) |
| O1 | ACCEPTED | SOURCE `rpc-session-settle.ts:58`, `:84`, `agent-session.ts:7144-7158`. `prompt_result` cases table, no error-text matching (§3.1) |
| O2 | ACCEPTED | same root as B1; OBSERVED V7 (§2.5) |
| O3 | ACCEPTED | same as B15; SOURCE `main.ts:239-259` (§8.0) |
| O4 | ACCEPTED | SOURCE `wrapper.ts:315-330`, `tools/settings.ts:290-295`. `--approval-mode always-ask` for print runs (§8.0); source-only, risk 1 |
| O5 | ACCEPTED | SOURCE `ask.ts:535-537`, `:568-582`, `:1083-1087`; OBSERVED V3. New multi-select plan (§4.3) |
| O6 | ACCEPTED | same as B3 (§5.3) |
| O7 | ACCEPTED | same as B9 (§6.6) |
| O8 | ACCEPTED | same as B10 (§6.6, §13.1) |
| O9 | ACCEPTED | SOURCE `approval.ts:367`, `edit/index.ts:378-380`. Alias table, approve-always keyed by internal name (§3.3, §4.2) |
| O10 | ACCEPTED | SOURCE `rpc-frame.ts:94-99`, `:218-240`. Per-type handling (§2.3 step 5) |
| O11 | ACCEPTED | DOCUMENTED `compaction.md:137-139`. Derived status (§2.5) |
| O12 | ACCEPTED | SOURCE `session-title-slot.ts:40-57`; OBSERVED V4. Name rule (§6.1) |
| O13 | ACCEPTED | SOURCE `session-manager.ts:115-117`, DOCUMENTED `session.md:74`. Loose pattern plus header check (§6.1) |
| O14 | ACCEPTED | SOURCE `cli/args.ts:159`. Flat session directory, persisted by setup, reported by doctor (§6.1, §8.4, §8.6) |
| O15 | ACCEPTED | SOURCE `agent-session.ts:7633-7639`. Gate removed (§5.5); runtime for text-only models is risk 1 |
| O16 | ACCEPTED | same as B24 (§10.4) |
| O17 | ACCEPTED | OBSERVED V1. Validation before sending, read back from `thinking_level_changed` (§2.1, §7.2) |
| O18 | ACCEPTED | OBSERVED V3. Normalization order (§4.3 step 2) |
| O19 | ACCEPTED | SOURCE `rpc-mode.ts:174-181`; `UserMessage.content` string (`up_ai_src_types.ts:1030`). Rows added (§6.2) |
| O20 | ACCEPTED | SOURCE `agent-session.ts:6714-6735` (the review cited the custom-message path at `:6950-6965`; the prompt path behaves the same). `streamingBehavior:"followUp"` on every prompt, retry path removed (§5.1) |
| O21 | ACCEPTED | SOURCE `approval.ts:68-73`; DOCUMENTED `config-usage.md:167-178`. Precedence corrected (§2.1) |
| W1 | ACCEPTED | OBSERVED WC1; coordinator lines confirmed. Sanitizing (§6.4), old clients also filtered (§9.5), fixture (§9.6) |
| W2 | ACCEPTED | commit `609e406a` first in tag `bridge/v1.72.2` (checked with `git tag --contains`); `bridge_service.dart:1489-1525`. Gate in `send()`, local errors, provider-mismatch check (§9.5) |
| W3 | ACCEPTED | `bridge_service.dart:531`, `:643`, `:945`, `:965`. `OmpSupport` three states, last value per target while disconnected (in memory only), `/version` capabilities (§9.1, §10.2) |
| W4 | ACCEPTED | `websocket.ts:2785-2789`, `:9543-9591`. `supportedProviders` declaration and per-client filtering; omp is hidden from undeclared clients; re-send after capabilities (§9.5) |
| W5 | ACCEPTED | same as A4 (§10.2) |
| W6 | ACCEPTED | `session.ts:666-677` appends every non-delta message. `omp_settings` delivered outside history plus snapshots, app filter (§3.1, §10.2) |
| W7 | ACCEPTED | fixtures and tests for the old-app payload, the widened literal checks, server messages, and a `main`-app pass (§9.6, §11.1, §11.4) |
| W8 | ACCEPTED | `websocket.ts:8246-8249`, `:8289-8292`. `BRIDGE_PROTOCOL_CAPABILITIES`, `docs/protocol-versioning.md` in WP2 (§9.1) |
| W9 | ACCEPTED | SOURCE agent `thinking.ts:8-17`. Levels filtered to `OMP_THINKING_LEVELS` (§7.1) |
| W10 | ACCEPTED | `websocket.ts:2683-2685`. Fields absent until the first refresh, `ompAvailability` (§7.1) |
| W11 | ACCEPTED | `session_list_cubit.dart:419-420`. `providers[]` behind `provider_omp_v1` (§6.1, §9.2, §10.2) |
| W12 | ACCEPTED, partly moot | with old clients filtered (W4) the Claude-screen degradations no longer occur. Kept: `resolve_session_link` matches a live session by Bridge id across providers (§10.3), `clientMessageId` carried through the queue (§5.2) |
| W13 | ACCEPTED | `websocket.ts:9480` vs `sdk-process.ts:580` and `result_chip.dart:35-36`. Divide by 1000 at the shared line (§8.5) |
| W14 | ACCEPTED | same as A19 (§10.2) |

## 15. Implementation deviations

The implementation (commits `58ba8db2`…`00a076cd` on `feat/omp-provider`) follows §1–§12 except for the rows below. The work packages recorded their deviations while implementing; this section keeps every one that is still true in the code at `00a076cd`, drops the ones that were later reverted, and describes the final state where a review fix (`46b6ea3b`, `5318ca6a`) changed a row. Changes that `46b6ea3b` already wrote into §2.6, §7.2, §8.0 and §8.1 are not repeated. Code is cited by symbol; the `path:line` citations of §1–§14 refer to the design base `177aac14`.

Lead amendment A1, made during implementation, replaces the opt-in decision of §13.1: omp is enabled by default, with a one-time migration of stored tab lists (§15.4). The work packages did not edit the design sections (lead amendment A3); this section and the short pointers in §1–§13 record the result.

### 15.1 Bridge: process, store and helper modules

| Section | What the code does | Why |
|---|---|---|
| §2.4 step 7, §3.1 | `thinkingLevels` in `system/init` and `system/omp_settings` come from omp's own model object (`get_state.model`, the `set_model` response, `config_update.model`) as `["off", ...thinking efforts]` filtered to `OMP_THINKING_LEVELS` (`ompThinkingLevelsFor`); `listOmpModels` uses the same helper. | `OmpProcess` has no access to the model cache, which lives in `BridgeWebSocketServer`. OBSERVED P10: the result equals omp's `get_available_thinking_levels`. |
| §4.1 steps 4–5 | An argument value counts only as a whole detail value: it starts right after `Label:` plus whitespace (same line, or the next line for `Content:` followed by the value) and ends at a line end; a 120-character prefix counts when omp's `[…Nch elided…]` marker follows it. For `edit` the target paths from the patch sections count as argument values. Ties go to the longer matched text, then to call order (`bindApproval`, `approvalTextHasValue`). | Substring matching bound the inner `eval` approval "Command: ls -la" to a parallel `bash {command:"ls"}`. omp formats every built-in detail as `Label: value` (SOURCE `tools/bash.ts:562-566`, `tools/write.ts:428-433`, `edit/index.ts:395-404`). A hashline `edit` has only `{input}` and would always score 0, which would leave the "append Patch:" rule dead. |
| §4.1 step 6 | A call that ends (`tool_execution_end`, or `rpc_frame_error` for it) while its bound approval is still open was bound wrongly: the Bridge emits `permission_resolved` for the call's id and re-emits the dialog as an unbound `omp-approval:<dialogId>` request with omp's detail lines. The `rpc_frame_error` fallback prefers unended calls without an open approval. | omp waits for the approval select without a timeout (SOURCE `extensibility/extensions/wrapper.ts:334-342`), so answer, interrupt and stop must still reach the dialog. |
| §4.3 flow step 1 | An answer that `answer()` stored before the first ask frame is replayed into the frames; the Bridge emits no `permission_request` and no `permission_resolved` for that call. | A `permission_request` would still send the "is asking a question" push and put a pending entry on the session card for a question the user has already answered. |
| §3.3 table | Extra input shapes: patch-mode `edit` (`{path, edits}`) also maps to `FileChange`; apply_patch `Add File`/`Delete File` and hashline `REM` give kind `add`/`delete`; results use `details.perFileResults[].diff` per file when present, else `details.diff` under the first target path, else the text. `Edit` keeps `replace_all`. `Task` also covers omp's single shape `{agent, task}` as `{description: intent ?? task, prompt: task, subagent_type: agent}`. The `AskUserQuestion` input carries no `recommended` index. | These are the shapes of omp's edit and task tools (SOURCE `edit/schemas.ts:3-8`, `edit/index.ts:260-268`, `task/types.ts:68-96`); without `replace_all` the inline diff would hide that every occurrence is replaced; the Bridge never reads `recommended`. |
| §3.3 `todo` rule, §6.2 | A `todo` call whose result is an error is emitted as a generic `todo` `tool_use` before its plain `tool_result`, live and in history. | Otherwise the app gets a result without a call. |
| §5.3 step 1 | `OmpProcess.steer()` while not busy rejects with `omp_steer_not_busy` and writes nothing; the caller sends a prompt instead. | An idle `steer` starts a run without a `prompt_result` (OBSERVED V3). |
| §2.4, §7.2 step 1 | Commands issued while `starting` (first start or respawn) wait in the process and are written after the handshake; a queued model change is applied before `input_ready`; a prompt sent while a model change is applied waits for it. When that queue is dropped (stop, failed start or respawn, failure before the spawn), every queued command and a pending `setModelSettings` reject with `omp_process_exited`. A `setModelSettings` request replaced by a newer one resolves. | Keeps `set_model`, `set_thinking_level` and the prompt in stdin order; before, the promises of queued commands never settled. |
| §7.2 step 4 | When `set_model` succeeded and `set_thinking_level` then fails, the Bridge reads the level back once with `get_state` and emits `system/omp_settings` before rejecting with `set_omp_model_failed`. The success path sends no `get_state`. | Otherwise the app rolls back to a model omp no longer uses (the §10.1 rollback is cleared by the next `omp_settings`). |
| §7.3 steps 3–4 | `setApprovalMode` resolves `{applied:"now"}` as soon as the respawn starts; the outcome arrives as messages: `system/set_permission_mode` after the handshake, or `omp_respawn_failed` followed by `exit`. | §7.3 step 4 already delivers the outcome as messages; the caller does not wait for the respawn. |
| §6.6 step 4, §6.7 | `branch()` emits no `system/init`, moves the writer registration from the old file to the new one and resets the entry cursor. | The websocket replaces the Bridge session (§6.6); an init would move the old session's `claudeSessionId`. |
| §2.4 step 1, §6.3, §6.7 | The writer registry adds `acquire(file, {owner, sessionId})`, which waits and reserves in one synchronous step; the reservation is handed the child's `exited` (`holdUntil`), or released when no child was spawned. `OmpProcess` acquires before every `--resume` spawn and `renameOmpRecentSession` before its helper; `ownerBySessionId` reports reservations. `register` stays for files known only after the handshake (new session, `branch`) and takes over the process's own reservation. Also `release(file, owner)` (used by `branch`; wakes waiters at once) and `files()` (read by doctor). `waitForRelease` reserves nothing. | With `waitForRelease` followed by `register`, two waiters released by the same exit both proceeded, and a resumed file was unguarded during spawn and handshake, so a rename in that window started a second writer. |
| §6.1 step 2 | A bucket matches when any file header in it records the project's cwd: the set of header cwds is cached by bucket mtime, headers per path. | Colliding bucket names (`/a-b` and `/a/b` both encode to `-a-b`) made the newest-file rule drop matching files. |
| §6.1 step 4 | When the head window has no user message, the bounded 16 MiB scan runs even if the tail window has one; the tail's first user text is used only when the scan finds none. A file whose read fails (EACCES, or ENOENT when omp archives it between stat and read) is skipped with a warning. | The first user message in the tail is not necessarily the first prompt. One unreadable file rejected the whole listing and made `getOmpSessionName` reject. |
| §6.1 store location, §8.0 | `resolveOmpStore` follows omp's resolver (SOURCE `packages/utils/src/dirs.ts`): a profile name omp rejects is reported as `invalidProfile`, and the listing and `findOmpSessionFile` then return nothing; a `PI_CODING_AGENT_DIR` equal to the agent dir of `PI_PROFILE` is ignored in the default profile; the override path is `resolve()`d. | omp fails every command with "Invalid OMP profile" for such a name, so no listed session could be resumed; before, the Bridge silently listed the default store. |
| §7.1 | `listOmpModels` rejects with `omp_models_failed` on a timeout, output above 8 MiB or invalid JSON; a non-zero exit still gives `no_models`. | The websocket keeps its previous list on a rejection ("a failed refresh keeps the previous list"). |
| §6.3 | `renameOmpRecentSession({sessionId, name, projectPath?, env?, writers?})`: cwd is the recorded cwd if it exists, else `projectPath` if it exists, else `homedir()`; an unknown session answers `false`; a `set_session_name` failure rejects with omp's message. | A spawn with a missing cwd fails (row "§2.6, §8.0" below). |
| §6.2 | `imageCount` counts every image block; `ompImages` keeps only valid `blob:sha256:<64 hex>` refs whose blob file exists and is at most 8 MiB, at most 4 per message, on user messages and tool results. User-run `bashExecution`/`pythonExecution` entries append `[cancelled]` or `[exit code N]` to the output. The `type`, `id`, `parentId` and `role` of a line above the line limit are read from its first 4096 characters, so the path walk continues past the "[omitted line]" marker. | A missing blob is not offered as an image, and one oversized line must not cut the active path. |
| §2.6, §8.0 | With a missing spawn cwd the transport reports `omp_start_failed` "omp could not be started: the working directory does not exist: <cwd>" and `runOmpPrint` `omp_print_failed` with the same text; `omp_cli_not_found` stays for a missing binary. | Node reports `ENOENT` for a missing cwd as well as for a missing binary. |
| §8.0 assist model | `runOmpPrint` applies the rule itself (`resolveOmpAssistModel`): a trimmed, non-empty `BRIDGE_OMP_ASSIST_MODEL` wins over the passed session model. | Both assist callers (§8.1, §8.2) then pass only `session.ompSettings.model`. |
| §8.0 `jsonl-partial.ts` | Also exports `readJsonlLines` (LF-only streaming with a per-line limit that keeps a prefix of oversized lines), shared by history, the first-prompt scan and lazy image extraction. `decodeJsonStringPrefix` trims at most 16 trailing characters and removes a trailing lone high surrogate; for valid prefixes without a cut pair its output equals the old helper's. `sessions-index.ts` imports it. | One streaming reader instead of three; the old helper looped over the whole string and kept half of a cut surrogate pair. |
| §6.2, §12.3 interfaces | Additive to the §12.3 block: `OmpProcess` constructor options `env`, `overlayPath` and `transport` (transport options, not an instance) and the getter `thinkingLevels`; `OmpWriterRegistry.acquire`/`release`/`files`; `{env}` options on `findOmpSessionFile` and `getOmpSessionName`, `{blobsDir}` on `readOmpBlob` and the history options, `{env, blobsDir}` on `extractOmpMessageImages`, `env` on `runOmpPrint`; `getOmpSessionHistory` returns `OmpSessionHistoryMessage[]` (`SessionHistoryMessage` plus `ompImages`; `SessionHistoryMessage` in `sessions-index.ts` has no such field); `OmpStore.invalidProfile`; further exports such as `getOmpSessionSettings`, `resolveOmpAssistModel`, `missingSpawnCwd`, `OMP_SERVICE_ENV_VARS`/`ompServiceEnvironment`, `onChildClosed`, `parseOmpModels`, `normalizeAskTitle`, `parseAskAnswers`, `newUserEntriesOnPath`, `ompError`/`ompErrorCode`, `buildOmpRpcArgs`, `buildOmpSpawnSpec`, `buildOmpPrintArgs`, `clearOmpSessionCaches`. | Tests must neither write `~/.ccpocket` nor read the user's store; WP1 could not edit `sessions-index.ts`; the websocket, doctor, setup and tests use the extra helpers. |
| §9.3 error codes | `omp_command_timeout`, `omp_steer_not_busy`, `omp_print_failed`, `omp_print_timeout` and `omp_models_failed` exist only as codes of rejected promises and are never sent. | The wire codes stay those of §9.3. |

### 15.2 Bridge: wiring into `SessionManager` and the WebSocket server

| Section | What the code does | Why |
|---|---|---|
| §9.3, §11.1 | `start` sends `session_created` at once, as for Codex, without awaiting `waitUntilReady()`. The session is created with `deferProcessMessages`, so `omp_cli_not_found`, `omp_start_failed`, `omp_unsupported_platform` and every other process message arrive after `session_created`. Only resume waits for readiness (§6.4 step 9). | §9.3 asks only for deferred coded errors; the deferral keeps their order behind `session_created`. |
| §6.4 step 6, §9.3 | `executionMode` is `deriveExecutionMode({executionMode, permissionMode, provider:"omp"})` (a valid `executionMode` wins). The tip `omp_mode_mapped` is sent when the request has `planMode:true` or `permissionMode` `plan`/`auto`, also next to a valid `executionMode`; for start and resume alike (`ompModeFromRequest`). | The old app's payload (`legacy-app-omp-resume.json`) sends `executionMode:"default"` next to `permissionMode:"plan"`, so the literal rule never reached its mapping branch. |
| §6.4 step 6 | A `thinkingLevel` without a known effective model (start with "omp default", resume of a file without `model_change`) is kept when it is a valid `OmpThinkingLevel`; with a known model it must be offered by that model. | The Bridge cannot know omp's default model, and omp maps an unsupported level itself and reports it back (OBSERVED V1). |
| §6.4 step 3 | Resume attaches only to a Bridge session whose `OmpProcess.isAlive`. A request without `executionMode` and `permissionMode` requests no mode, and a kept `model`/`thinkingLevel` equal to the live process's settings is not an edit. A Bridge session of the same omp id whose child exited is replaced: it is destroyed after the new session's `session_created`, and a failed resume leaves it as it was. | Attaching to an exited child would open a session that cannot run; repeating the live settings is not "different from the live session's". |
| §6.4 step 10 | The resume `session_created.projectPath` is `resumeProjectPath`, as in the Claude branch, with `worktreePath`/`worktreeBranch` only when a worktree mapping exists. | §6.4 step 8 creates the session from `msg.projectPath`; the Codex rule `wtMapping?.projectPath ?? resumeProjectPath` does not apply (fixture `omp-session-created.json`). |
| §6.3 running session | `rename_session` goes through the process only when its child is alive. For a Bridge session whose child exited, the short-lived rename process runs (with the session's `claudeSessionId` and `ompCwd`, by Bridge id or from the recent list), and the Bridge session keeps the new name in memory. | `set_session_name` cannot reach an exited child, and the file has no other writer then. |
| §4.1 answer path | The denial note is steered and appended as `user_input` only when the rejected item is an approval; declining a question or dialog sends no note. | `reject` answers a question or dialog with `{cancelled:true}` (§4.3 step 7, §4.4); there is no tool denial for a note to explain. |
| §6.6 step 6 | `SessionInfo` carries `ompCwd` and `ompAdditionalDirectories` (set in `create()`); the rewound session starts with the same `--cwd` and `--add-dir` roots. | `OmpProcess` keeps its cwd private. |
| §7.3, §9.3 mode flow | `set_permission_mode` for a session whose child has exited answers `omp_respawn_failed`. | The app rolls the chip back only on `omp_mode_unsupported` or `omp_respawn_failed` (§10.1). |
| §7.2 | When the model does not change and is not catalogued, the level is checked against the process's own `thinkingLevels`; an `omp_process_exited` from `setModelSettings` is reported as `set_omp_model_failed`. | The process knows the levels of its current model (§15.1); `set_omp_model_failed` is the app's rollback code. |
| §5.2 | Input for an idle process is queued, not sent, while the slot still holds an item, and a full slot rejects with "Queue is full". An `input_ready` that arrives while the asynchronous process-message chain is busy (image tool results) drains after the chain; the per-session `ProcessMessageDeliveryState` (`processingAsync`, `drainQueueAfterProcessing`) guards every drain path (`input_ready`, idle steer, failed steer). Codex follows the same rules. | A new input overtook the queued one, and a drained item was appended before the previous run's `result`. Codex shares the listener and the drain. |
| §5.3 step 2 | `update_queued_input` and `cancel_queued_input` for an item whose steer is in flight answer "Queued message not found.". | The item is detached while the steer is awaited. |
| §9.5 | "All" in `list_recent_sessions` from a client that did not declare omp is rewritten to `providers:["claude","codex"]` before the query. | Filtering the page per client afterwards would distort pagination. |
| §9.2 | `client_capabilities.supportedProviders` is typed `string[]`; unknown names are ignored. | "unknown strings ignored" needs a type that admits them. |
| §8.4 | `ProviderResult` has optional `warnings` and `details`, and omp warnings make "CLI providers" a warning. The "live omp session outside the store" check reads `OmpWriterRegistry.files()`, so it works in the Bridge's `/doctor` but finds nothing in a separate `ccpocket-bridge doctor` process. The XDG warning follows omp's rule (only when `XDG_DATA_HOME` is set and `<XDG_DATA_HOME>/omp` exists); `invalidProfile` is a warning. | The doctor runs without access to the WebSocket server; omp itself relocates only under that condition (SOURCE `packages/utils/src/dirs.ts:360-380`). |
| §8.6 | Setup persists the variables of `OMP_SERVICE_ENV_VARS` (`ompServiceEnvironment()` in `omp-env.ts`); a defined `OMP_PROFILE` is persisted even when empty; new systemd values with whitespace or quotes are quoted and plist values XML-escaped. | A defined `OMP_PROFILE` wins over `PI_PROFILE`, also when empty. |
| §7.1 | A failed first catalogue refresh leaves the `session_list` fields absent; later refreshes retry (next connect after the cooldown, every start or resume that names a model). After the first load a changed catalogue triggers a broadcast; a selector a session reports but the catalogue lacks triggers one refresh per selector. | Absent fields mean "loading" in the app; an empty list would read as "not detected". |

### 15.3 Wire fixtures

| Section | What the code does | Why |
|---|---|---|
| §9.6 | `omp-list-recent-sessions.json` and `omp-session-created.json` hold an array of variant messages (`providers` and `provider:"omp"`; start and resume); consumers load `Array.isArray(json) ? json : [json]`. | §9.6 asks for two recent-list variants, and the start and resume `session_created` differ in their field sets, so one object could not cover either pair. |
| §9.6, §11.1 | Server fixtures are key subsets, like the frozen `current-session-list.json`: `session_list`, `recent_sessions` and `session_created` are compared with `toMatchObject`; `omp-init.json`, `omp-settings.json` and the session entries of `session_list` with `toEqual` after substituting instance values. | Claude/Codex metadata and `bridgeVersion` change independently of omp. |
| §9.3 | `sessionId` of `session_created`, `system/init` and `system/omp_settings` on the wire is the Bridge session id; the omp id travels as `claudeSessionId`. | `broadcastSessionMessageNow` overwrites `sessionId` with the Bridge id, as for Codex. |
| §9.6 | `legacy-app-omp-resume.json` was generated by running the unchanged `SessionResumeCoordinator.resume` with Claude plan settings stored under the omp id, so it carries `executionMode:"default"` next to `permissionMode:"plan"` and `planMode:true`. `omp-client-capabilities.json` lists a short explicit `supportedServerMessages`. | The real payload of an old app; the short list keeps the fixture stable when the app's default list grows. |

### 15.4 App core

| Section | What the code does | Why |
|---|---|---|
| §9.5, §10.2, §12.5 | `bridgeUpdateRequired` is a bool on `OfflinePendingAction`, not an `OfflinePendingActionState` value; the action keeps `state: queuedForReconnect` and `canCancel: true`. `BridgeService` sets it while the connected Bridge lacks `provider_omp_v1` (`ompSupport == unsupported`) and the action needs omp. | `home_content.dart` switches exhaustively over `(action.state, action.kind)`; a third state was a compile error in a widget outside WP3. |
| §9.5 send gate | Offline-queued omp `start`/`resume_session` stay queued (the flush skips them) and are sent once a capable Bridge connects. Direct messages without `provider_omp_v1`: `start` → local `bridge_update_required` with its `requestId`; `resume_session` → local `session_resume_failed`, then the error carrying `sessionId` and `requestId` (the shape of `failResumeOperation`); `resolve_session_link` → error, resolution `unavailable`; `list_recent_sessions` → error plus `recent_sessions_failed`; `archive_session` → error plus `archive_result {success:false}`; `rename_session` → error plus `rename_result {success:false}`; `set_omp_model` → error. | Every blocked request gets an answer, so no list, dialog or pending resume keeps waiting. |
| §9.5 second line, §10.2 `bridge_service.dart` | The provider-mismatch check covers only starts that requested omp (tracked by `requestId`): such a `session_created` is not forwarded, a local `bridge_update_required` with that `requestId` is emitted, and the created session is not stopped. | Claude and Codex starts stay unchanged, so older Bridges that omit the field are not affected. |
| §9.5 | On a connection's first `session_list` from a Bridge that advertises `provider_omp_v1`, the app keeps the omp sessions cached from the previous connection until the full list arrives (`_withCachedOmpSessions`); omp sessions that ended meanwhile stay listed until then. | That first list is sent before `client_capabilities` and leaves omp sessions out. |
| §10.2 `chat_message_handler.dart` | `ChatMessageHandler.handle(..., isOmp:)`: for omp only `msg.claudeSessionId` sets the provider session id, never the `sessionId` fallback. | The wire `sessionId` is the Bridge id (§15.3), which would re-key the per-session store to the Bridge id on every `omp_settings` or tip. |
| §10.1 per-session settings | "Whenever it changes" applies to omp only (`_persistSessionIdSettings`): omp writes `{permissionMode, executionMode}` on every omp id change, from updates and from `_applySessionContext`; Claude keeps the first-id write with `{permissionMode, sandboxMode}`; Codex writes nothing. | For Claude the handler flips the id between the Bridge id and the Claude id, which would rewrite the store on every flip. |
| §10.2 `session_list` rows | "All" sends `providers:[…]` for several effective providers and `provider:<it>` for exactly one. The cubit keeps the user's filter (`_preferredProviderFilter`) apart from the shown one and re-coerces on `ompSupportStream` and on every change of the enabled agents, which it reads from `SettingsCubit` (constructor `enabledTabs`, `enabledTabsChanges`). Hiding omp because support is `unknown` **or** `unsupported` changes only the shown filter; a coercion caused by disabling an agent is persisted. | `provider` is understood by every Bridge. The screen called `applyEnabledAgents` only when the shown filter changed, so a disabled agent stayed in "All". Amendment A1 ("nothing is persisted from that coercion") lets a stored omp filter survive a visit to an older Bridge. |
| §10.2 `new_session_tab.dart`, `settings_cubit.dart`, §13.1 | omp is enabled by default: `defaultNewSessionTabs` is `[codex, claude, omp]`, and `SettingsCubit._load` appends omp once to a tab list stored before omp existed (flag `settings_new_session_tabs_omp_migrated_v1`, set on every first load including fresh installs, so a later "omp disabled" is kept). omp is still offered only while `ompSupport == supported` (`effectiveProviders`). | Lead amendment A1. |
| §10.2 `session_link` rows | `BridgeService.waitForConnectionOmpSupport({timeout})` returns the current connection's value once its `session_list` arrived, and `unknown` on timeout or after an intentional disconnect; `SessionLinkCubit` maps `unknown` to `unavailable`. | `ompSupport` falls back to the last value seen for the target, which is not "known for this connection". |
| §10.2 effective providers | The fallback is "empty → `{claude, codex}`". `visibleNewSessionTabs(enabledTabs, ompSupport)` in `models/new_session_tab.dart` builds the new-session and settings tabs and appends a fallback provider's tab when that provider has no enabled tab. | The middle step of the doc rule is always empty, so the results are the same; one helper replaces copies in two screens. |
| §10.1 `setOmpModel` | Rollback also on the local `bridge_update_required` and on `unsupported_message` for `set_omp_model`. Without an unconfirmed change only the changed fields are sent; with one, the whole optimistic target model is sent, with the requested level, else the optimistic level if the target offers it. | A second change before confirmation must be validated against the model the user sees, not against the last confirmed one. |
| §6.3, §10.2 | A failed omp `rename_result` whose name is empty becomes an `ErrorMessage(errorCode:'omp_name_cannot_be_cleared')` transcript entry, rendered with `ompNameCannotBeCleared` in the warning tone. | The existing error bubble shows it; other rename failures stay logged. |
| §12.5 interfaces | `OmpSupport` is defined in `models/messages.dart` and re-exported from `services/bridge_service.dart`. Additions: `waitForConnectionOmpSupport`, `BridgeService.ompProviderCapability`, `patchSessionOmpModel(clearModel:, clearThinkingLevel:)`, `resumeSession(thinkingLevel:)`, `SessionInfo.copyWith(clearOmpModel:)`, `ChatSessionCubit.rewindResults`, `providerFiltersForEnabledTabs(..., ompSupport:)`, `appSupportedProviders`, `visibleNewSessionTabs`. `EnabledAgentsMode`, `enabledAgentsModeFromTabs`, `tabsForEnabledAgentsMode` (the doc's `tabsWithEnabledAgentsMode`) and `setEnabledAgentsMode` are deleted. | Models must not import services, and `new_session_tab.dart` needs `OmpSupport`; the rollback must be able to clear a cached model. |

### 15.5 App UI

| Section | What the code does | Why |
|---|---|---|
| §4.3 step 7, §10.2 omp screen | `OmpAskDeclineBar` sits under the question widget in the omp screen: the `ompAskDeclineAborts` note and a Reject button (`omp_ask_decline_button`) calling `reject`. Generic §4.4 dialogs (`omp-dialog:`) get the button without the note. | The shared `AskUserQuestionWidget` has no decline action, and the input with its stop button is hidden while a question is pending; only the `ask` cancel is observed to abort the turn (P2e). |
| §4.2, §10.4 | The omp chat screen uses the Codex approval labels ("This Session") and shows `OmpApproveAlwaysScopeNote` (`ompApproveAlwaysScope`) under the approval bar whenever approve-always is offered. | `widgets/approval_bar.dart` was outside the WP4 change set. |
| §10.2 omp screen | No retry of failed messages on reconnect either; the omp screen only refreshes the history. | A message fails only through `input_rejected` (`omp_process_exited`), so a resend reaches the same dead process, and a retry while busy would be queued as a second entry. |
| §10.2 `omp_settings_sheet.dart` | The running-session sheet shows "omp default" only as the selected row while the session model is unknown; the new-session sheet offers it as a real choice (no `--model`). | `set_omp_model` needs a selector (§7.2), so a running session cannot switch back to omp's configured default. |
| §10.2 `new_session_sheet.dart`, §9.3 start | The thinking-level field is offered only with a catalogue model (all seven levels for a kept model before the catalogue arrives), and the start carries `thinkingLevel` only together with `model`. The sheet follows `ompModels`/`ompAvailability` while it is open (a model the new catalogue lacks falls back to "omp default"; no availability yet shows "loading") and shows `ompNotDetected`/`ompNoModels` under the model field. | The level list comes from the chosen model, and for "omp default" the app does not know it; the first `session_list` of a connection carries no catalogue. |
| §9.5, §10.2 `session_list_screen.dart` | `_startNewSession` refuses an omp start with the `ompStartNeedsBridgeUpdate` snackbar and opens no pending page when the gate would fire (connected, this connection's `session_list` answered, `ompSupport != supported`); before that answer the start goes to the offline queue and its pending card. An omp `session_resume_failed` from the recent list shows a snackbar (`omp_resume_failed_snackbar`) with title, message and hint. | A pending page for a start the gate blocks could only turn into an error; a resume from the list opens no chat whose error bubble could explain the failure. |
| §10.2 settings rows | The chip guard keeps at least one other **offered** agent enabled (omp counts only while supported), stricter than the cubit's last-enabled-agent rule. The omp chip is disabled, keeping its stored selection, while `ompSupport == unsupported`. The tab-order row appears only with more than one offered agent, and the chips follow `ompSupportStream` and every `session_list`. `showNewSessionTabsBottomSheet(offerOmp:)` hides the omp row unless omp is supported and saves a hidden but enabled omp tab back at its index. | Disabling the last offered agent would leave no usable tab; `ompAvailability` arrives with the second list without changing `ompSupport`; the order and the default tab must not change through the Bridge coercion (A1). |
| §6.6, §10.4 | A refused conversation rewind (`rewind_result {success:false}`) restores the composer text and shows the added key `ompRewindFailed` ("Rewind failed: {error}"). | §6.6 defines the failure result but no UI for it. |

### 15.6 Tests, live E2E and commits

| Section | What the code does | Why |
|---|---|---|
| §11.1 fixtures | `omp-fixtures/` holds one `{"dir":"IN"\|"OUT","frame":{…}}` line per frame in observed order (the tests compare the Bridge's own writes with the IN lines and map the probe's response ids), six session files copied from the probe session directories, and `p10-models.jsonl` with one model per line. The frames are verbatim except for parts the Bridge never reads: `get_state` without `systemPrompt` and tool dumps, `message_update` without snapshots, `turn_end` without `message`/`toolResults`, `agent_end.messages` as `[]`, three builtin commands in `available_commands_update`, a neutral MCP mount notice, and `$HOME` as `/home/user`. | Keeps the user's system prompt, command list, MCP server names and home path out of the repo, and every fixture matches the `omp-fixtures/*.jsonl` pattern of §12.3. |
| §11.1 | The omp WebSocket cases live in the new `websocket-omp.test.ts`, which runs the real `BridgeWebSocketServer`, `SessionManager` and `OmpProcess` with only `spawn` faked by a scripted omp RPC child and `HOME`/`PI_CODING_AGENT_DIR` in a temp dir; it also builds the `omp-session-list.json` entry from a real resumed session. `websocket.test.ts` only got the omp module mocks (`omp-sessions`, `omp-print`, `omp-writers`, `providerSupportsQueuedInput`), the async `git_commit` updates, the push tests and the Codex queue cases. | `websocket.test.ts` replaces `SessionManager` with a hand-written mock, so omp cases there would test the mock. |
| §11.2 | The pending-card case is in `home_content_skeleton_test.dart` (the `HomeContent` harness) and `visibleNewSessionTabs` is tested in `new_session_tab_test.dart`; new files also include `rename_session_dialog_test.dart` and `new_session_tabs_bottom_sheet_test.dart`. | `home_screen_test.dart` holds only pure function tests. |
| §11.3 | The test Bridge runs with `HOME=<E2E root>/bridge-home` and `PI_CODING_AGENT_DIR` set to the user's resolved agent dir; omp is spawned through a wrapper that restores the user's `HOME`, `OMP_PROFILE`, `PI_PROFILE`, `PI_CONFIG_DIR` and `PI_CODING_AGENT_DIR`. Options `--omp-bin`, `--session-dir` (sessions under the run directory instead of the user's store), `--steps`, `--cleanup` (also removes artifact directories and the emptied bucket) and `--no-start-bridge`. Added step 2b (rename before the session file exists); step 16 samples the process tree for overlapping writers; SIGINT and SIGTERM run the same teardown (exit 130/143). A fresh test Bridge signs in to the push relay with a new anonymous identity. The recorded live runs used `--session-dir`; the default mode was not run live. | `~/.ccpocket` stays untouched while omp uses the user's configuration and credentials; with `--session-dir` no session lands in the user's store. |
| §6.3, §13.2 risk 1 | "Rename before the file exists" is OBSERVED for omp v18.3.2 (E2E step 2b: rename right after `system/init`, then the first prompt; the file and the recent entry carry the early name). | The live E2E covers the case §6.3 names, so it is no longer only DOCUMENTED. |
| §12.1 | The push-duration fix is part of `a596f9f5` (`feat(bridge): wire omp provider`), not a separate `fix(bridge)` commit. The review fixes followed as `46b6ea3b` (Bridge), `5318ca6a` (app) and `00a076cd` (E2E cleanup). | Records where the planned commits actually landed. |

Open item recorded during implementation (not a deviation from this design): an input that meets an idle omp with an empty queue slot while the previous run's messages are still processed asynchronously (image tool result) is sent at once, and its `user_input` is appended before that run's `result`. Codex has the same window. Queuing such input would change the ack to `queued:true` and existing Codex behaviour, so it was left as it is.
