import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, fakeChildren } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  fakeChildren: [] as FakeChildProcess[],
}));

class FakeWritable extends EventEmitter {
  public writes: string[] = [];
  public ended = false;
  /** Node v24: write() after end() returns false, emits nothing, loses the line. */
  write(chunk: string): boolean {
    if (this.ended) return false;
    this.writes.push(chunk);
    this.emit("write", chunk);
    return true;
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.emit("end");
  }
}

class FakeReadable extends EventEmitter {
  setEncoding(_encoding: string): void {}
}

class FakeChildProcess extends EventEmitter {
  public stdout = new FakeReadable();
  public stderr = new FakeReadable();
  public stdin = new FakeWritable();
  public pid: number | undefined = 5150;
  public signals: string[] = [];
  constructor(public command: string, public args: string[], public options: { cwd: string; env: NodeJS.ProcessEnv }) {
    super();
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
  /** Node order: `exit`, then `close` once stdio is drained. */
  exit(code: number | null): void {
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
  newUserEntriesOnPath,
  normalizeAskTitle,
  OmpProcess,
  parseAskAnswers,
} from "./omp-process.js";
import {
  approvalModeFor,
  legacyPermissionModeFor,
  type OmpProcessMessage,
  type OmpStartOptions,
} from "./omp-types.js";
import { createOmpWriterRegistry, type OmpWriterRegistry } from "./omp-writers.js";

type Frame = Record<string, unknown>;
type Record_ = { dir: "IN" | "OUT"; frame: Frame };

const FIXTURES = fileURLToPath(new URL("./omp-fixtures/", import.meta.url));

/**
 * Probe fixtures (omp v18.3.2, docs/omp-integration.md P<n>/V<n>): one
 * `{dir: "IN"|"OUT", frame}` line per frame, in the order observed. Frames are
 * verbatim except for parts the Bridge never reads: get_state systemPrompt and
 * dumpTools, message_update snapshots, turn_end payloads, agent_end.messages
 * (replaced by []), the command list (three builtins kept) and the MCP mount
 * notice text. IN frames are what the probe wrote; ids in responses are the
 * probe's and are mapped to the Bridge's ids on replay.
 */
function fixture(name: string): Record_[] {
  return readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record_);
}

const READY = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
};

/** get_state data as OBSERVED in V1 (system prompt and tool dump removed). */
const OBSERVED_STATE: Frame = (() => {
  const record = fixture("v1-thinking-and-name.jsonl").find(
    (r) => r.frame.type === "response" && r.frame.command === "get_state",
  )!;
  return record.frame.data as Frame;
})();

const GLM = OBSERVED_STATE.model as Frame;

/** A fake omp that records commands and answers the ones it was told to. */
class OmpSim {
  readonly commands: Frame[] = [];
  readonly handlers = new Map<string, (command: Frame) => unknown>();

  constructor(readonly child: FakeChildProcess) {
    child.stdin.on("write", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const command = JSON.parse(line) as Frame;
        this.commands.push(command);
        const handler = this.handlers.get(String(command.type));
        if (handler && typeof command.id === "string") {
          const data = handler(command);
          if (data !== MANUAL) this.respond(command, data);
        }
      }
    });
  }

  send(frame: Frame): void {
    this.child.stdout.emit("data", `${JSON.stringify(frame)}\n`);
  }

  respond(command: Frame, data?: unknown): void {
    this.send({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      ...(data !== undefined ? { data } : {}),
    });
  }

  fail(command: Frame, error: string, code?: string): void {
    this.send({ id: command.id, type: "response", command: command.type, success: false, error, ...(code ? { code } : {}) });
  }

  last(type: string): Frame | undefined {
    return this.commands.filter((command) => command.type === type).at(-1);
  }

  ofType(type: string): Frame[] {
    return this.commands.filter((command) => command.type === type);
  }

  /** Replay OUT frames from `from` until the next IN frame; returns its index. */
  play(records: Record_[], from: number, ids: Record<string, string>): number {
    for (let index = from; index < records.length; index++) {
      const record = records[index];
      if (record.dir === "IN") return index;
      let frame = record.frame;
      if ((frame.type === "response" || frame.type === "prompt_result") && typeof frame.id === "string") {
        const mapped = ids[frame.id];
        if (!mapped) continue; // a probe-only command
        frame = { ...frame, id: mapped };
      }
      this.send(frame);
    }
    return records.length;
  }
}

const MANUAL = Symbol("manual");

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

let tmp: string;
let overlayPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "omp-process-"));
  overlayPath = join(tmp, "overlay.yml");
  spawnMock.mockReset();
  fakeChildren.length = 0;
  spawnMock.mockImplementation((command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
    const child = new FakeChildProcess(command, args, options);
    fakeChildren.push(child);
    return child;
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(tmp, { recursive: true, force: true });
});

interface Harness {
  proc: OmpProcess;
  sim: OmpSim;
  child: FakeChildProcess;
  messages: OmpProcessMessage[];
  statuses: string[];
  inputReady: ReturnType<typeof vi.fn>;
  writers: OmpWriterRegistry;
  byType: (type: string) => Frame[];
}

function defaultHandlers(sim: OmpSim, state: Frame): void {
  sim.handlers.set("negotiate_protocol", () => ({ protocolVersion: 2 }));
  sim.handlers.set("set_interrupt_mode", () => undefined);
  sim.handlers.set("get_state", () => state);
  sim.handlers.set("get_entries", () => ({ entries: [], leafId: null }));
}

function createProcess(env: NodeJS.ProcessEnv = { PATH: "/bin" }, platform: NodeJS.Platform = "linux") {
  const writers = createOmpWriterRegistry();
  const proc = new OmpProcess({ platform, writers, overlayPath, env });
  const messages: OmpProcessMessage[] = [];
  const statuses: string[] = [];
  const inputReady = vi.fn();
  proc.on("message", (message) => messages.push(message));
  proc.on("status", (status) => statuses.push(status));
  proc.on("input_ready", inputReady);
  return { proc, messages, statuses, inputReady, writers };
}

async function startProcess(
  options: Partial<OmpStartOptions> = {},
  state: Frame = OBSERVED_STATE,
  setup?: (sim: OmpSim) => void,
): Promise<Harness> {
  const created = createProcess();
  created.proc.start("/proj", { bridgeSessionId: "bridge-1", executionMode: "default", ...options });
  await vi.waitFor(() => expect(fakeChildren.length).toBeGreaterThan(0));
  const child = fakeChildren.at(-1)!;
  const sim = new OmpSim(child);
  defaultHandlers(sim, state);
  setup?.(sim);
  sim.send(READY);
  await created.proc.waitUntilReady();
  await flush();
  return {
    ...created,
    sim,
    child,
    byType: (type: string) => created.messages.filter((message) => message.type === type) as Frame[],
  };
}

/** Send a prompt and return its RPC id. */
function prompt(h: Harness, text = "hi"): string {
  expect(h.proc.sendInput(text)).toBe(true);
  return String(h.sim.last("prompt")!.id);
}

function assistantEnd(content: Frame[], extra: Frame = {}): Frame {
  return {
    type: "message_end",
    messageId: "msg-2",
    message: { role: "assistant", content, provider: "baseten", model: "zai-org/GLM-5.3-Fast", stopReason: "toolUse", ...extra },
  };
}

function lastOf<T extends string>(h: Harness, type: T): Frame {
  return h.byType(type).at(-1)!;
}

describe("omp execution modes (§7.3)", () => {
  it("maps execution modes to omp approval modes and legacy permission modes", () => {
    expect([approvalModeFor("default"), approvalModeFor("acceptEdits"), approvalModeFor("fullAccess")]).toEqual([
      "always-ask",
      "write",
      "yolo",
    ]);
    expect([
      legacyPermissionModeFor("default"),
      legacyPermissionModeFor("acceptEdits"),
      legacyPermissionModeFor("fullAccess"),
    ]).toEqual(["default", "acceptEdits", "bypassPermissions"]);
  });
});

describe("OmpProcess start and handshake (§2.1, §2.4)", () => {
  it("spawns omp rpc-ui with the overlay and runs the handshake in order", async () => {
    const h = await startProcess({ cwd: "/work/proj", additionalDirectories: ["/extra"] });
    expect(h.child.command).toBe("omp");
    expect(h.child.args).toEqual([
      "--mode", "rpc-ui",
      "--cwd", "/work/proj",
      "--allow-home",
      "--approval-mode", "always-ask",
      "--config", overlayPath,
      "--add-dir", "/extra",
    ]);
    expect(h.child.options.cwd).toBe("/work/proj");
    expect(await readFile(overlayPath, "utf8")).toContain("timeout: 0");
    expect(h.sim.commands.map((command) => command.type)).toEqual([
      "negotiate_protocol",
      "set_interrupt_mode",
      "get_state",
      "get_entries",
    ]);
    expect(h.sim.commands[1]).toMatchObject({ mode: "wait" });
    expect(h.byType("system")[0]).toEqual({
      type: "system",
      subtype: "init",
      provider: "omp",
      sessionId: "01a0e9a3-d69d-7731-b971-1daea26de0fd",
      model: "baseten/zai-org/GLM-5.3-Fast",
      thinkingLevel: "high",
      thinkingLevels: ["off", "high", "max"],
      executionMode: "default",
      permissionMode: "default",
    });
    expect(h.statuses).toEqual(["idle"]);
    expect(h.inputReady).toHaveBeenCalledTimes(1);
    expect(h.proc.isWaitingForInput).toBe(true);
    expect(h.proc.sessionId).toBe("01a0e9a3-d69d-7731-b971-1daea26de0fd");
    expect(h.proc.settings).toEqual({ model: "baseten/zai-org/GLM-5.3-Fast", thinkingLevel: "high" });
  });

  it("passes model, thinking and resume, and registers as the writer of the file", async () => {
    const file = join(tmp, "2026_s.jsonl");
    await writeFile(file, "");
    const h = await startProcess(
      {
        executionMode: "fullAccess",
        model: "baseten/moonshotai/Kimi-K3",
        thinkingLevel: "low",
        resumeSessionFile: file,
        resumeSessionId: "resumed-id",
      },
      { ...OBSERVED_STATE, sessionId: "resumed-id", sessionFile: file },
    );
    expect(h.child.args).toEqual([
      "--mode", "rpc-ui",
      "--cwd", "/proj",
      "--allow-home",
      "--approval-mode", "yolo",
      "--config", overlayPath,
      "--model", "baseten/moonshotai/Kimi-K3",
      "--thinking", "low",
      "--resume", file,
    ]);
    expect(h.writers.ownerBySessionId("resumed-id")).toEqual({ owner: "bridge-1", file });
    expect(h.proc.permissionMode).toBe("bypassPermissions");
  });

  it("waits for the previous writer before spawning a resume", async () => {
    const file = join(tmp, "busy.jsonl");
    const created = createProcess();
    let release!: () => void;
    created.writers.register(file, { owner: "old", sessionId: "s", exited: new Promise<void>((r) => (release = r)) });
    created.proc.start("/proj", { bridgeSessionId: "b", executionMode: "default", resumeSessionFile: file });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawnMock).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
  });

  it("holds the resumed file from before the spawn, so a second writer waits for the exit", async () => {
    const file = join(tmp, "resume.jsonl");
    await writeFile(file, "");
    const created = createProcess();
    created.proc.start("/proj", {
      bridgeSessionId: "bridge-1",
      executionMode: "default",
      resumeSessionFile: file,
      resumeSessionId: "resumed-id",
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    // Spawned, handshake not finished: the live check already sees the owner.
    expect(created.writers.ownerBySessionId("resumed-id")).toEqual({ owner: "bridge-1", file });
    let second = false;
    const other = created.writers.acquire(file, { owner: "omp-rename:resumed-id", sessionId: "resumed-id" }).then((lease) => {
      second = true;
      lease.release();
    });
    const sim = new OmpSim(fakeChildren[0]);
    defaultHandlers(sim, { ...OBSERVED_STATE, sessionId: "resumed-id", sessionFile: file });
    sim.send(READY);
    await created.proc.waitUntilReady();
    await flush();
    expect(second).toBe(false);
    created.proc.stop();
    fakeChildren[0].exit(0);
    await other;
    expect(second).toBe(true);
  });

  it("drops the terminal breadcrumb variables from the child env", async () => {
    const created = createProcess({ PATH: "/bin", TMUX_PANE: "%1", TERM_SESSION_ID: "x", OMP_PROFILE: "work" });
    created.proc.start("/proj", { bridgeSessionId: "b", executionMode: "acceptEdits" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const child = fakeChildren[0];
    expect(child.options.env).toEqual({ PATH: "/bin", OMP_PROFILE: "work" });
    expect(child.args).toContain("write");
  });

  it("reports an exit before ready with the stderr tail", async () => {
    const created = createProcess();
    const exit = vi.fn();
    created.proc.on("exit", exit);
    created.proc.start("/proj", { bridgeSessionId: "b", executionMode: "default", model: "baseten/does-not-exist" });
    const ready = created.proc.waitUntilReady();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const child = fakeChildren[0];
    // OBSERVED P12a
    child.stderr.emit("data", 'Model "baseten/does-not-exist" not found\n');
    child.exit(1);
    await expect(ready).rejects.toMatchObject({ code: "omp_start_failed" });
    expect(created.messages).toContainEqual({
      type: "error",
      errorCode: "omp_start_failed",
      message: 'omp exited before it was ready (code 1): Model "baseten/does-not-exist" not found',
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(created.proc.status).toBe("idle");
    expect(created.proc.isAlive).toBe(false);
  });

  it("reports a missing CLI after listeners are attached", async () => {
    spawnMock.mockImplementationOnce((command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
      const child = new FakeChildProcess(command, args, options);
      child.pid = undefined;
      fakeChildren.push(child);
      queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn omp ENOENT"), { code: "ENOENT" })));
      return child;
    });
    const created = createProcess();
    const exit = vi.fn();
    created.proc.on("exit", exit);
    created.proc.start(tmp, { bridgeSessionId: "b", executionMode: "default" });
    await expect(created.proc.waitUntilReady()).rejects.toMatchObject({ code: "omp_cli_not_found" });
    expect(created.messages).toContainEqual({
      type: "error",
      errorCode: "omp_cli_not_found",
      message: "omp CLI not found. Install omp or set BRIDGE_OMP_BIN.",
    });
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  });

  it("refuses Windows unless BRIDGE_OMP_BIN points at an .exe", async () => {
    const created = createProcess({}, "win32");
    const exit = vi.fn();
    created.proc.on("exit", exit);
    created.proc.start("C:\\proj", { bridgeSessionId: "b", executionMode: "default" });
    expect(created.messages).toEqual([]);
    await expect(created.proc.waitUntilReady()).rejects.toMatchObject({ code: "omp_unsupported_platform" });
    expect(created.messages[0]).toMatchObject({ type: "error", errorCode: "omp_unsupported_platform" });
    expect(exit).toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();

    const exe = createProcess({ BRIDGE_OMP_BIN: "C:\\omp\\omp.exe" }, "win32");
    exe.proc.start("C:\\proj", { bridgeSessionId: "b", executionMode: "default" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
  });

  it("fails the start when get_state fails", async () => {
    const created = createProcess();
    created.proc.start("/proj", { bridgeSessionId: "b", executionMode: "default" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const sim = new OmpSim(fakeChildren[0]);
    defaultHandlers(sim, OBSERVED_STATE);
    sim.handlers.set("get_state", (command) => {
      sim.fail(command, "boom");
      return MANUAL;
    });
    sim.send(READY);
    await expect(created.proc.waitUntilReady()).rejects.toMatchObject({ code: "omp_start_failed" });
    expect(fakeChildren[0].stdin.ended).toBe(true);
  });

  it("emits supported commands after init, names without a slash", async () => {
    const created = createProcess();
    created.proc.start("/proj", { bridgeSessionId: "b", executionMode: "default" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const sim = new OmpSim(fakeChildren[0]);
    defaultHandlers(sim, OBSERVED_STATE);
    sim.send(READY);
    // OBSERVED V7: the list arrives right after ready, before the handshake ends
    sim.send({ type: "available_commands_update", commands: [{ name: "compact", source: "builtin" }, { name: "/context", source: "builtin" }] });
    await created.proc.waitUntilReady();
    const systems = created.messages.filter((m) => m.type === "system") as Frame[];
    expect(systems.map((message) => message.subtype)).toEqual(["init", "supported_commands"]);
    expect(systems[1]).toMatchObject({ slashCommands: ["compact", "context"], provider: "omp" });
  });
});

describe("OmpProcess event mapping (§3.1–§3.3)", () => {
  it("relays text and thinking deltas without snapshots", async () => {
    const h = await startProcess();
    prompt(h);
    h.sim.send({ type: "message_update", messageId: "msg-2", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    h.sim.send({ type: "message_update", messageId: "msg-2", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "The user wants" } });
    h.sim.send({ type: "message_update", messageId: "msg-2", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "OK", partial: { big: true } } });
    h.sim.send({ type: "message_update", messageId: "msg-2", assistantMessageEvent: { type: "toolcall_delta", delta: "{" } });
    expect(h.messages.filter((m) => m.type === "stream_delta" || m.type === "thinking_delta")).toEqual([
      { type: "thinking_delta", text: "The user wants" },
      { type: "stream_delta", text: "OK" },
    ]);
  });

  it("maps assistant blocks, strips the intent and drops empty thinking", async () => {
    const h = await startProcess();
    prompt(h);
    h.sim.send(
      assistantEnd([
        { type: "thinking", thinking: "  ", thinkingSignature: "x" },
        { type: "thinking", thinking: "plan", thinkingSignature: "x" },
        { type: "redactedThinking", data: "…" },
        { type: "text", text: "Running it" },
        { type: "toolCall", id: "c1", name: "bash", arguments: { i: "Running echo command", command: "echo hi" }, intent: "Running echo command" },
        { type: "image", data: "…", mimeType: "image/png" },
      ]),
    );
    const assistant = lastOf(h, "assistant");
    expect(assistant.message).toEqual({
      id: expect.stringMatching(/^omp-msg-[0-9a-f-]{36}$/),
      role: "assistant",
      model: "baseten/zai-org/GLM-5.3-Fast",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "Running it" },
        { type: "tool_use", id: "c1", name: "Bash", input: { command: "echo hi" } },
      ],
    });
  });

  it("emits nothing for an aborted turn with empty content", async () => {
    const h = await startProcess();
    prompt(h);
    h.sim.send(assistantEnd([], { stopReason: "aborted", errorMessage: "Interrupted by user" }));
    expect(h.byType("assistant")).toEqual([]);
  });

  it("maps edits by mode and applies the apply_patch alias", async () => {
    const h = await startProcess();
    prompt(h);
    h.sim.send(
      assistantEnd([
        { type: "toolCall", id: "e1", name: "edit", arguments: { path: "a.ts", old_string: "1", new_string: "2" } },
        { type: "toolCall", id: "e2", name: "edit", arguments: { input: "[b.ts#ABCD]\nPUT 1.=1:\n+x" } },
        { type: "toolCall", id: "e3", name: "apply_patch", arguments: { input: "*** Begin Patch\n*** Add File: c.txt\n+c\n*** End Patch" } },
        { type: "toolCall", id: "o1", name: "find", arguments: { i: "Finding files", pattern: "*.ts" } },
      ]),
    );
    const content = (lastOf(h, "assistant").message as Frame).content as Frame[];
    expect(content).toEqual([
      { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "a.ts", old_string: "1", new_string: "2" } },
      { type: "tool_use", id: "e2", name: "FileChange", input: { changes: [{ path: "b.ts", kind: "update", diff: "PUT 1.=1:\n+x" }] } },
      { type: "tool_use", id: "e3", name: "FileChange", input: { changes: [{ path: "c.txt", kind: "add", diff: "+c" }] } },
      { type: "tool_use", id: "o1", name: "find", input: { pattern: "*.ts", description: "Finding files" } },
    ]);
    h.sim.send({
      type: "tool_execution_end",
      toolCallId: "e1",
      toolName: "edit",
      result: { content: [{ type: "text", text: "[a.ts#9F00]" }], details: { diff: "-1|x = 1\n+1|x = 2", path: "a.ts" } },
      isError: false,
    });
    expect(lastOf(h, "tool_result")).toEqual({
      type: "tool_result",
      toolUseId: "e1",
      toolName: "Edit",
      content: "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-x = 1\n+x = 2",
    });
    h.sim.send({ type: "tool_execution_end", toolCallId: "e3", toolName: "apply_patch", result: { content: [{ type: "text", text: "Added c.txt" }] }, isError: false });
    expect(lastOf(h, "tool_result")).toMatchObject({ toolUseId: "e3", toolName: "FileChange", content: "Added c.txt" });
  });

  it("holds todo calls and emits TodoWrite from the result's full state", async () => {
    const h = await startProcess();
    prompt(h);
    h.sim.send(assistantEnd([{ type: "toolCall", id: "t1", name: "todo", arguments: { i: "Planning", op: "init" } }]));
    expect(h.byType("assistant")).toEqual([]);
    h.sim.send({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "todo",
      result: {
        content: [{ type: "text", text: "Todo list initialized" }],
        details: { op: "init", phases: [{ name: "Work", tasks: [{ content: "Build", status: "in_progress" }, { content: "Ship", status: "blocked", blocker: "CI" }] }] },
      },
      isError: false,
    });
    expect(h.messages.slice(-2)).toEqual([
      {
        type: "assistant",
        message: expect.objectContaining({
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "TodoWrite",
              input: {
                title: "Todo",
                todos: [
                  { content: "Build", status: "in_progress", activeForm: "" },
                  { content: "Ship (blocked: CI)", status: "pending", activeForm: "" },
                ],
              },
            },
          ],
        }),
      },
      { type: "tool_result", toolUseId: "t1", toolName: "TodoWrite", content: "Todo list initialized" },
    ]);
  });

  it("turns image blocks of tool results into raw content blocks", async () => {
    const records = fixture("p6-image.jsonl");
    const h = await startProcess();
    // OBSERVED P6: images go out as ImageContent
    h.proc.sendInput("What color is the single pixel in the attached image? Reply with one word.", {
      images: [{ base64: "iVBORw0KGgo=", mimeType: "image/png" }],
    });
    const sent = h.sim.last("prompt")!;
    expect(sent).toEqual({
      id: sent.id,
      type: "prompt",
      message: "What color is the single pixel in the attached image? Reply with one word.",
      streamingBehavior: "followUp",
      images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
    });
    h.sim.play(records, 1, { img: String(sent.id) });
    const read = h.byType("tool_result").find((m) => m.toolName === "Read")!;
    expect(read.rawContentBlocks).toEqual([
      { type: "image", source: { type: "base64", data: expect.stringMatching(/^UklGR/), media_type: "image/webp" } },
    ]);
    expect(h.byType("tool_result").find((m) => m.toolName === "Glob")).toBeDefined();
  });

  it("maps notices, commands, names and settings frames", async () => {
    const h = await startProcess();
    const names: string[] = [];
    h.proc.on("session_name", (name) => names.push(name));
    const before = h.messages.length;
    h.sim.send({ type: "notice", level: "info", message: "xd://: mounted mcp__x", source: "xdev" });
    h.sim.send({ type: "notice", level: "warning", message: "Session write failed", source: "session-persistence" });
    h.sim.send({ type: "extension_error", extensionPath: "/ext/a.ts", event: "tool_call", error: "boom" });
    h.sim.send({ type: "command_output", text: "\u001b[1mContext\u001b[0m usage: 12%" });
    h.sim.send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2500, errorMessage: "429 rate limited" });
    h.sim.send({ type: "retry_fallback_applied", from: "baseten/a", to: "baseten/b", role: "default" });
    h.sim.send({ type: "thinking_level_changed", thinkingLevel: "high" });
    h.sim.send({ type: "config_update", model: { provider: "baseten", id: "moonshotai/Kimi-K3", thinking: { efforts: ["low", "high", "max"] } }, thinkingLevel: "low" });
    h.sim.send({ type: "session_info_update", title: "Renamed in omp", sessionId: "s" });
    for (const type of ["turn_start", "turn_end", "subagent_event", "todo_reminder", "goal_updated", "host_tool_call", "advisor_cost_changed", "something_new"]) {
      h.sim.send({ type });
    }
    h.sim.send({ type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "autoresearch" });
    h.sim.send({ type: "extension_ui_request", id: "t", method: "setTitle", title: "x" });
    const emitted = h.messages.slice(before);
    expect(emitted).toEqual([
      { type: "error", errorCode: "omp_notice", message: "Session write failed" },
      { type: "error", errorCode: "omp_notice", message: "Extension /ext/a.ts failed in tool_call: boom" },
      { type: "assistant", message: expect.objectContaining({ content: [{ type: "text", text: "Context usage: 12%" }] }) },
      { type: "error", errorCode: "omp_notice", message: "Retrying (1/3) in 2.5s: 429 rate limited" },
      { type: "error", errorCode: "omp_notice", message: "Model fallback: baseten/a → baseten/b" },
      expect.objectContaining({ type: "system", subtype: "omp_settings", model: "baseten/b", thinkingLevel: "high" }),
      expect.objectContaining({ type: "system", subtype: "omp_settings", model: "baseten/b", thinkingLevel: "high" }),
      {
        type: "system",
        subtype: "omp_settings",
        provider: "omp",
        sessionId: "01a0e9a3-d69d-7731-b971-1daea26de0fd",
        model: "baseten/moonshotai/Kimi-K3",
        thinkingLevel: "low",
        thinkingLevels: ["off", "low", "high", "max"],
      },
    ]);
    expect(names).toEqual(["Renamed in omp"]);
  });

  it("refreshes settings with get_state after a model change it did not cause", async () => {
    const h = await startProcess();
    h.sim.handlers.set("get_state", () => ({ ...OBSERVED_STATE, model: { provider: "baseten", id: "MiniMaxAI/MiniMax-M3", reasoning: false }, thinkingLevel: undefined }));
    h.sim.send({ type: "model_changed" });
    await flush();
    expect(lastOf(h, "system")).toMatchObject({ subtype: "omp_settings", model: "baseten/MiniMaxAI/MiniMax-M3", thinkingLevels: ["off"] });
    expect(lastOf(h, "system").thinkingLevel).toBeUndefined();
  });
});

describe("OmpProcess run state (§2.5, §3.4)", () => {
  it("goes idle at prompt_result before session_settled and reports agent-initiated runs (V7)", async () => {
    const records = fixture("v7-async-bash.jsonl");
    const h = await startProcess();
    const p1 = prompt(h, String(records[0].frame.message));
    expect(h.sim.last("prompt")).toMatchObject({ streamingBehavior: "followUp" });
    expect(h.proc.status).toBe("running");
    const inputReadyBefore = h.inputReady.mock.calls.length;
    let index = h.sim.play(records, 1, { p1 });
    // prompt_result {sessionSettled:false}: idle at once, background job still pending
    expect(h.proc.status).toBe("idle");
    expect(h.proc.isSettled).toBe(false);
    expect(h.inputReady.mock.calls.length).toBe(inputReadyBefore + 1);
    expect(lastOf(h, "result")).toMatchObject({ subtype: "success", result: "STARTED", toolCalls: 1, fileEdits: 0 });

    expect(records[index].frame.type).toBe("get_state");
    index = h.sim.play(records, index + 1, {});
    const p2 = prompt(h, "Reply with exactly: SECOND");
    const statusesBefore = h.statuses.length;
    index = h.sim.play(records, index + 1, { p2 });
    expect(index).toBe(records.length);
    expect(h.statuses.slice(statusesBefore)).toEqual(["idle", "running", "idle"]);
    // The agent woke itself for the job result: running, then its own result.
    expect(h.statuses.slice(-2)).toEqual(["running", "idle"]);
    expect(lastOf(h, "result")).toMatchObject({
      subtype: "success",
      result: expect.stringContaining("bg_1 finished"),
      sessionId: "01a0e9a3-d69d-7731-b971-1daea26de0fd",
    });
    expect(h.byType("result")).toHaveLength(3);
    expect(h.proc.isSettled).toBe(true);
  });

  it("keeps running across a non-yielding agent_end", async () => {
    const h = await startProcess();
    const id = prompt(h);
    h.sim.send({ id, type: "response", command: "prompt", success: true });
    h.sim.send({ type: "agent_start" });
    h.sim.send({ type: "agent_end", messages: [], isTerminal: false, yielded: false });
    expect(h.proc.status).toBe("running");
    h.sim.send({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
    expect(h.proc.status).toBe("running"); // the prompt still waits for its prompt_result
    h.sim.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
    expect(h.proc.status).toBe("idle");
  });

  it("treats an agent_end without isTerminal/yielded as a yield", async () => {
    const h = await startProcess();
    h.sim.send({ type: "agent_start" });
    expect(h.proc.status).toBe("running");
    // oversized agent_end (§2.3 step 5)
    h.sim.send({ type: "agent_end", messages: [], messageCount: 12 });
    expect(h.proc.status).toBe("idle");
    expect(lastOf(h, "result")).toMatchObject({ subtype: "success" });
  });

  it("completes a local prompt from its response without a prompt_result", async () => {
    const h = await startProcess();
    const id = prompt(h, "/context");
    h.sim.send({ type: "command_output", text: "Context: 1%" });
    h.sim.send({ id, type: "response", command: "prompt", success: true, data: { agentInvoked: false } });
    await flush();
    expect(lastOf(h, "result")).toEqual({ type: "result", subtype: "success", sessionId: "01a0e9a3-d69d-7731-b971-1daea26de0fd" });
    expect(h.proc.status).toBe("idle");
  });

  it("reports a prompt that failed before the agent once (P5)", async () => {
    const records = fixture("p5-steer.jsonl");
    const failing = records.filter((r) => r.dir === "OUT" && r.frame.id === "p2");
    const h = await startProcess();
    const id = prompt(h, "Reply with exactly: NOBEHAVIOR");
    for (const record of failing) h.sim.send({ ...record.frame, id });
    await flush();
    expect(h.byType("result")).toEqual([
      {
        type: "result",
        subtype: "error",
        error: "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.",
        sessionId: "01a0e9a3-d69d-7731-b971-1daea26de0fd",
      },
    ]);
    expect(h.proc.status).toBe("idle");
  });

  it("reports a prompt rejected by its first response", async () => {
    const h = await startProcess();
    const id = prompt(h);
    h.sim.send({ id, type: "response", command: "prompt", success: false, error: "No model selected" });
    await flush();
    expect(lastOf(h, "result")).toMatchObject({ subtype: "error", error: "No model selected" });
    expect(h.proc.status).toBe("idle");
  });

  it("reports a provider error with its stop reason (P12b)", async () => {
    const records = fixture("p12b-provider-error.jsonl");
    const h = await startProcess();
    const id = prompt(h, "Reply with exactly: OK");
    h.sim.play(records, 1, { p: id });
    expect(lastOf(h, "result")).toEqual({
      type: "result",
      subtype: "error",
      error: "403 please check the api-key you provided",
      stopReason: "error",
      sessionId: "01a0e9a3-d69d-7731-b971-1daea26de0fd",
    });
  });

  it("sums usage per run into the result", async () => {
    const h = await startProcess();
    const id = prompt(h);
    h.sim.send({ id, type: "response", command: "prompt", success: true });
    h.sim.send({ type: "agent_start" });
    const usage = (input: number, output: number, cacheRead: number, total: number) => ({
      input, output, cacheRead, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
    });
    h.sim.send(assistantEnd([{ type: "toolCall", id: "w1", name: "write", arguments: { path: "a", content: "b" } }], { usage: usage(100, 5, 10, 0.001) }));
    h.sim.send({ type: "tool_execution_end", toolCallId: "w1", toolName: "write", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
    h.sim.send(assistantEnd([{ type: "text", text: "Done." }], { stopReason: "stop", usage: usage(200, 7, 20, 0.002) }));
    h.sim.send({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
    h.sim.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
    const result = lastOf(h, "result");
    expect(result).toMatchObject({
      subtype: "success",
      result: "Done.",
      stopReason: "stop",
      inputTokens: 300,
      cachedInputTokens: 30,
      outputTokens: 12,
      toolCalls: 1,
      fileEdits: 1,
    });
    expect(result.cost).toBeCloseTo(0.003);
    expect(typeof result.duration).toBe("number");
  });

  it("returns to idle after idle compaction and to running inside a run", async () => {
    const h = await startProcess();
    h.sim.send({ type: "auto_compaction_start", reason: "idle", action: "context-full" });
    expect(h.proc.status).toBe("compacting");
    h.sim.send({ type: "auto_compaction_end", action: "context-full", aborted: false, willRetry: false });
    expect(h.proc.status).toBe("idle");

    prompt(h);
    h.sim.send({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    expect(h.proc.status).toBe("compacting");
    h.sim.send({ type: "auto_compaction_end", action: "context-full", aborted: true, willRetry: false });
    expect(h.proc.status).toBe("running");
    expect(lastOf(h, "error")).toEqual({ type: "error", errorCode: "omp_notice", message: "Compaction was aborted" });
    const errors = h.byType("error").length;
    h.sim.send({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    h.sim.send({ type: "auto_compaction_end", action: "context-full", aborted: false, willRetry: false, skipped: true });
    expect(h.byType("error").length).toBe(errors);
  });

  it("handles rpc_frame_error per original type", async () => {
    const h = await startProcess();
    prompt(h);
    h.sim.send(assistantEnd([{ type: "toolCall", id: "r1", name: "read", arguments: { path: "big.log" } }]));
    h.sim.send({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "big.log" } });
    h.sim.send({ type: "rpc_frame_error", originalType: "tool_execution_end", error: "too large" });
    expect(lastOf(h, "tool_result")).toEqual({
      type: "tool_result",
      toolUseId: "r1",
      toolName: "Read",
      content: "omp could not deliver this tool result (over 64 MiB)",
    });
    h.sim.send({ type: "message_start", messageId: "msg-9", message: { role: "assistant", content: [] } });
    h.sim.send({ type: "message_update", messageId: "msg-9", assistantMessageEvent: { type: "text_delta", delta: "Partial " } });
    h.sim.send({ type: "message_update", messageId: "msg-9", assistantMessageEvent: { type: "text_delta", delta: "answer" } });
    h.sim.send({ type: "rpc_frame_error", originalType: "message_end", error: "too large" });
    expect((lastOf(h, "assistant").message as Frame).content).toEqual([{ type: "text", text: "Partial answer" }]);
    h.sim.send({ type: "rpc_frame_error", originalType: "turn_end", error: "too large" });
    expect(lastOf(h, "error")).toEqual({ type: "error", errorCode: "omp_notice", message: "omp dropped an oversized turn_end frame" });
  });
});

describe("OmpProcess oversized tool results (§2.3)", () => {
  it("ends a started call whose approval is not open, and keeps the open approval", async () => {
    const h = await startProcess();
    prompt(h);
    h.sim.send(
      assistantEnd([
        { type: "toolCall", id: "b1", name: "bash", arguments: { command: "echo waiting" } },
        { type: "toolCall", id: "r1", name: "read", arguments: { path: "big.log" } },
      ]),
    );
    h.sim.send({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "echo waiting" } });
    h.sim.send({ type: "extension_ui_request", id: "d1", method: "select", title: "Allow tool: bash\nCommand: echo waiting", options: ["Approve", "Deny"] });
    h.sim.send({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "big.log" } });
    h.sim.send({ type: "rpc_frame_error", originalType: "tool_execution_end", error: "too large" });
    expect(lastOf(h, "tool_result")).toMatchObject({ toolUseId: "r1", toolName: "Read" });
    expect(h.byType("permission_resolved")).toEqual([]);
    expect(h.proc.getPendingPermission()).toMatchObject({ toolUseId: "b1" });
    expect(h.proc.status).toBe("waiting_approval");
  });
});

describe("OmpProcess approvals (§4.1, §4.2)", () => {
  function uiResponses(h: Harness): Frame[] {
    return h.sim.ofType("extension_ui_response");
  }

  it("binds an approval to its call and answers Approve (P3a)", async () => {
    const records = fixture("p3a-approve.jsonl");
    const h = await startProcess();
    const a = prompt(h, "Run: echo hi");
    let index = h.sim.play(records, 1, { a });
    expect(h.proc.status).toBe("waiting_approval");
    const request = lastOf(h, "permission_request");
    expect(request).toEqual({
      type: "permission_request",
      toolUseId: "chatcmpl-tool-0a1b63e27eff4eedb5e367ccd28f021c",
      toolName: "Bash",
      input: { command: "echo hi", approvalDetails: ["Command: echo hi"] },
    });
    expect(h.proc.getPendingPermission()).toEqual({
      toolUseId: request.toolUseId,
      toolName: "Bash",
      input: request.input,
    });
    expect(h.proc.approve(String(request.toolUseId))).toBe(true);
    expect(uiResponses(h).at(-1)).toEqual(records[index].frame);
    expect(lastOf(h, "permission_resolved")).toEqual({ type: "permission_resolved", toolUseId: request.toolUseId });
    expect(h.proc.status).toBe("running");
    index = h.sim.play(records, index + 1, { a });
    expect(index).toBe(records.length);
    expect(h.byType("tool_result")).toEqual([
      { type: "tool_result", toolUseId: request.toolUseId, toolName: "Bash", content: "hi\n\n\nWall time: 0.04 seconds" },
    ]);
    expect(lastOf(h, "result")).toMatchObject({ subtype: "success" });
    expect(h.proc.status).toBe("idle");
    expect(h.proc.approve(String(request.toolUseId))).toBe(false);
  });

  it("denies and steers the reason right after the deny (P3b)", async () => {
    const records = fixture("p3b-deny.jsonl");
    const h = await startProcess();
    const b = prompt(h, "Run: echo bye");
    const index = h.sim.play(records, 1, { b });
    const request = lastOf(h, "permission_request");
    expect(h.proc.reject(String(request.toolUseId), "not now")).toBe(true);
    const tail = h.sim.commands.slice(-2);
    expect(tail[0]).toEqual(records[index].frame);
    expect(tail[1]).toMatchObject({ type: "steer", message: "not now" });
    h.sim.play(records, index + 1, { b });
    expect(h.byType("tool_result")[0]).toMatchObject({ content: "Tool call denied by user: bash", toolName: "Bash" });
    expect(h.byType("user_input")).toEqual([]);
  });

  it.each([
    ["p3c-parallel.jsonl", "c", "chatcmpl-tool-f991281529424235ad1389b3dcff4281", "chatcmpl-tool-20dba362e42843b2871111799f5ae092"],
    ["v2-parallel-approvals.jsonl", "b", "chatcmpl-tool-01e7a02eafb741a098907ecc963b827a", "chatcmpl-tool-b6c6c06c0a1540e4ba65528acb61c8d5"],
  ])("binds parallel approvals by argument text, not by start order (%s)", async (name, probeId, callA, callB) => {
    const records = fixture(name);
    const h = await startProcess();
    const id = prompt(h, "parallel");
    let index = h.sim.play(records, 1, { [probeId]: id });
    const requests = h.byType("permission_request");
    // The select for b arrives before b's tool_execution_start.
    expect(requests.map((r) => [r.toolUseId, (r.input as Frame).command])).toEqual([
      [callA, "echo a"],
      [callB, "echo b"],
    ]);
    // answer b first, as the probe did
    expect(h.proc.approve(callB)).toBe(true);
    expect(uiResponses(h).at(-1)).toEqual(records[index].frame);
    expect(h.proc.status).toBe("waiting_approval");
    index = h.sim.play(records, index + 1, { [probeId]: id });
    expect(h.proc.approve(callA)).toBe(true);
    expect(uiResponses(h).at(-1)).toEqual(records[index].frame);
    h.sim.play(records, index + 1, { [probeId]: id });
    expect(h.byType("tool_result").map((r) => r.toolUseId)).toEqual([callB, callA]);
    expect(h.proc.status).toBe("idle");
  });

  it("shows omp's write approval text with the mapped input (P3d)", async () => {
    const records = fixture("p3d-write.jsonl");
    const h = await startProcess();
    const d = prompt(h, "write");
    const index = h.sim.play(records, 1, { d });
    expect(lastOf(h, "permission_request")).toMatchObject({
      toolName: "Write",
      input: { file_path: "note.txt", content: "hello", approvalDetails: ["Path: note.txt", "Content:", "hello"] },
    });
    h.proc.approve();
    expect(uiResponses(h).at(-1)).toEqual(records[index].frame);
  });

  it("never binds a score-0 candidate (inner eval approval)", async () => {
    const h = await startProcess();
    prompt(h);
    h.sim.send(
      assistantEnd([
        { type: "toolCall", id: "ev", name: "eval", arguments: { code: "await bash('ls -la')" } },
        { type: "toolCall", id: "b1", name: "bash", arguments: { command: "echo x" } },
      ]),
    );
    h.sim.send({ type: "extension_ui_request", id: "d-inner", method: "select", title: "Allow tool: bash\nCommand: ls -la", options: ["Approve", "Deny"] });
    expect(lastOf(h, "permission_request")).toEqual({
      type: "permission_request",
      toolUseId: "omp-approval:d-inner",
      toolName: "Bash",
      input: { approvalDetails: ["Command: ls -la"] },
    });
    h.sim.send({ type: "extension_ui_request", id: "d-outer", method: "select", title: "Allow tool: bash\nCommand: echo x", options: ["Approve", "Deny"] });
    expect(lastOf(h, "permission_request")).toMatchObject({ toolUseId: "b1", input: { command: "echo x" } });
    expect(h.proc.approve("omp-approval:d-inner")).toBe(true);
    expect(uiResponses(h).at(-1)).toEqual({ type: "extension_ui_response", id: "d-inner", value: "Approve" });
  });

  it("does not bind a value that only occurs inside a longer detail value", async () => {
    const h = await startProcess();
    prompt(h);
    h.sim.send(
      assistantEnd([
        { type: "toolCall", id: "ev", name: "eval", arguments: { code: "await bash('ls -la')" } },
        { type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
      ]),
    );
    // "ls" is a substring of "Command: ls -la", but not the whole value.
    h.sim.send({ type: "extension_ui_request", id: "d-inner", method: "select", title: "Allow tool: bash\nCommand: ls -la", options: ["Approve", "Deny"] });
    h.sim.send({ type: "extension_ui_request", id: "d-outer", method: "select", title: "Allow tool: bash\nCommand: ls", options: ["Approve", "Deny"] });
    expect(h.byType("permission_request").map((r) => [r.toolUseId, (r.input as Frame).approvalDetails])).toEqual([
      ["omp-approval:d-inner", ["Command: ls -la"]],
      ["b1", ["Command: ls"]],
    ]);
  });

  it("binds a value omp elided at its prompt limit", async () => {
    const h = await startProcess();
    prompt(h);
    const command = `echo ${"x".repeat(2500)}`;
    h.sim.send(assistantEnd([{ type: "toolCall", id: "long", name: "bash", arguments: { command } }]));
    // omp truncateForPrompt: the first 2000 characters, then the elision marker.
    const shown = `${command.slice(0, 2000)}[…${command.length - 2000}ch elided…]`;
    h.sim.send({ type: "extension_ui_request", id: "d1", method: "select", title: `Allow tool: bash\nCommand: ${shown}`, options: ["Approve", "Deny"] });
    expect(lastOf(h, "permission_request")).toMatchObject({ toolUseId: "long" });
    // A different command that shares the first characters is not the same value.
    h.sim.send(assistantEnd([{ type: "toolCall", id: "other", name: "bash", arguments: { command: `${command.slice(0, 200)} && rm -rf out` } }]));
    h.sim.send({ type: "extension_ui_request", id: "d2", method: "select", title: `Allow tool: bash\nCommand: ${command.slice(0, 200)} && rm -rf build`, options: ["Approve", "Deny"] });
    expect(lastOf(h, "permission_request")).toMatchObject({ toolUseId: "omp-approval:d2" });
  });

  it("keeps a wrongly bound approval open when its call ends, so interrupt still cancels it", async () => {
    const h = await startProcess();
    prompt(h);
    h.sim.send(
      assistantEnd([
        { type: "toolCall", id: "ev", name: "eval", arguments: { code: "await bash('ls')" } },
        { type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
      ]),
    );
    // The inner approval has the same text as b1's own one and binds to b1;
    // b1's own approval then stays unbound.
    h.sim.send({ type: "extension_ui_request", id: "d-inner", method: "select", title: "Allow tool: bash\nCommand: ls", options: ["Approve", "Deny"] });
    h.sim.send({ type: "extension_ui_request", id: "d-outer", method: "select", title: "Allow tool: bash\nCommand: ls", options: ["Approve", "Deny"] });
    expect(h.byType("permission_request").map((r) => r.toolUseId)).toEqual(["b1", "omp-approval:d-outer"]);
    expect(h.proc.approve("omp-approval:d-outer")).toBe(true);
    // b1 ran after d-outer, so d-inner (still waiting in omp) was never b1's.
    h.sim.send({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "ls" } });
    h.sim.send({ type: "tool_execution_end", toolCallId: "b1", toolName: "bash", result: { content: [{ type: "text", text: "a" }] } });
    expect(h.messages.slice(-3)).toEqual([
      { type: "permission_resolved", toolUseId: "b1" },
      {
        type: "permission_request",
        toolUseId: "omp-approval:d-inner",
        toolName: "Bash",
        input: { approvalDetails: ["Command: ls"] },
      },
      { type: "tool_result", toolUseId: "b1", toolName: "Bash", content: "a" },
    ]);
    expect(h.proc.status).toBe("waiting_approval");
    expect(h.proc.getPendingPermission()).toMatchObject({ toolUseId: "omp-approval:d-inner" });
    h.proc.interrupt();
    const [cancel, abort] = h.sim.commands.slice(-2);
    expect(cancel).toEqual({ type: "extension_ui_response", id: "d-inner", cancelled: true });
    expect(abort).toMatchObject({ type: "abort" });
    expect(lastOf(h, "permission_resolved")).toEqual({ type: "permission_resolved", toolUseId: "omp-approval:d-inner" });
  });

  it("prefers the more specific of two matching calls", async () => {
    const h = await startProcess();
    prompt(h);
    h.sim.send(
      assistantEnd([
        { type: "toolCall", id: "short", name: "bash", arguments: { command: "echo a" } },
        { type: "toolCall", id: "long", name: "bash", arguments: { command: "echo ab" } },
      ]),
    );
    h.sim.send({ type: "extension_ui_request", id: "d2", method: "select", title: "Allow tool: bash\nCommand: echo ab", options: ["Approve", "Deny"] });
    h.sim.send({ type: "extension_ui_request", id: "d1", method: "select", title: "Allow tool: bash\nCommand: echo a", options: ["Approve", "Deny"] });
    expect(h.byType("permission_request").map((r) => r.toolUseId)).toEqual(["long", "short"]);
  });

  it("appends the hashline patch and carries the Reason line", async () => {
    const h = await startProcess();
    prompt(h);
    const patch = ["[src/a.ts#1A2B]", "PUT 1.=1:", ...Array.from({ length: 45 }, (_, i) => `+line ${i}`)].join("\n");
    h.sim.send(assistantEnd([{ type: "toolCall", id: "e1", name: "edit", arguments: { input: patch } }]));
    h.sim.send({
      type: "extension_ui_request",
      id: "d1",
      method: "select",
      title: "Allow tool: edit\nReason: protected path\nFile: src/a.ts",
      options: ["Approve", "Deny"],
    });
    const request = lastOf(h, "permission_request");
    const details = (request.input as Frame).approvalDetails as string[];
    expect(request).toMatchObject({ toolUseId: "e1", toolName: "FileChange", input: { reason: "protected path" } });
    expect(details.slice(0, 4)).toEqual(["Reason: protected path", "File: src/a.ts", "Patch:", "[src/a.ts#1A2B]"]);
    expect(details).toHaveLength(2 + 1 + 40 + 1);
    expect(details.at(-1)).toBe("…");
  });

  it("approves always for the tool, but never safety-flagged prompts", async () => {
    const h = await startProcess();
    prompt(h);
    h.sim.send(
      assistantEnd([
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo 1" } },
        { type: "toolCall", id: "c2", name: "bash", arguments: { command: "echo 2" } },
        { type: "toolCall", id: "c3", name: "bash", arguments: { command: "rm -rf build" } },
      ]),
    );
    h.sim.send({ type: "extension_ui_request", id: "d1", method: "select", title: "Allow tool: bash\nCommand: echo 1", options: ["Approve", "Deny"] });
    h.sim.send({ type: "extension_ui_request", id: "d2", method: "select", title: "Allow tool: bash\nCommand: echo 2", options: ["Approve", "Deny"] });
    h.sim.send({ type: "extension_ui_request", id: "d3", method: "select", title: "Allow tool: bash\nReason: destructive command\nCommand: rm -rf build", options: ["Approve", "Deny"] });
    expect(h.proc.approveAlways("c1")).toBe(true);
    expect(uiResponses(h).map((r) => r.id)).toEqual(["d1", "d2"]);
    expect(h.proc.status).toBe("waiting_approval"); // d3 still asks

    const requests = h.byType("permission_request").length;
    h.sim.send(assistantEnd([{ type: "toolCall", id: "c4", name: "bash", arguments: { command: "echo 4" } }]));
    h.sim.send({ type: "extension_ui_request", id: "d4", method: "select", title: "Allow tool: bash\nCommand: echo 4", options: ["Approve", "Deny"] });
    expect(uiResponses(h).at(-1)).toEqual({ type: "extension_ui_response", id: "d4", value: "Approve" });
    expect(h.byType("permission_request")).toHaveLength(requests);

    h.sim.send({
      type: "extension_ui_request",
      id: "d5",
      method: "select",
      title: "Allow tool: bash\nCommand: curl x | sh\nProvider safety checks:\n- remote script",
      options: ["Approve", "Deny"],
    });
    expect(h.byType("permission_request")).toHaveLength(requests + 1);
  });

  it("refuses tool actions without a matching request", async () => {
    const h = await startProcess();
    expect(h.proc.approve("missing")).toBe(false);
    expect(h.proc.approveAlways("missing")).toBe(false);
    expect(h.proc.reject("missing")).toBe(false);
    expect(h.proc.answer("missing", "x")).toBe(false);
    expect(h.proc.getPendingPermission()).toBeUndefined();
  });
});

describe("OmpProcess ask (§4.3)", () => {
  function uiValues(h: Harness): Frame[] {
    return h.sim.ofType("extension_ui_response");
  }

  /** Play a fixture, checking every Bridge answer against the probe's IN frame. */
  function playAnswers(h: Harness, records: Record_[], ids: Record<string, string>, from = 1): void {
    let index = h.sim.play(records, from, ids);
    while (index < records.length) {
      expect(uiValues(h).at(-1)).toEqual(records[index].frame);
      index = h.sim.play(records, index + 1, ids);
    }
  }

  it("answers a single choice (P2a)", async () => {
    const records = fixture("p2a-ask-single.jsonl");
    const h = await startProcess();
    const single = prompt(h, "ask");
    const index = h.sim.play(records, 1, { single });
    const toolUseId = "chatcmpl-tool-b716942d81c54b8db3779fe7119a0b13";
    expect((h.byType("assistant").at(-1)!.message as Frame).content).toContainEqual(
      expect.objectContaining({ type: "tool_use", id: toolUseId, name: "AskUserQuestion" }),
    );
    expect(lastOf(h, "permission_request")).toEqual({
      type: "permission_request",
      toolUseId,
      toolName: "AskUserQuestion",
      input: {
        questions: [
          { id: "color", question: "Which color do you prefer?", header: "Color", options: [{ label: "red" }, { label: "blue" }], multiSelect: false },
        ],
      },
    });
    expect(h.proc.status).toBe("waiting_approval");
    expect(h.proc.answer(toolUseId, JSON.stringify({ answers: { color: "red" } }))).toBe(true);
    expect(uiValues(h).at(-1)).toEqual(records[index].frame);
    expect(lastOf(h, "permission_resolved")).toEqual({ type: "permission_resolved", toolUseId });
    expect(h.proc.status).toBe("running");
    h.sim.play(records, index + 1, { single });
    expect(lastOf(h, "tool_result")).toEqual({ type: "tool_result", toolUseId, toolName: "AskUserQuestion", content: "User selected: red" });
    expect(h.byType("permission_resolved")).toHaveLength(1);
  });

  it("toggles a multi-select and finishes with Done (P2b)", async () => {
    const records = fixture("p2b-ask-multi.jsonl");
    const h = await startProcess();
    const multi = prompt(h, "ask");
    const index = h.sim.play(records, 1, { multi });
    h.proc.answer("chatcmpl-tool-ccf30953a79e4afea9e9208d7a5559da", JSON.stringify({ answers: { fruits: ["apple", "cherry"] } }));
    expect(uiValues(h).at(-1)).toEqual(records[index].frame);
    playAnswers(h, records, { multi }, index + 1);
    expect(uiValues(h).map((r) => r.value)).toEqual(["apple", "cherry", "✔ Done selecting"]);
    expect(lastOf(h, "tool_result")).toMatchObject({ content: "User selected: apple, cherry" });
  });

  it("answers free text through Other and the editor (P2c)", async () => {
    const records = fixture("p2c-ask-other.jsonl");
    const h = await startProcess();
    const other = prompt(h, "ask");
    const index = h.sim.play(records, 1, { other });
    h.proc.answer("chatcmpl-tool-346a5fa590f043a8a5e82ad9ad7fc952", "green");
    expect(uiValues(h).at(-1)).toEqual(records[index].frame);
    playAnswers(h, records, { other }, index + 1);
    expect(uiValues(h).map((r) => r.value)).toEqual(["Other (type your own)", "green"]);
  });

  it("answers several questions in sequence (P2d)", async () => {
    const records = fixture("p2d-ask-two-questions.jsonl");
    const h = await startProcess();
    const id = prompt(h, "ask");
    const index = h.sim.play(records, 1, { "two-questions": id });
    const request = lastOf(h, "permission_request");
    expect(((request.input as Frame).questions as Frame[]).map((q) => q.id)).toEqual(["color", "size"]);
    h.proc.answer(String(request.toolUseId), JSON.stringify({ answers: { color: "blue", size: "M" } }));
    expect(uiValues(h).at(-1)).toEqual(records[index].frame);
    playAnswers(h, records, { "two-questions": id }, index + 1);
    expect(uiValues(h).map((r) => r.value)).toEqual(["blue", "M"]);
  });

  it("declines by cancelling, which aborts the turn (P2e)", async () => {
    const records = fixture("p2e-ask-cancel.jsonl");
    const h = await startProcess();
    const cancel = prompt(h, "ask");
    const index = h.sim.play(records, 1, { cancel });
    expect(h.proc.reject("chatcmpl-tool-91902a107a4c4722b3c0a1f195b6f728")).toBe(true);
    expect(uiValues(h).at(-1)).toEqual(records[index].frame);
    expect(h.proc.status).toBe("running");
    h.sim.play(records, index + 1, { cancel });
    expect(lastOf(h, "result")).toEqual({ type: "result", subtype: "interrupted", sessionId: "01a0e9a3-d69d-7731-b971-1daea26de0fd" });
    expect(h.byType("assistant").filter((m) => ((m.message as Frame).content as Frame[]).length === 0)).toEqual([]);
  });

  it("notices when omp answered after its own timeout (P2f)", async () => {
    const records = fixture("p2f-ask-timeout.jsonl");
    const h = await startProcess();
    const p = prompt(h, "ask");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const selectIndex = records.findIndex((r) => r.frame.method === "select");
    for (const record of records.slice(1, selectIndex + 1)) {
      const frame = record.frame.id === "p" ? { ...record.frame, id: p } : record.frame;
      h.sim.send(frame);
    }
    expect(h.proc.status).toBe("waiting_approval");
    // The recommended label is echoed exactly when answered in time.
    expect(records[selectIndex].frame.options).toContain("Blue (Recommended)");
    vi.advanceTimersByTime(5000);
    expect(lastOf(h, "error")).toEqual({ type: "error", errorCode: "omp_notice", message: "omp answered the question after its timeout" });
    expect(lastOf(h, "permission_resolved")).toMatchObject({ toolUseId: "chatcmpl-tool-c23dfd5e4dae43af8ad154dfa0b2bb70" });
    vi.useRealTimers();
    h.sim.play(records, selectIndex + 1, { p });
    expect(lastOf(h, "tool_result")).toMatchObject({ content: "User selected: Blue (auto-selected after timeout)" });
    expect(h.proc.answer("chatcmpl-tool-c23dfd5e4dae43af8ad154dfa0b2bb70", "Blue")).toBe(false);
  });

  it("echoes a recommended label exactly", async () => {
    const records = fixture("p2f-ask-timeout.jsonl");
    const h = await startProcess();
    const p = prompt(h, "ask");
    const selectIndex = records.findIndex((r) => r.frame.method === "select");
    for (const record of records.slice(1, selectIndex + 1)) h.sim.send(record.frame.id === "p" ? { ...record.frame, id: p } : record.frame);
    h.proc.answer("chatcmpl-tool-c23dfd5e4dae43af8ad154dfa0b2bb70", JSON.stringify({ answers: { color: "Blue" } }));
    expect(uiValues(h).at(-1)).toEqual({ type: "extension_ui_response", id: "1591a36726e7871a", value: "Blue (Recommended)" });
  });

  it("finishes a multi-select inside a two-question ask through the editor (V3)", async () => {
    const records = fixture("v3-ask-multi-two-questions.jsonl");
    const h = await startProcess();
    const q = prompt(h, "ask");
    let index = h.sim.play(records, 1, { q });
    const toolUseId = "chatcmpl-tool-f2cd5ffa070749f688e4fa20408347a0";
    expect(h.proc.answer(toolUseId, JSON.stringify({ answers: { fruits: ["apple"], color: "blue" } }))).toBe(true);
    // select (1/2): toggle apple
    expect(uiValues(h).at(-1)).toEqual(records[index].frame);
    index = h.sim.play(records, index + 1, { q });
    // "(1 selected) … (1/2)" offers no Done: Other
    expect(uiValues(h).at(-1)).toEqual(records[index].frame);
    index = h.sim.play(records, index + 1, { q });
    // editor title with glyph rows: the joined selection
    expect(uiValues(h).at(-1)).toEqual({ type: "extension_ui_response", id: "1591b708cc03d2d7", value: "apple" });
    index = h.sim.play(records, index + 1, { q });
    expect(uiValues(h).at(-1)).toEqual(records[index].frame);
    h.sim.play(records, index + 1, { q });
    expect(lastOf(h, "result")).toMatchObject({ subtype: "success" });
  });

  it("toggles every offered value before Other when several questions exist", async () => {
    const h = await startProcess();
    prompt(h);
    h.sim.send(
      assistantEnd([
        {
          type: "toolCall",
          id: "ask1",
          name: "ask",
          arguments: {
            questions: [
              { id: "fruits", question: "Which fruits do you like?", options: [{ label: "apple" }, { label: "banana" }, { label: "cherry" }], multi: true },
              { id: "size", question: "Which size do you prefer?", options: [{ label: "S" }, { label: "M" }] },
            ],
          },
        },
      ]),
    );
    h.proc.answer("ask1", JSON.stringify({ answers: { fruits: ["cherry", "apple", "kiwi"], size: "S" } }));
    const options = ["apple", "banana", "cherry", "Other (type your own)"];
    h.sim.send({ type: "extension_ui_request", id: "f1", method: "select", title: "Which fruits do you like? (1/2)", options });
    h.sim.send({ type: "extension_ui_request", id: "f2", method: "select", title: "(1 selected) Which fruits do you like? (1/2)", options });
    h.sim.send({ type: "extension_ui_request", id: "f3", method: "select", title: "(2 selected) Which fruits do you like? (1/2)", options });
    h.sim.send({ type: "extension_ui_request", id: "f4", method: "editor", title: "(2 selected) Which fruits do you like? (1/2)\n\n☑ apple\n☐ banana\n☑ cherry\n❯ Other (type your own)\n\nEnter your response:" });
    h.sim.send({ type: "extension_ui_request", id: "s1", method: "select", title: "Which size do you prefer? (2/2)", options: ["S", "M", "Other (type your own)"] });
    expect(uiValues(h).map((r) => r.value)).toEqual(["apple", "cherry", "Other (type your own)", "apple, cherry, kiwi", "S"]);
    // The answer arrived before any frame: no permission_request was needed.
    expect(h.byType("permission_request")).toEqual([]);
  });

  it("sends (none) for a multi-select without a selection", async () => {
    const h = await startProcess();
    prompt(h);
    h.sim.send(
      assistantEnd([
        {
          type: "toolCall",
          id: "ask2",
          name: "ask",
          arguments: {
            questions: [
              { id: "fruits", question: "Fruits?", options: [{ label: "apple" }], multi: true },
              { id: "size", question: "Size?", options: [{ label: "S" }] },
            ],
          },
        },
      ]),
    );
    h.sim.send({ type: "extension_ui_request", id: "f1", method: "select", title: "Fruits? (1/2)", options: ["apple", "Other (type your own)"] });
    expect(h.proc.status).toBe("waiting_approval");
    h.proc.answer("ask2", JSON.stringify({ answers: { size: "S" } }));
    h.sim.send({ type: "extension_ui_request", id: "f2", method: "editor", title: "Fruits? (1/2)\n\n☐ apple\n❯ Other (type your own)\n\nEnter your response:" });
    h.sim.send({ type: "extension_ui_request", id: "s1", method: "select", title: "Size? (2/2)", options: ["S", "Other (type your own)"] });
    expect(uiValues(h).map((r) => r.value)).toEqual(["Other (type your own)", "(none)", "S"]);
  });

  it("refuses an answer without values for a single choice", async () => {
    const h = await startProcess();
    prompt(h);
    h.sim.send(assistantEnd([{ type: "toolCall", id: "ask3", name: "ask", arguments: { questions: [{ id: "c", question: "C?", options: [{ label: "x" }] }, { id: "d", question: "D?", options: [{ label: "y" }] }] } }]));
    expect(h.proc.answer("ask3", JSON.stringify({ answers: { c: "x" } }))).toBe(false);
    expect(h.proc.answer("ask3", "free text for two questions")).toBe(false);
    expect(h.proc.answer("ask3", JSON.stringify({ answers: { c: "x", D: "y", d: "y" } }))).toBe(true);
  });

  it("normalizes ask titles in the documented order", () => {
    expect(normalizeAskTitle("(1 selected) Which fruits do you like? (1/2)\n\n☑ apple\n❯ Other")).toBe("Which fruits do you like?");
    expect(normalizeAskTitle("Which color do you prefer? (2/2)")).toBe("Which color do you prefer?");
    expect(normalizeAskTitle("(12 selected) Pick (3/10)")).toBe("Pick");
  });

  it("parses answers by id or question text", () => {
    const questions = [
      { id: "a", question: "A?", options: [], multiSelect: false },
      { id: "b", question: "B?", options: [], multiSelect: true },
    ];
    expect(parseAskAnswers(questions, JSON.stringify({ answers: { a: "x", "B?": ["1", "2"] } }))).toEqual([["x"], ["1", "2"]]);
    expect(parseAskAnswers(questions.slice(0, 1), "plain")).toEqual([["plain"]]);
    expect(parseAskAnswers(questions, "{}")).toBeNull();
  });
});

describe("OmpProcess other dialogs (§4.4)", () => {
  it("turns select, confirm, input and editor into one-question AskUserQuestion", async () => {
    const h = await startProcess();
    h.sim.send({ type: "extension_ui_request", id: "s", method: "select", title: "Pick a plan", options: ["A", "B"], optionDetails: [{ description: "first" }, {}] });
    h.sim.send({ type: "extension_ui_request", id: "c", method: "confirm", title: "Proceed?", message: "This changes files." });
    h.sim.send({ type: "extension_ui_request", id: "i", method: "input", title: "Your name", placeholder: "name" });
    h.sim.send({ type: "extension_ui_request", id: "e", method: "editor", title: "Edit message", prefill: "draft" });
    expect(h.byType("permission_request")).toEqual([
      { type: "permission_request", toolUseId: "omp-dialog:s", toolName: "AskUserQuestion", input: { questions: [{ id: "s", multiSelect: false, question: "Pick a plan", options: [{ label: "A", description: "first" }, { label: "B" }] }] } },
      { type: "permission_request", toolUseId: "omp-dialog:c", toolName: "AskUserQuestion", input: { questions: [{ id: "c", multiSelect: false, question: "Proceed?\n\nThis changes files.", options: [{ label: "Yes" }, { label: "No" }] }] } },
      { type: "permission_request", toolUseId: "omp-dialog:i", toolName: "AskUserQuestion", input: { questions: [{ id: "i", multiSelect: false, question: "Your name", header: "name", options: [] }] } },
      { type: "permission_request", toolUseId: "omp-dialog:e", toolName: "AskUserQuestion", input: { questions: [{ id: "e", multiSelect: false, question: "Edit message\n\ndraft", options: [] }] } },
    ]);
    expect(h.proc.status).toBe("waiting_approval");
    expect(h.proc.answer("omp-dialog:s", JSON.stringify({ answers: { s: "B" } }))).toBe(true);
    expect(h.proc.answer("omp-dialog:c", "Yes")).toBe(true);
    expect(h.proc.answer("omp-dialog:i", "Ana")).toBe(true);
    expect(h.proc.reject("omp-dialog:e")).toBe(true);
    expect(h.sim.ofType("extension_ui_response")).toEqual([
      { type: "extension_ui_response", id: "s", value: "B" },
      { type: "extension_ui_response", id: "c", confirmed: true },
      { type: "extension_ui_response", id: "i", value: "Ana" },
      { type: "extension_ui_response", id: "e", cancelled: true },
    ]);
    expect(h.byType("permission_resolved").map((m) => m.toolUseId)).toEqual(["omp-dialog:s", "omp-dialog:c", "omp-dialog:i", "omp-dialog:e"]);
    expect(h.proc.status).toBe("idle");
  });

  it("cancels an unknown select answer and resolves a withdrawn dialog", async () => {
    const h = await startProcess();
    h.sim.send({ type: "extension_ui_request", id: "s", method: "select", title: "Pick", options: ["A"] });
    h.proc.answer("omp-dialog:s", "Z");
    expect(h.sim.ofType("extension_ui_response").at(-1)).toEqual({ type: "extension_ui_response", id: "s", cancelled: true });
    h.sim.send({ type: "extension_ui_request", id: "x", method: "confirm", title: "Sure?", message: "" });
    h.sim.send({ type: "extension_ui_request", id: "cx", method: "cancel", targetId: "x" });
    expect(lastOf(h, "permission_resolved")).toEqual({ type: "permission_resolved", toolUseId: "omp-dialog:x" });
    expect(h.proc.status).toBe("idle");
  });

  it("maps notify and open_url to visible entries", async () => {
    const h = await startProcess();
    h.sim.send({ type: "extension_ui_request", id: "n1", method: "notify", message: "Indexed 10 files" });
    h.sim.send({ type: "extension_ui_request", id: "n2", method: "notify", message: "Disk almost full", notifyType: "warning" });
    h.sim.send({ type: "extension_ui_request", id: "n3", method: "open_url", url: "https://example.com/long", launchUrl: "http://127.0.0.1:1/x", instructions: "Log in there." });
    h.sim.send({ type: "extension_ui_request", id: "n4", method: "set_editor_text", text: "draft" });
    expect(h.byType("error")).toEqual([
      { type: "error", errorCode: "omp_info", message: "Indexed 10 files" },
      { type: "error", errorCode: "omp_notice", message: "Disk almost full" },
      { type: "error", errorCode: "omp_info", message: "omp asks to open http://127.0.0.1:1/x\nLog in there." },
    ]);
  });
});

describe("OmpProcess interrupt (§5.4)", () => {
  it.each([
    ["p4a-abort-approval.jsonl", "1591a42c98eb69d7"],
    ["p4b-cancel-unblocks-abort.jsonl", "1591a497a7ddb0c3"],
  ])("cancels a pending approval before writing abort (%s)", async (name, dialogId) => {
    const records = fixture(name);
    const h = await startProcess();
    const appr = prompt(h, "Run: echo hi");
    const index = h.sim.play(records, 1, { appr });
    const toolUseId = String(lastOf(h, "permission_request").toolUseId);
    h.proc.interrupt();
    const [cancel, abort] = h.sim.commands.slice(-2);
    expect(cancel).toEqual({ type: "extension_ui_response", id: dialogId, cancelled: true });
    expect(abort).toMatchObject({ type: "abort" });
    expect(lastOf(h, "permission_resolved")).toEqual({ type: "permission_resolved", toolUseId });
    expect(h.proc.status).toBe("running");
    // omp's side of the probe; the probe wrote abort first (P4a: it hung until a late answer)
    const rest = records.slice(index).filter((r) => r.dir === "OUT");
    h.sim.play(rest, 0, { "appr-abort": String(abort.id), appr });
    expect(lastOf(h, "result")).toEqual({ type: "result", subtype: "interrupted", sessionId: "01a0e9a3-d69d-7731-b971-1daea26de0fd" });
    expect(h.proc.status).toBe("idle");
  });

  it("follows the designed order in V2 and drains the queue at idle", async () => {
    const records = fixture("v2-interrupt.jsonl");
    const h = await startProcess();
    const c = prompt(h, "Run: echo hi");
    const index = h.sim.play(records, 1, { c });
    const readyBefore = h.inputReady.mock.calls.length;
    h.proc.interrupt();
    expect(h.sim.commands.at(-2)).toEqual(records[index].frame);
    const abortId = String(h.sim.last("abort")!.id);
    const rest = records.slice(index + 1).filter((r) => r.dir === "OUT");
    h.sim.play(rest, 0, { ab: abortId, c });
    expect(lastOf(h, "result")).toMatchObject({ subtype: "interrupted" });
    expect(h.inputReady.mock.calls.length).toBe(readyBefore + 1);
  });

  it("lets omp withdraw an ask dialog on abort (P4c)", async () => {
    const records = fixture("p4c-abort-ask.jsonl");
    const h = await startProcess();
    const ask = prompt(h, "ask");
    const index = h.sim.play(records, 1, { ask });
    h.proc.interrupt();
    const [cancel, abort] = h.sim.commands.slice(-2);
    expect(cancel).toEqual({ type: "extension_ui_response", id: "1591a46f7cab69d9", cancelled: true });
    expect(abort).toMatchObject({ type: "abort" });
    const resolvedBefore = h.byType("permission_resolved").length;
    h.sim.play(records, index + 1, { "ask-abort": String(abort.id), ask });
    expect(h.byType("permission_resolved")).toHaveLength(resolvedBefore);
    expect(lastOf(h, "result")).toMatchObject({ subtype: "interrupted" });
    expect(h.proc.status).toBe("idle");
  });

  it("is a no-op while idle and notices an unconfirmed abort", async () => {
    const h = await startProcess();
    const count = h.sim.commands.length;
    h.proc.interrupt();
    expect(h.sim.commands.length).toBe(count);

    prompt(h);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.proc.interrupt();
    expect(h.sim.last("abort")).toBeDefined();
    vi.advanceTimersByTime(30_000);
    expect(lastOf(h, "error")).toEqual({ type: "error", errorCode: "omp_notice", message: "omp did not confirm the interrupt" });
    expect(h.child.signals).toEqual([]);
  });
});

describe("OmpProcess steer (§5.3)", () => {
  it("reports a run omp started for a steer that arrived after the yield (V3)", async () => {
    const records = fixture("v3-idle-steer.jsonl");
    const h = await startProcess();
    // omp starts a run for a steer without a prompt_result (OBSERVED V3)
    h.sim.play(records, 1, {});
    expect(h.statuses.slice(-2)).toEqual(["running", "idle"]);
    expect(lastOf(h, "result")).toMatchObject({ subtype: "success", result: "STEERED" });
    expect(h.byType("user_input")).toEqual([]);
  });

  it("steers only while busy", async () => {
    const h = await startProcess();
    await expect(h.proc.steer("idle text")).rejects.toMatchObject({ code: "omp_steer_not_busy" });
    expect(h.sim.last("steer")).toBeUndefined();

    prompt(h);
    const steering = h.proc.steer("Also append the word PINEAPPLE to your final reply.", { images: [{ base64: "AAAA", mimeType: "image/png" }] });
    const command = h.sim.last("steer")!;
    expect(command).toEqual({
      id: command.id,
      type: "steer",
      message: "Also append the word PINEAPPLE to your final reply.",
      images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
    // OBSERVED P5
    h.sim.respond(command);
    await expect(steering).resolves.toBeUndefined();
  });
});

describe("OmpProcess writes after close (§2.6)", () => {
  it("refuses every write and reports omp_process_exited once", async () => {
    const h = await startProcess();
    h.proc.stop();
    const written = h.child.stdin.writes.length;
    expect(h.proc.sendInput("x")).toBe(false);
    expect(h.proc.approve()).toBe(false);
    expect(h.proc.approveAlways()).toBe(false);
    expect(h.proc.reject()).toBe(false);
    expect(h.proc.answer("t", "a")).toBe(false);
    await expect(h.proc.steer("x")).rejects.toMatchObject({ code: "omp_process_exited" });
    await expect(h.proc.setModelSettings({ thinkingLevel: "high" })).rejects.toMatchObject({ code: "omp_process_exited" });
    await expect(h.proc.setApprovalMode("fullAccess")).rejects.toMatchObject({ code: "omp_process_exited" });
    await expect(h.proc.setSessionName("n")).rejects.toMatchObject({ code: "omp_process_exited" });
    await expect(h.proc.branch("e")).rejects.toMatchObject({ code: "omp_process_exited" });
    expect(h.child.stdin.writes.length).toBe(written);
    expect(h.byType("error").filter((m) => m.errorCode === "omp_process_exited")).toHaveLength(1);
  });

  it("reports an unexpected exit with the stderr tail", async () => {
    const h = await startProcess();
    const exit = vi.fn();
    h.proc.on("exit", exit);
    prompt(h);
    h.sim.send(assistantEnd([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "x" } }]));
    h.sim.send({ type: "extension_ui_request", id: "d1", method: "select", title: "Allow tool: bash\nCommand: x", options: ["Approve", "Deny"] });
    h.child.stderr.emit("data", "fatal: out of memory\n");
    h.child.exit(134);
    expect(lastOf(h, "permission_resolved")).toEqual({ type: "permission_resolved", toolUseId: "c1" });
    expect(lastOf(h, "error")).toEqual({ type: "error", errorCode: "omp_process_exited", message: "omp exited unexpectedly (code 134): fatal: out of memory" });
    expect(h.proc.status).toBe("idle");
    expect(h.proc.isAlive).toBe(false);
    expect(exit).toHaveBeenCalledWith(134);
    await expect(h.proc.exited).resolves.toBe(134);
  });
});

describe("OmpProcess commands queued while starting (§2.4, §2.6)", () => {
  it("rejects a command queued during the handshake when omp exits before it finished", async () => {
    const created = createProcess();
    created.proc.start("/proj", { bridgeSessionId: "b", executionMode: "default" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const sim = new OmpSim(fakeChildren[0]);
    defaultHandlers(sim, OBSERVED_STATE);
    sim.handlers.set("get_state", () => MANUAL);
    sim.send(READY);
    await flush();
    const rename = created.proc.setSessionName("Later");
    fakeChildren[0].exit(1);
    await expect(rename).rejects.toMatchObject({ code: "omp_process_exited" });
    expect(sim.last("set_session_name")).toBeUndefined();
  });

  it("rejects a command queued while starting when the session is stopped", async () => {
    const created = createProcess();
    created.proc.start("/proj", { bridgeSessionId: "b", executionMode: "default" });
    const rename = created.proc.setSessionName("Later");
    created.proc.stop();
    await expect(rename).rejects.toMatchObject({ code: "omp_process_exited" });
  });

  it("rejects a command queued during a respawn that fails", async () => {
    const h = await startProcess();
    await h.proc.setApprovalMode("fullAccess");
    const rename = h.proc.setSessionName("During respawn");
    h.child.exit(0);
    await vi.waitFor(() => expect(fakeChildren).toHaveLength(2));
    fakeChildren[1].exit(1);
    await expect(rename).rejects.toMatchObject({ code: "omp_process_exited" });
    expect(lastOf(h, "error")).toMatchObject({ errorCode: "omp_respawn_failed" });
  });

  it("settles a model change queued during a respawn that fails before the spawn", async () => {
    const h = await startProcess();
    const exit = vi.fn();
    h.proc.on("exit", exit);
    await expect(h.proc.setApprovalMode("fullAccess")).resolves.toEqual({ applied: "now" });
    const change = h.proc.setModelSettings({ thinkingLevel: "max" });
    // The overlay cannot be written, so the respawn fails before it spawns.
    await rm(overlayPath, { force: true });
    await mkdir(overlayPath);
    h.child.exit(0);
    await expect(h.proc.waitUntilReady()).rejects.toMatchObject({ code: "omp_respawn_failed" });
    await expect(change).rejects.toMatchObject({ code: "omp_process_exited" });
    expect(fakeChildren).toHaveLength(1);
    expect(lastOf(h, "error")).toMatchObject({ errorCode: "omp_respawn_failed" });
    expect(exit).toHaveBeenCalledWith(null);
  });

  it("settles a model change queued during a first start that fails before the spawn", async () => {
    await mkdir(overlayPath);
    const created = createProcess();
    created.proc.start("/proj", { bridgeSessionId: "b", executionMode: "default" });
    const change = created.proc.setModelSettings({ thinkingLevel: "high" });
    await expect(created.proc.waitUntilReady()).rejects.toMatchObject({ code: "omp_start_failed" });
    await expect(change).rejects.toMatchObject({ code: "omp_process_exited" });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("OmpProcess model and thinking (§7.2)", () => {
  const DEEPSEEK = (() => {
    const record = fixture("p7-settings.jsonl").find((r) => r.frame.command === "set_model")!;
    return record.frame.data as Frame;
  })();

  it("sets the model, re-applies the thinking level and reads it back (P7)", async () => {
    const h = await startProcess();
    h.sim.handlers.set("set_model", () => {
      h.sim.send({ type: "model_changed" });
      return DEEPSEEK;
    });
    h.sim.handlers.set("set_thinking_level", (command) => {
      h.sim.send({ type: "thinking_level_changed", thinkingLevel: command.level });
      return undefined;
    });
    const getStates = h.sim.ofType("get_state").length;
    await h.proc.setModelSettings({ model: "baseten/deepseek-ai/DeepSeek-V4-Flash-0731", thinkingLevel: "low" });
    expect(h.sim.last("set_model")).toMatchObject({ provider: "baseten", modelId: "deepseek-ai/DeepSeek-V4-Flash-0731" });
    expect(h.sim.last("set_thinking_level")).toMatchObject({ level: "low" });
    expect(h.sim.ofType("get_state")).toHaveLength(getStates);
    const settings = h.byType("system").filter((m) => m.subtype === "omp_settings");
    expect(settings).toEqual([
      {
        type: "system",
        subtype: "omp_settings",
        provider: "omp",
        sessionId: "01a0e9a3-d69d-7731-b971-1daea26de0fd",
        model: "baseten/deepseek-ai/DeepSeek-V4-Flash-0731",
        thinkingLevel: "low",
        thinkingLevels: ["off", "low", "high", "max"],
      },
    ]);
  });

  it("keeps the previous level or falls back to the highest offered level", async () => {
    const h = await startProcess();
    h.sim.handlers.set("set_model", () => DEEPSEEK);
    h.sim.handlers.set("set_thinking_level", () => undefined);
    // the previous level (high) is offered by DeepSeek (low/high/max)
    await h.proc.setModelSettings({ model: "baseten/deepseek-ai/DeepSeek-V4-Flash-0731" });
    expect(h.sim.last("set_thinking_level")).toMatchObject({ level: "high" });
    // high is not offered: the highest non-off level of the new model
    h.sim.handlers.set("set_model", () => ({ provider: "baseten", id: "small/Model", reasoning: true, thinking: { efforts: ["minimal", "low"] } }));
    await h.proc.setModelSettings({ model: "baseten/small/Model" });
    expect(h.sim.last("set_thinking_level")).toMatchObject({ level: "low" });
    expect(h.sim.last("set_model")).toMatchObject({ provider: "baseten", modelId: "small/Model" });
    h.sim.handlers.set("set_model", () => ({ provider: "baseten", id: "MiniMaxAI/MiniMax-M3", reasoning: false }));
    await h.proc.setModelSettings({ model: "baseten/MiniMaxAI/MiniMax-M3" });
    expect(h.sim.last("set_thinking_level")).toMatchObject({ level: "off" });
  });

  it("reports the level omp actually applied (V1)", async () => {
    const records = fixture("v1-thinking-and-name.jsonl");
    const h = await startProcess();
    const mapped = records.filter((r) => r.dir === "OUT").slice(1, 3); // thinking_level_changed high + response
    h.sim.handlers.set("set_thinking_level", (command) => {
      h.sim.send(mapped[0].frame);
      h.sim.send({ ...mapped[1].frame, id: command.id });
      return MANUAL;
    });
    await h.proc.setModelSettings({ thinkingLevel: "minimal" });
    expect(h.sim.last("set_thinking_level")).toMatchObject({ level: "minimal" });
    expect(lastOf(h, "system")).toMatchObject({ subtype: "omp_settings", thinkingLevel: "high" });
    expect(h.proc.settings.thinkingLevel).toBe("high");
  });

  it("rejects with set_omp_model_failed and keeps the model (P12c)", async () => {
    const h = await startProcess();
    h.sim.handlers.set("set_model", (command) => {
      h.sim.fail(command, "Model not found: baseten/does-not-exist");
      return MANUAL;
    });
    await expect(h.proc.setModelSettings({ model: "baseten/does-not-exist" })).rejects.toMatchObject({
      code: "set_omp_model_failed",
      message: "Model not found: baseten/does-not-exist",
    });
    expect(h.proc.settings.model).toBe("baseten/zai-org/GLM-5.3-Fast");
  });

  it("reports the new model when set_model succeeded but set_thinking_level failed", async () => {
    const h = await startProcess();
    const kimi = { ...GLM, id: "moonshotai/Kimi-K3", name: "Kimi K3", thinking: { efforts: ["low", "high", "max"] } };
    h.sim.handlers.set("set_model", () => kimi);
    h.sim.handlers.set("set_thinking_level", (command) => {
      h.sim.fail(command, "thinking level rejected");
      return MANUAL;
    });
    // omp dropped the level on the switch; the read-back reports it.
    h.sim.handlers.set("get_state", () => ({ ...OBSERVED_STATE, model: kimi, thinkingLevel: undefined }));
    const order: string[] = [];
    h.proc.on("message", (message) => {
      if (message.type === "system" && message.subtype === "omp_settings") order.push("omp_settings");
    });
    const change = h.proc.setModelSettings({ model: "baseten/moonshotai/Kimi-K3" }).catch((err: Error & { code?: string }) => {
      order.push(`rejected:${err.code}`);
    });
    await change;
    expect(order).toEqual(["omp_settings", "rejected:set_omp_model_failed"]);
    expect(lastOf(h, "system")).toEqual({
      type: "system",
      subtype: "omp_settings",
      provider: "omp",
      sessionId: "01a0e9a3-d69d-7731-b971-1daea26de0fd",
      model: "baseten/moonshotai/Kimi-K3",
      thinkingLevels: ["off", "low", "high", "max"],
    });
    expect(h.proc.settings).toEqual({ model: "baseten/moonshotai/Kimi-K3" });
  });

  it("applies a change requested while running after the run, before the queue drains", async () => {
    const h = await startProcess();
    h.sim.handlers.set("set_thinking_level", () => undefined);
    const id = prompt(h);
    const change = h.proc.setModelSettings({ thinkingLevel: "high" });
    const newer = h.proc.setModelSettings({ thinkingLevel: "off" });
    expect(h.sim.last("set_thinking_level")).toBeUndefined();
    const ready = h.inputReady.mock.calls.length;
    h.sim.send({ type: "prompt_result", id, agentInvoked: false, status: "completed", sessionSettled: true });
    await change;
    await newer;
    expect(h.sim.ofType("set_thinking_level")).toEqual([expect.objectContaining({ level: "off" })]);
    await flush();
    expect(h.inputReady.mock.calls.length).toBe(ready + 1);
    const order = h.sim.commands.map((c) => c.type);
    expect(order.lastIndexOf("set_thinking_level")).toBeLessThan(order.lastIndexOf("get_entries") + 1);
  });

  it("holds a change requested while starting until the handshake", async () => {
    const created = createProcess();
    created.proc.start("/proj", { bridgeSessionId: "b", executionMode: "default" });
    const change = created.proc.setModelSettings({ thinkingLevel: "high" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const sim = new OmpSim(fakeChildren[0]);
    defaultHandlers(sim, OBSERVED_STATE);
    sim.handlers.set("set_thinking_level", () => undefined);
    const ready = vi.fn();
    created.proc.on("input_ready", ready);
    sim.send(READY);
    await change;
    expect(sim.commands.map((c) => c.type).slice(0, 4)).toEqual(["negotiate_protocol", "set_interrupt_mode", "get_state", "set_thinking_level"]);
    await flush();
    expect(ready).toHaveBeenCalled();
  });
});

describe("OmpProcess approval mode (§7.3)", () => {
  it("defers until idle and settled, then respawns with --resume and keeps the allow-list", async () => {
    const file = join(tmp, "session.jsonl");
    await writeFile(file, "{}\n");
    const state = { ...OBSERVED_STATE, sessionFile: file };
    const h = await startProcess({}, state);
    const exit = vi.fn();
    h.proc.on("exit", exit);

    // approve-always bash in the first child
    prompt(h);
    h.sim.send(assistantEnd([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo 1" } }]));
    h.sim.send({ type: "extension_ui_request", id: "d1", method: "select", title: "Allow tool: bash\nCommand: echo 1", options: ["Approve", "Deny"] });
    h.proc.approveAlways("c1");

    await expect(h.proc.setApprovalMode("fullAccess")).resolves.toEqual({ applied: "deferred" });
    h.sim.send({ type: "agent_start" });
    h.sim.send({ type: "agent_end", messages: [], isTerminal: false, yielded: true });
    h.sim.send({ type: "prompt_result", id: String(h.sim.last("prompt")!.id), agentInvoked: true, status: "completed", sessionSettled: false });
    await flush();
    expect(h.proc.status).toBe("idle");
    expect(h.child.stdin.ended).toBe(false); // background work pending: not yet

    h.sim.send({ type: "session_settled" });
    expect(h.child.stdin.ended).toBe(true);
    expect(h.proc.status).toBe("starting");
    expect(fakeChildren).toHaveLength(1);
    h.child.exit(0);
    await vi.waitFor(() => expect(fakeChildren).toHaveLength(2));
    const next = fakeChildren[1];
    expect(next.args).toEqual(["--mode", "rpc-ui", "--cwd", "/proj", "--allow-home", "--approval-mode", "yolo", "--config", overlayPath, "--resume", file]);
    const sim = new OmpSim(next);
    defaultHandlers(sim, state);
    sim.send(READY);
    await h.proc.waitUntilReady();
    await flush();
    expect(exit).not.toHaveBeenCalled();
    expect(h.byType("system").slice(-2)).toEqual([
      expect.objectContaining({ subtype: "init", executionMode: "fullAccess" }),
      {
        type: "system",
        subtype: "set_permission_mode",
        provider: "omp",
        sessionId: "01a0e9a3-d69d-7731-b971-1daea26de0fd",
        permissionMode: "bypassPermissions",
        executionMode: "fullAccess",
      },
    ]);
    expect(h.proc.status).toBe("idle");
    expect(h.proc.executionMode).toBe("fullAccess");

    // the allow-list survived the respawn
    h.proc.sendInput("again");
    sim.send(assistantEnd([{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "echo 2" } }]));
    sim.send({ type: "extension_ui_request", id: "d2", method: "select", title: "Allow tool: bash\nCommand: echo 2", options: ["Approve", "Deny"] });
    expect(sim.ofType("extension_ui_response").at(-1)).toEqual({ type: "extension_ui_response", id: "d2", value: "Approve" });
  });

  it("respawns without --resume while nothing was persisted and resets the cursor", async () => {
    const h = await startProcess({ entryCursor: "old-cursor" }, { ...OBSERVED_STATE, sessionFile: join(tmp, "not-yet.jsonl") });
    expect(h.sim.last("get_entries")).toMatchObject({ since: "old-cursor" });
    await expect(h.proc.setApprovalMode("acceptEdits")).resolves.toEqual({ applied: "now" });
    h.child.exit(0);
    await vi.waitFor(() => expect(fakeChildren).toHaveLength(2));
    expect(fakeChildren[1].args).toEqual([
      "--mode", "rpc-ui", "--cwd", "/proj", "--allow-home", "--approval-mode", "write", "--config", overlayPath,
      "--model", "baseten/zai-org/GLM-5.3-Fast", "--thinking", "high",
    ]);
    const sim = new OmpSim(fakeChildren[1]);
    defaultHandlers(sim, { ...OBSERVED_STATE, sessionId: "new-omp-id" });
    sim.send(READY);
    await h.proc.waitUntilReady();
    await flush();
    expect(sim.last("get_entries")).toEqual({ id: expect.any(String), type: "get_entries" });
    expect(h.byType("system").find((m) => m.subtype === "init" && m.sessionId === "new-omp-id")).toBeDefined();
  });

  it("answers now for an unchanged mode", async () => {
    const h = await startProcess();
    await expect(h.proc.setApprovalMode("default")).resolves.toEqual({ applied: "now" });
    expect(h.child.stdin.ended).toBe(false);
  });

  it("reports omp_respawn_failed when the new child exits before ready", async () => {
    const h = await startProcess();
    const exit = vi.fn();
    h.proc.on("exit", exit);
    await h.proc.setApprovalMode("fullAccess");
    h.child.exit(0);
    await vi.waitFor(() => expect(fakeChildren).toHaveLength(2));
    fakeChildren[1].stderr.emit("data", "config error\n");
    fakeChildren[1].exit(1);
    await expect(h.proc.waitUntilReady()).rejects.toMatchObject({ code: "omp_respawn_failed" });
    expect(lastOf(h, "error")).toMatchObject({ errorCode: "omp_respawn_failed", message: expect.stringContaining("config error") });
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("OmpProcess branch and name (§6.3, §6.6)", () => {
  it("branches in place and moves the writer registration (P9)", async () => {
    const records = fixture("p9-branch.jsonl");
    const oldFile = "/store/2026-09-28T19-01-03-727Z_01a0e964-5c6f-709e-b709-9a4c92b85f91.jsonl";
    const h = await startProcess({}, { ...OBSERVED_STATE, sessionId: "01a0e964-5c6f-709e-b709-9a4c92b85f91", sessionFile: oldFile });
    expect(h.writers.ownerBySessionId("01a0e964-5c6f-709e-b709-9a4c92b85f91")).toBeDefined();
    const branchResponse = records.find((r) => r.frame.command === "branch" && r.frame.success === true)!.frame;
    const stateAfter = records.find((r) => r.frame.command === "get_state")!.frame.data as Frame;
    h.sim.handlers.set("branch", () => branchResponse.data);
    h.sim.handlers.set("get_state", () => stateAfter);
    const result = await h.proc.branch("768c81ff");
    expect(h.sim.last("branch")).toMatchObject({ entryId: "768c81ff" });
    expect(result).toEqual({
      cancelled: false,
      sessionId: "01a0e964-6d94-752c-9fcd-caf2ba46b422",
      sessionFile: stateAfter.sessionFile,
    });
    expect(h.proc.sessionId).toBe("01a0e964-6d94-752c-9fcd-caf2ba46b422");
    expect(h.writers.ownerBySessionId("01a0e964-5c6f-709e-b709-9a4c92b85f91")).toBeUndefined();
    expect(h.writers.ownerBySessionId("01a0e964-6d94-752c-9fcd-caf2ba46b422")).toEqual({ owner: "bridge-1", file: stateAfter.sessionFile });
  });

  it("reports a vetoed branch and a refused entry", async () => {
    const h = await startProcess();
    h.sim.handlers.set("branch", () => ({ text: "", cancelled: true }));
    await expect(h.proc.branch("x")).resolves.toMatchObject({ cancelled: true, sessionId: "01a0e9a3-d69d-7731-b971-1daea26de0fd" });
    h.sim.handlers.set("branch", (command) => {
      h.sim.fail(command, "Invalid entry ID for branching");
      return MANUAL;
    });
    await expect(h.proc.branch("deadbeef")).rejects.toThrow("Invalid entry ID for branching");
  });

  it("renames the running session", async () => {
    const h = await startProcess();
    h.sim.handlers.set("set_session_name", () => undefined);
    await h.proc.setSessionName("Probe seven");
    expect(h.sim.last("set_session_name")).toMatchObject({ name: "Probe seven" });
    h.sim.handlers.set("set_session_name", (command) => {
      h.sim.fail(command, "Session name cannot be empty");
      return MANUAL;
    });
    await expect(h.proc.setSessionName(" ")).rejects.toThrow("Session name cannot be empty");
  });
});

describe("OmpProcess user entries (§6.6)", () => {
  const V4 = fixture("v4-get-entries.jsonl").find((r) => r.dir === "OUT")!.frame.data as { entries: Frame[]; leafId: string };

  it("advances the cursor and asks only for entries after it", async () => {
    const h = await startProcess({}, OBSERVED_STATE, (sim) => {
      sim.handlers.set("get_entries", () => V4);
    });
    const emitted: Array<Array<{ entryId: string; text: string }>> = [];
    h.proc.on("user_entries", (list) => emitted.push(list));
    // The handshake's backfill already ran; run another idle transition.
    h.sim.handlers.set("get_entries", () => ({ entries: [], leafId: V4.leafId }));
    const id = prompt(h);
    h.sim.send({ type: "prompt_result", id, agentInvoked: false, status: "completed", sessionSettled: true });
    await flush();
    expect(h.sim.last("get_entries")).toMatchObject({ since: "5eed0001" });
    expect(emitted).toEqual([]);
  });

  it("computes the active path entries", () => {
    expect(newUserEntriesOnPath(V4.entries, V4.leafId)).toEqual([
      { entryId: "4e2f6292", text: "Reply with exactly: ONE" },
      { entryId: "5eed0001", text: "SIDE BRANCH PROMPT" },
    ]);
    expect(newUserEntriesOnPath(V4.entries, null)).toEqual([]);
    const steered = [{ type: "message", id: "s1", parentId: null, message: { role: "user", content: [{ type: "text", text: "steer" }], steering: true, attribution: "user" } }];
    expect(newUserEntriesOnPath(steered, "s1")).toEqual([{ entryId: "s1", text: "steer" }]);
    const agent = [{ type: "message", id: "a1", parentId: null, message: { role: "user", content: "x", attribution: "agent" } }];
    expect(newUserEntriesOnPath(agent, "a1")).toEqual([]);
  });

  it("emits entries from the handshake backfill and stops on unknown_since", async () => {
    const emitted: unknown[] = [];
    const created = createProcess();
    created.proc.on("user_entries", (list) => emitted.push(list));
    created.proc.start("/proj", { bridgeSessionId: "b", executionMode: "default" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const sim = new OmpSim(fakeChildren[0]);
    defaultHandlers(sim, OBSERVED_STATE);
    sim.handlers.set("get_entries", () => V4);
    sim.send(READY);
    await created.proc.waitUntilReady();
    await flush();
    expect(sim.last("get_entries")).toEqual({ id: expect.any(String), type: "get_entries" });
    expect(emitted).toEqual([
      [
        { entryId: "4e2f6292", text: "Reply with exactly: ONE" },
        { entryId: "5eed0001", text: "SIDE BRANCH PROMPT" },
      ],
    ]);
    sim.handlers.set("get_entries", (command) => {
      sim.fail(command, "Unknown entries cursor: 5eed0001", "unknown_since");
      return MANUAL;
    });
    created.proc.sendInput("x");
    sim.send({ type: "prompt_result", id: sim.last("prompt")!.id, agentInvoked: false, status: "completed", sessionSettled: true });
    await flush();
    const count = sim.ofType("get_entries").length;
    created.proc.sendInput("y");
    sim.send({ type: "prompt_result", id: sim.last("prompt")!.id, agentInvoked: false, status: "completed", sessionSettled: true });
    await flush();
    expect(sim.ofType("get_entries")).toHaveLength(count);
  });
});

describe("OmpProcess stop (§2.6)", () => {
  it("cancels dialogs, aborts the run, closes stdin and escalates signals", async () => {
    const h = await startProcess();
    prompt(h);
    h.sim.send(assistantEnd([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "x" } }]));
    h.sim.send({ type: "extension_ui_request", id: "d1", method: "select", title: "Allow tool: bash\nCommand: x", options: ["Approve", "Deny"] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const exit = vi.fn();
    h.proc.on("exit", exit);
    h.proc.stop();
    const [cancel, abort] = h.sim.commands.slice(-2);
    expect(cancel).toEqual({ type: "extension_ui_response", id: "d1", cancelled: true });
    expect(abort).toMatchObject({ type: "abort" });
    expect(lastOf(h, "permission_resolved")).toEqual({ type: "permission_resolved", toolUseId: "c1" });
    expect(h.child.stdin.ended).toBe(true);
    expect(h.proc.status).toBe("idle");
    expect(h.proc.isAlive).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(h.child.signals).toEqual(["SIGTERM"]);
    vi.advanceTimersByTime(5000);
    expect(h.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    h.child.exit(null);
    expect(exit).toHaveBeenCalledWith(null);
    await expect(h.proc.exited).resolves.toBeNull();
    expect(h.byType("error").filter((m) => m.errorCode === "omp_process_exited")).toEqual([]);
  });

  it("releases the writer registration when the child exits", async () => {
    const file = join(tmp, "s.jsonl");
    const h = await startProcess({}, { ...OBSERVED_STATE, sessionFile: file });
    h.proc.stop();
    let released = false;
    const wait = h.writers.waitForRelease(file, 1000).then(() => (released = true));
    await flush();
    expect(released).toBe(false);
    h.child.exit(0);
    await wait;
    expect(released).toBe(true);
  });

  it("stops before the child was spawned", async () => {
    const created = createProcess();
    const exit = vi.fn();
    created.proc.on("exit", exit);
    let release!: () => void;
    const file = join(tmp, "held.jsonl");
    created.writers.register(file, { owner: "x", sessionId: "s", exited: new Promise<void>((r) => (release = r)) });
    created.proc.start("/proj", { bridgeSessionId: "b", executionMode: "default", resumeSessionFile: file });
    created.proc.stop();
    release();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(spawnMock).not.toHaveBeenCalled();
    await expect(created.proc.waitUntilReady()).rejects.toMatchObject({ code: "omp_process_exited" });
  });
});
