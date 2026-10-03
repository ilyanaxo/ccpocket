/**
 * omp wiring through the real BridgeWebSocketServer, SessionManager and
 * OmpProcess (docs/omp-integration.md §11.1 WP2). Only `spawn` is faked: a
 * scripted omp RPC child answers the Bridge's commands, so no test runs the
 * real omp CLI. HOME and the omp store point at a temp directory.
 */
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Frame = Record<string, unknown>;

const { spawnMock, sims } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  sims: [] as FakeOmp[],
}));

// Stores such as the debug trace, gallery and prompt-history backup resolve
// their directories from homedir() at import time, so HOME must point at a
// temp directory before the Bridge modules are imported.
const suiteHome = await vi.hoisted(async () => {
  const { mkdtempSync: makeTemp } = await import("node:fs");
  const { tmpdir: osTmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const home = makeTemp(joinPath(osTmpdir(), "ccpocket-omp-ws-suite-"));
  process.env.HOME = home;
  return home;
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

import { ArchiveStore } from "./archive-store.js";
import { BridgeWebSocketServer } from "./websocket.js";
import { clearOmpSessionCaches } from "./omp-sessions.js";
import { parseClientMessage } from "./parser.js";

// ---------------------------------------------------------------------------
// Fake omp child
// ---------------------------------------------------------------------------

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

class FakeStdin extends EventEmitter {
  writes: string[] = [];
  ended = false;
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

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = new FakeStdin();
  pid: number | undefined = 4242;
  exited = false;
  kill(): boolean {
    setTimeout(() => this.exit(null), 0);
    return true;
  }
  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    // Node order: `exit`, then `close` once stdio is drained.
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

const MANUAL = Symbol("manual");

const GLM = {
  id: "zai-org/GLM-5.3-Fast",
  name: "GLM 5.3 Fast",
  provider: "baseten",
  reasoning: true,
  input: ["text", "image"],
  thinking: { mode: "effort", efforts: ["high", "max"] },
};
const MINIMAX = {
  id: "MiniMaxAI/MiniMax-M3",
  name: "MiniMax M3",
  provider: "baseten",
  reasoning: false,
  input: ["text"],
};
const CATALOGUE = {
  models: [
    {
      provider: "baseten",
      kind: "chat",
      id: GLM.id,
      selector: `baseten/${GLM.id}`,
      name: GLM.name,
      thinking: ["high", "max"],
      input: ["text", "image"],
    },
    {
      provider: "baseten",
      kind: "chat",
      id: MINIMAX.id,
      selector: `baseten/${MINIMAX.id}`,
      name: MINIMAX.name,
      thinking: null,
      input: ["text"],
    },
  ],
};

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/** A scripted `omp --mode rpc-ui` / `--mode rpc` child. */
class FakeOmp {
  readonly commands: Frame[] = [];
  readonly responders = new Map<string, (command: Frame) => unknown>();
  readonly entries: Frame[] = [];
  readonly argv: string[];
  state: Frame;
  /** Keep the child alive after stdin closed (a slow dispose). */
  holdExit = false;
  private entrySeq = 0;

  constructor(
    readonly child: FakeChild,
    argv: string[],
    readonly options: { cwd: string },
  ) {
    this.argv = argv;
    const resume = flag(argv, "--resume");
    const model = flag(argv, "--model");
    const selected = model === `baseten/${MINIMAX.id}` ? MINIMAX : GLM;
    const thinking = flag(argv, "--thinking");
    const header = resume ? readHeader(resume) : undefined;
    this.state = {
      sessionId: header?.id ?? `omp-new-${sims.length + 1}`,
      sessionFile: resume ?? join(fakeStoreBucket(), `2026_new-${sims.length + 1}.jsonl`),
      model: selected,
      ...(thinking ? { thinkingLevel: thinking } : selected === GLM ? { thinkingLevel: "high" } : {}),
      isStreaming: false,
      isSettled: true,
    };
    child.stdin.on("write", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        this.handle(JSON.parse(line) as Frame);
      }
    });
    child.stdin.on("end", () => {
      if (!this.holdExit) setTimeout(() => child.exit(0), 0);
    });
    setTimeout(
      () =>
        this.send({
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
          maxFrameBytes: 1048576,
          maxReassembledFrameBytes: 67108864,
        }),
      0,
    );
  }

  get approvalMode(): string | undefined {
    return flag(this.argv, "--approval-mode");
  }

  /** Frames are written asynchronously and in order, as a real child does. */
  send(frame: Frame): void {
    setTimeout(() => {
      if (this.child.exited) return;
      this.child.stdout.emit("data", `${JSON.stringify(frame)}\n`);
    }, 0);
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

  fail(command: Frame, error: string): void {
    this.send({
      id: command.id,
      type: "response",
      command: command.type,
      success: false,
      error,
    });
  }

  commandsOf(type: string): Frame[] {
    return this.commands.filter((command) => command.type === type);
  }

  addUserEntry(text: string): string {
    const id = `e${++this.entrySeq}-${sims.indexOf(this)}`;
    this.entries.push({
      type: "message",
      id,
      parentId: (this.entries.at(-1)?.id as string | undefined) ?? null,
      message: { role: "user", content: [{ type: "text", text }], attribution: "user" },
    });
    return id;
  }

  /** A complete assistant run answering `prompt` with `text`. */
  reply(prompt: Frame, text: string): void {
    this.send({ type: "agent_start" });
    this.send({
      type: "message_update",
      messageId: "msg-a",
      assistantMessageEvent: { type: "text_delta", delta: text },
    });
    this.send({
      type: "message_end",
      messageId: "msg-a",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        provider: "baseten",
        model: GLM.id,
        usage: { input: 10, output: 2, cacheRead: 5, cost: { total: 0.001 } },
        stopReason: "stop",
      },
    });
    this.send({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
    this.send({
      type: "prompt_result",
      id: prompt.id,
      agentInvoked: true,
      status: "completed",
      sessionSettled: true,
    });
  }

  private handle(command: Frame): void {
    this.commands.push(command);
    const custom = this.responders.get(String(command.type));
    if (custom) {
      const data = custom(command);
      if (data !== MANUAL && command.id !== undefined) this.respond(command, data);
      return;
    }
    switch (command.type) {
      case "negotiate_protocol":
        this.respond(command, { protocolVersion: 2 });
        break;
      case "get_state":
        this.respond(command, this.state);
        break;
      case "prompt":
        this.addUserEntry(String(command.message));
        this.respond(command);
        this.reply(command, "OK");
        break;
      case "get_entries": {
        const since = command.since as string | undefined;
        const start = since ? this.entries.findIndex((entry) => entry.id === since) + 1 : 0;
        this.respond(command, {
          entries: this.entries.slice(start),
          leafId: this.entries.at(-1)?.id ?? null,
        });
        break;
      }
      case "set_model": {
        const model = command.modelId === MINIMAX.id ? MINIMAX : GLM;
        this.state = { ...this.state, model };
        this.respond(command, model);
        this.send({ type: "model_changed" });
        break;
      }
      case "set_thinking_level":
        this.state = { ...this.state, thinkingLevel: command.level };
        this.respond(command);
        this.send({ type: "thinking_level_changed", thinkingLevel: command.level });
        break;
      case "extension_ui_response":
        break;
      default:
        this.respond(command);
    }
  }
}

// ---------------------------------------------------------------------------
// Temp home, omp store and session files
// ---------------------------------------------------------------------------

let tempHome = "";
let projectDir = "";

function fakeStoreBucket(): string {
  return join(tempHome, "omp-agent", "sessions", "-bucket");
}

function titleSlot(title: string): string {
  const base = { type: "title", v: 1, title, updatedAt: "2026-09-28T18:57:15.982Z", pad: "" };
  const pad = " ".repeat(Math.max(0, 255 - JSON.stringify(base).length));
  return JSON.stringify({ ...base, pad });
}

interface SessionFileSpec {
  id: string;
  cwd: string;
  title?: string;
  users: Array<{ id: string; text: string; images?: Array<{ data: string; mimeType: string }> }>;
}

/** An omp session file: title slot, header, model/thinking, user/assistant pairs. */
function writeSessionFile(spec: SessionFileSpec): string {
  mkdirSync(fakeStoreBucket(), { recursive: true });
  const file = join(fakeStoreBucket(), `2026-09-28T18-57-12-742Z_${spec.id}.jsonl`);
  const lines = [
    titleSlot(spec.title ?? ""),
    JSON.stringify({
      type: "session",
      version: 3,
      id: spec.id,
      timestamp: "2026-09-28T18:57:12.742Z",
      cwd: spec.cwd,
    }),
    JSON.stringify({
      type: "model_change",
      id: "m0",
      parentId: null,
      timestamp: "2026-09-28T18:57:12.798Z",
      model: `baseten/${GLM.id}`,
    }),
  ];
  let parent = "m0";
  spec.users.forEach((user, index) => {
    const content = [
      { type: "text", text: user.text },
      ...(user.images ?? []).map((image) => ({ type: "image", ...image })),
    ];
    lines.push(
      JSON.stringify({
        type: "message",
        id: user.id,
        parentId: parent,
        timestamp: "2026-09-28T18:57:13.167Z",
        message: { role: "user", content, attribution: "user" },
      }),
    );
    const assistantId = `a${index}`;
    lines.push(
      JSON.stringify({
        type: "message",
        id: assistantId,
        parentId: user.id,
        timestamp: "2026-09-28T18:57:14.030Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `answer ${index}` }],
          provider: "baseten",
          model: GLM.id,
          stopReason: "stop",
        },
      }),
    );
    parent = assistantId;
  });
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

function readHeader(file: string): { id: string; cwd: string } | undefined {
  try {
    const header = JSON.parse(readFileSync(file, "utf8").split("\n")[1]) as {
      id: string;
      cwd: string;
    };
    return header;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// spawn routing
// ---------------------------------------------------------------------------

type SpawnScript = (child: FakeChild, argv: string[]) => void;
let rpcBehaviour: ((sim: FakeOmp) => void) | undefined;
let printOutput = "Generated name";
let failNextRpcBeforeReady: string | undefined;
/** The next rpc child never writes `ready` (it only exits when killed). */
let silentNextRpc = false;
const silentChildren: FakeChild[] = [];
let modelsScript: SpawnScript | undefined;

function installSpawn(): void {
  spawnMock.mockImplementation(
    (command: string, argv: string[], options: { cwd: string }) => {
      const child = new FakeChild();
      if (argv[0] === "models") {
        (modelsScript ??
          ((c) =>
            setTimeout(() => {
              c.stdout.emit("data", JSON.stringify(CATALOGUE));
              c.exit(0);
            }, 0)))(child, argv);
        return child;
      }
      if (argv[0] === "-p") {
        setTimeout(() => {
          child.stdout.emit("data", `${printOutput}\n`);
          child.exit(0);
        }, 0);
        return child;
      }
      if (argv[0] === "--mode") {
        if (silentNextRpc) {
          silentNextRpc = false;
          silentChildren.push(child);
          return child;
        }
        if (failNextRpcBeforeReady) {
          const stderr = failNextRpcBeforeReady;
          failNextRpcBeforeReady = undefined;
          setTimeout(() => {
            child.stderr.emit("data", stderr);
            child.exit(1);
          }, 0);
          return child;
        }
        const sim = new FakeOmp(child, argv, options);
        sims.push(sim);
        rpcBehaviour?.(sim);
        return child;
      }
      // Any other CLI (claude, codex) is not installed in this environment.
      child.pid = undefined;
      setTimeout(() => {
        const err = Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
        child.emit("error", err);
        child.emit("close", -2);
      }, 0);
      return child;
    },
  );
}

// ---------------------------------------------------------------------------
// Bridge harness
// ---------------------------------------------------------------------------

const OPEN = 1;

interface FakeSocket {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
}

function socket(): FakeSocket {
  return { readyState: OPEN, send: vi.fn() };
}

function sent(ws: FakeSocket): Frame[] {
  return ws.send.mock.calls.map((call) => JSON.parse(call[0] as string) as Frame);
}

function lastOf(ws: FakeSocket, predicate: (msg: Frame) => boolean): Frame | undefined {
  return sent(ws).filter(predicate).at(-1);
}

async function until<T>(read: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let httpServer: ReturnType<typeof createServer>;
let bridge: BridgeWebSocketServer;
let savedEnv: Record<string, string | undefined>;

function bridgeAny(): any {
  return bridge as any;
}

async function connect(declaresOmp = true): Promise<FakeSocket> {
  const ws = socket();
  bridgeAny().wss.clients.add(ws);
  await bridgeAny().handleClientMessage(
    {
      type: "client_capabilities",
      protocolVersion: 1,
      supportedServerMessages: ["conversation_queue", "session_context"],
      ...(declaresOmp ? { supportedProviders: ["claude", "codex", "omp"] } : {}),
    },
    ws,
  );
  return ws;
}

async function handle(ws: FakeSocket, msg: Frame): Promise<void> {
  const parsed = parseClientMessage(JSON.stringify(msg));
  expect(parsed, `client message ${String(msg.type)} parses`).not.toBeNull();
  await bridgeAny().handleClientMessage(parsed, ws);
}

async function startOmp(
  ws: FakeSocket,
  extra: Frame = {},
): Promise<{ sessionId: string; sim: FakeOmp }> {
  const before = sims.length;
  await handle(ws, {
    type: "start",
    provider: "omp",
    projectPath: projectDir,
    executionMode: "default",
    requestId: `start-${before}`,
    ...extra,
  });
  const created = await until(() =>
    lastOf(ws, (m) => m.type === "system" && m.subtype === "session_created"),
  );
  const sim = await until(() => sims[before]);
  await until(() =>
    sent(ws).some((m) => m.type === "system" && m.subtype === "init" && m.sessionId === created.sessionId),
  );
  return { sessionId: String(created.sessionId), sim };
}

async function waitIdle(ws: FakeSocket, sessionId: string): Promise<void> {
  await until(() => bridgeAny().sessionManager.get(sessionId)?.process.isWaitingForInput);
  void ws;
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "ccpocket-omp-ws-"));
  projectDir = join(tempHome, "project");
  mkdirSync(projectDir, { recursive: true });
  savedEnv = {
    HOME: process.env.HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    BRIDGE_OMP_BIN: process.env.BRIDGE_OMP_BIN,
    BRIDGE_OMP_ASSIST_MODEL: process.env.BRIDGE_OMP_ASSIST_MODEL,
  };
  process.env.HOME = tempHome;
  process.env.PI_CODING_AGENT_DIR = join(tempHome, "omp-agent");
  delete process.env.BRIDGE_OMP_BIN;
  delete process.env.BRIDGE_OMP_ASSIST_MODEL;
  sims.length = 0;
  rpcBehaviour = undefined;
  printOutput = "Generated name";
  failNextRpcBeforeReady = undefined;
  silentNextRpc = false;
  silentChildren.length = 0;
  modelsScript = undefined;
  spawnMock.mockReset();
  installSpawn();
  clearOmpSessionCaches();
  httpServer = createServer();
  bridge = new BridgeWebSocketServer({ server: httpServer, allowedDirs: [tempHome] });
});

afterEach(async () => {
  bridge.close();
  httpServer.close();
  // Let the stopped fake children exit before the temp home disappears.
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(suiteHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("omp capability and visibility", () => {
  it("re-sends session_list with the omp catalogue to a client that declares omp", async () => {
    await bridgeAny().refreshOmpModels();
    const ws = await connect(true);
    const list = lastOf(ws, (m) => m.type === "session_list")!;
    expect(list.protocolCapabilities).toEqual([
      "performance_mode_v1",
      "project_request_correlation_v1",
      "session_context_v1",
      "provider_omp_v1",
    ]);
    expect(list.ompAvailability).toBe("available");
    expect(list.ompModelsRevision).toBe(1);
    expect(list.ompModels).toEqual([
      {
        selector: `baseten/${GLM.id}`,
        provider: "baseten",
        name: GLM.name,
        thinkingLevels: ["off", "high", "max"],
        input: ["text", "image"],
      },
      {
        selector: `baseten/${MINIMAX.id}`,
        provider: "baseten",
        name: MINIMAX.name,
        thinkingLevels: ["off"],
        input: ["text"],
      },
    ]);
  });

  it("leaves the omp fields out until the first catalogue refresh finished", async () => {
    const ws = await connect(true);
    const list = lastOf(ws, (m) => m.type === "session_list")!;
    expect(list.protocolCapabilities).toContain("provider_omp_v1");
    expect(list).not.toHaveProperty("ompModels");
    expect(list).not.toHaveProperty("ompAvailability");

    await bridgeAny().refreshOmpModels();
    // The first refresh sends each declaring client a fresh session_list.
    expect(lastOf(ws, (m) => m.type === "session_list")?.ompAvailability).toBe("available");
  });

  it("reports not_installed and no_models", async () => {
    modelsScript = (child) =>
      setTimeout(() => {
        child.pid = undefined;
        child.emit("error", Object.assign(new Error("spawn omp ENOENT"), { code: "ENOENT" }));
      }, 0);
    await bridgeAny().refreshOmpModels();
    const ws = await connect(true);
    expect(lastOf(ws, (m) => m.type === "session_list")?.ompAvailability).toBe("not_installed");

    modelsScript = (child) =>
      setTimeout(() => {
        child.stdout.emit("data", JSON.stringify({ models: [] }));
        child.exit(0);
      }, 0);
    await bridgeAny().refreshOmpModels();
    expect(lastOf(ws, (m) => m.type === "session_list")?.ompAvailability).toBe("no_models");
  });

  it("includes the catalogue in broadcasts only when its revision changed", async () => {
    await bridgeAny().refreshOmpModels();
    const ws = await connect(true);
    bridgeAny().broadcastSessionList();
    bridgeAny().broadcastSessionList();
    const lists = sent(ws).filter((m) => m.type === "session_list");
    expect(lists.at(-2)).toHaveProperty("ompModels");
    expect(lists.at(-1)).not.toHaveProperty("ompModels");
  });

  it("hides omp sessions, fields and session traffic from a client that did not declare omp", async () => {
    await bridgeAny().refreshOmpModels();
    const legacy = await connect(false);
    const ws = await connect(true);
    legacy.send.mockClear();
    const { sessionId, sim } = await startOmp(ws);
    await handle(ws, { type: "input", sessionId, text: "hello" });
    await until(() => sent(ws).some((m) => m.type === "result" && m.sessionId === sessionId));
    bridgeAny().broadcastSessionList();

    const legacyMessages = sent(legacy);
    expect(legacyMessages.some((m) => m.sessionId === sessionId)).toBe(false);
    for (const list of legacyMessages.filter((m) => m.type === "session_list")) {
      expect(list).not.toHaveProperty("ompModels");
      expect(list).not.toHaveProperty("ompAvailability");
      expect((list.sessions as Frame[]).some((s) => s.provider === "omp")).toBe(false);
    }
    expect(sim.commandsOf("prompt")).toHaveLength(1);

    // Requests naming omp from an undeclared client are unsupported.
    legacy.send.mockClear();
    await handle(legacy, { type: "start", provider: "omp", projectPath: projectDir });
    await handle(legacy, { type: "list_recent_sessions", provider: "omp" });
    await handle(legacy, { type: "set_omp_model", sessionId, model: `baseten/${GLM.id}` });
    expect(sent(legacy)).toEqual([
      { type: "error", errorCode: "unsupported_message", message: "start" },
      { type: "error", errorCode: "unsupported_message", message: "list_recent_sessions" },
      { type: "error", errorCode: "unsupported_message", message: "set_omp_model" },
    ]);
  });

  it("resolves a session link by Bridge id across providers and hides omp from undeclared clients", async () => {
    const ws = await connect(true);
    const legacy = await connect(false);
    const { sessionId } = await startOmp(ws);

    await handle(ws, {
      type: "resolve_session_link",
      requestId: "r1",
      sessionId,
      provider: "claude",
    });
    expect(lastOf(ws, (m) => m.type === "session_link_resolution")).toMatchObject({
      status: "live",
      bridgeSessionId: sessionId,
      provider: "omp",
    });

    await handle(legacy, {
      type: "resolve_session_link",
      requestId: "r2",
      sessionId,
      provider: "claude",
    });
    expect(lastOf(legacy, (m) => m.type === "session_link_resolution")).toMatchObject({
      requestId: "r2",
      status: "unavailable",
    });
  });
});

describe("omp start", () => {
  it("starts omp with validated model, thinking level and approval mode", async () => {
    await bridgeAny().refreshOmpModels();
    const ws = await connect(true);
    const { sessionId, sim } = await startOmp(ws, {
      executionMode: "acceptEdits",
      permissionMode: "acceptEdits",
      model: `baseten/${GLM.id}`,
      thinkingLevel: "high",
      autoRename: true,
    });
    expect(sim.approvalMode).toBe("write");
    expect(flag(sim.argv, "--model")).toBe(`baseten/${GLM.id}`);
    expect(flag(sim.argv, "--thinking")).toBe("high");
    expect(flag(sim.argv, "--cwd")).toBe(projectDir);

    const created = lastOf(ws, (m) => m.subtype === "session_created")!;
    expect(created).toMatchObject({
      sessionId,
      provider: "omp",
      projectPath: projectDir,
      permissionMode: "acceptEdits",
      executionMode: "acceptEdits",
      planMode: false,
      model: `baseten/${GLM.id}`,
      thinkingLevel: "high",
      requestId: "start-0",
    });
    expect(created).not.toHaveProperty("sandboxMode");
    expect(lastOf(ws, (m) => m.subtype === "init")).toMatchObject({
      sessionId,
      provider: "omp",
      model: `baseten/${GLM.id}`,
      thinkingLevel: "high",
      thinkingLevels: ["off", "high", "max"],
      executionMode: "acceptEdits",
      permissionMode: "acceptEdits",
    });
  });

  it("drops a model omp does not list and maps plan mode with tips", async () => {
    await bridgeAny().refreshOmpModels();
    const ws = await connect(true);
    const { sessionId, sim } = await startOmp(ws, {
      model: "claude-opus-4-7",
      thinkingLevel: "high",
      permissionMode: "plan",
      executionMode: "default",
      planMode: true,
      sandboxMode: "on",
    });
    expect(flag(sim.argv, "--model")).toBeUndefined();
    // Without a known model the level is kept; omp maps it and reports back.
    expect(flag(sim.argv, "--thinking")).toBe("high");
    expect(sim.approvalMode).toBe("always-ask");
    const tips = sent(ws)
      .filter((m) => m.subtype === "tip" && m.sessionId === sessionId)
      .map((m) => m.tipCode);
    expect(tips).toEqual(expect.arrayContaining(["omp_model_ignored", "omp_mode_mapped"]));
    expect(lastOf(ws, (m) => m.subtype === "session_created")).toMatchObject({
      planMode: false,
      executionMode: "default",
      permissionMode: "default",
    });
  });

  it("delivers the start failure after session_created with its error code", async () => {
    const ws = await connect(true);
    failNextRpcBeforeReady = "Error: model not found";
    await handle(ws, {
      type: "start",
      provider: "omp",
      projectPath: projectDir,
      requestId: "start-fail",
    });
    const created = await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    const error = await until(() =>
      lastOf(ws, (m) => m.type === "error" && m.sessionId === created.sessionId),
    );
    expect(error.errorCode).toBe("omp_start_failed");
    expect(String(error.message)).toContain("model not found");
    const messages = sent(ws);
    expect(messages.indexOf(created)).toBeLessThan(
      messages.findIndex((m) => m.type === "error" && m.sessionId === created.sessionId),
    );
  });
});

describe("omp input, queue and tool actions", () => {
  it("sends idle input as a followUp prompt and backfills the omp entry uuid", async () => {
    const ws = await connect(true);
    const { sessionId, sim } = await startOmp(ws);
    await handle(ws, { type: "input", sessionId, text: "Reply OK", clientMessageId: "c1" });

    expect(lastOf(ws, (m) => m.type === "input_ack")).toMatchObject({
      sessionId,
      clientMessageId: "c1",
      queued: false,
    });
    expect(sim.commandsOf("prompt")[0]).toMatchObject({
      message: "Reply OK",
      streamingBehavior: "followUp",
    });
    const result = await until(() =>
      lastOf(ws, (m) => m.type === "result" && m.sessionId === sessionId),
    );
    expect(result).toMatchObject({ subtype: "success", result: "OK", cost: 0.001 });
    const backfilled = await until(() =>
      lastOf(ws, (m) => m.type === "user_input" && typeof m.userMessageUuid === "string"),
    );
    expect(backfilled).toMatchObject({ text: "Reply OK", clientMessageId: "c1" });
    expect(String(backfilled.userMessageUuid)).toMatch(/^omp:entry:/);
  });

  it("queues input while omp is busy and drains it after the run", async () => {
    const ws = await connect(true);
    let firstPrompt: Frame | undefined;
    const { sessionId, sim } = await startOmp(ws);
    sim.responders.set("prompt", (command) => {
      sim.addUserEntry(String(command.message));
      if (!firstPrompt) {
        firstPrompt = command;
        sim.respond(command);
        sim.send({ type: "agent_start" });
        return MANUAL;
      }
      sim.respond(command);
      sim.reply(command, "second");
      return MANUAL;
    });
    await handle(ws, { type: "input", sessionId, text: "long run" });
    await until(() => bridgeAny().sessionManager.get(sessionId)?.status === "running");

    await handle(ws, { type: "input", sessionId, text: "next", clientMessageId: "c2" });
    expect(lastOf(ws, (m) => m.type === "input_ack")).toMatchObject({ queued: true });
    const queue = lastOf(ws, (m) => m.type === "conversation_queue")!;
    expect((queue.items as Frame[])[0]).toMatchObject({ text: "next" });
    expect(bridgeAny().sessionManager.get(sessionId).codexQueuedInput.userMessageUuid)
      .toBeUndefined();
    expect(sim.commandsOf("prompt")).toHaveLength(1);

    sim.reply(firstPrompt!, "first");
    await until(() => sim.commandsOf("prompt").length === 2);
    expect(sim.commandsOf("prompt")[1].message).toBe("next");
    const drained = sent(ws).filter((m) => m.type === "user_input" && m.text === "next");
    expect(drained[0]).toMatchObject({ clientMessageId: "c2" });
    expect(String(drained[0].userMessageUuid ?? "")).not.toMatch(/^codex:/);
  });

  /**
   * A Bridge whose gallery write waits for `release()`. An image tool result
   * is processed asynchronously (gallery write), so the previous run's later
   * messages wait behind it while omp is already idle.
   */
  function useHeldGalleryBridge(): { release: () => void } {
    bridge.close();
    const held: Array<() => void> = [];
    let released = false;
    const imageStore = {
      registerFromBase64: (_data: string, mimeType: string) => ({ id: "img-1", url: "/images/img-1", mimeType }),
      extractImagePaths: () => [],
      registerImages: async () => [],
    };
    const galleryStore = {
      addImageFromBase64: () =>
        released
          ? Promise.resolve(null)
          : new Promise((resolve) => held.push(() => resolve(null))),
      addImage: async () => null,
      metaToInfo: (meta: unknown) => meta,
    };
    bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [tempHome],
      imageStore: imageStore as never,
      galleryStore: galleryStore as never,
      deltaBatchMs: 0,
    });
    return {
      release: () => {
        released = true;
        for (const resolve of held.splice(0)) resolve();
      },
    };
  }

  /**
   * The first prompt runs until `finish()`, which ends it with an image tool
   * result and the text "FIRST DONE"; later prompts are answered `re:<text>`.
   */
  function scriptImageRun(sim: FakeOmp): { finish: () => void } {
    let firstPrompt: Frame | undefined;
    sim.responders.set("prompt", (command) => {
      sim.addUserEntry(String(command.message));
      sim.respond(command);
      if (firstPrompt) {
        sim.reply(command, `re:${String(command.message)}`);
        return MANUAL;
      }
      firstPrompt = command;
      sim.send({ type: "agent_start" });
      sim.send({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.png" } }],
          stopReason: "toolUse",
        },
      });
      sim.send({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.png" } });
      return MANUAL;
    });
    return {
      finish: () => {
        sim.send({
          type: "tool_execution_end",
          toolCallId: "t1",
          toolName: "read",
          isError: false,
          result: { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] },
        });
        sim.send({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "FIRST DONE" }], stopReason: "stop" },
        });
        sim.send({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
        sim.send({ type: "prompt_result", id: firstPrompt!.id, agentInvoked: true, status: "completed" });
      },
    };
  }

  const label = (m: Frame): string =>
    m.type === "user_input" ? `user_input:${String(m.text)}`
      : m.type === "result" ? `result:${String(m.result ?? m.subtype)}`
        : String(m.type);

  /**
   * "first" runs with "second" queued; the run ends with an image tool
   * result whose gallery write is held: omp is idle, the previous run's
   * messages and the drain of "second" still wait.
   */
  async function idleWithHeldDrain(): Promise<{
    ws: FakeSocket;
    sessionId: string;
    sim: FakeOmp;
    release: () => void;
  }> {
    const gallery = useHeldGalleryBridge();
    const ws = await connect(true);
    const { sessionId, sim } = await startOmp(ws);
    const run = scriptImageRun(sim);
    await handle(ws, { type: "input", sessionId, text: "first" });
    await until(() => bridgeAny().sessionManager.get(sessionId)?.status === "running");
    await handle(ws, { type: "input", sessionId, text: "second", clientMessageId: "c2" });
    expect(lastOf(ws, (m) => m.type === "input_ack" && m.clientMessageId === "c2")?.queued).toBe(true);
    run.finish();
    await until(() => bridgeAny().sessionManager.get(sessionId).process.isWaitingForInput);
    expect(sent(ws).some((m) => m.type === "result" && m.result === "FIRST DONE")).toBe(false);
    expect(sim.commandsOf("prompt")).toHaveLength(1);
    return { ws, sessionId, sim, release: gallery.release };
  }

  it("drains the queued item only after the previous run's messages were delivered", async () => {
    const { ws, sessionId, sim, release } = await idleWithHeldDrain();
    release();
    await until(() => sent(ws).some((m) => m.type === "result" && m.result === "re:second"), 5000);

    const live = sent(ws).filter((m) => m.sessionId === sessionId).map(label);
    expect(live.indexOf("user_input:second")).toBeGreaterThan(live.indexOf("tool_result"));
    expect(live.indexOf("user_input:second")).toBeGreaterThan(live.indexOf("result:FIRST DONE"));
    const history = (bridgeAny().sessionManager.get(sessionId).history as Frame[]).map(label);
    expect(history.indexOf("user_input:second")).toBeGreaterThan(history.indexOf("result:FIRST DONE"));
    expect(sim.commandsOf("prompt").map((command) => command.message)).toEqual(["first", "second"]);
  });

  it("drains an item steered while omp is idle only after the previous run's messages", async () => {
    const { ws, sessionId, sim, release } = await idleWithHeldDrain();
    const itemId = String((lastOf(ws, (m) => m.type === "conversation_queue")!.items as Frame[])[0].itemId);
    await handle(ws, { type: "steer_queued_input", sessionId, itemId });
    expect(lastOf(ws, (m) => m.type === "error")).toBeUndefined();
    expect(sim.commandsOf("steer")).toHaveLength(0);
    expect(sim.commandsOf("prompt")).toHaveLength(1);

    release();
    await until(() => sent(ws).some((m) => m.type === "result" && m.result === "re:second"), 5000);
    const live = sent(ws).filter((m) => m.sessionId === sessionId).map(label);
    expect(live.indexOf("user_input:second")).toBeGreaterThan(live.indexOf("result:FIRST DONE"));
    const history = (bridgeAny().sessionManager.get(sessionId).history as Frame[]).map(label);
    expect(history.indexOf("user_input:second")).toBeGreaterThan(history.indexOf("result:FIRST DONE"));
    expect(sim.commandsOf("prompt").map((command) => command.message)).toEqual(["first", "second"]);
  });

  it("rejects a new input while idle omp still holds a queued item behind earlier messages", async () => {
    const { ws, sessionId, sim, release } = await idleWithHeldDrain();
    await handle(ws, { type: "input", sessionId, text: "third", clientMessageId: "c3" });
    expect(lastOf(ws, (m) => m.clientMessageId === "c3")).toMatchObject({
      type: "input_rejected",
      reason: "Queue is full",
    });
    expect(sim.commandsOf("prompt")).toHaveLength(1);

    release();
    await until(() => sent(ws).some((m) => m.type === "result" && m.result === "re:second"), 5000);
    expect(sim.commandsOf("prompt").map((command) => command.message)).toEqual(["first", "second"]);
    const history = (bridgeAny().sessionManager.get(sessionId).history as Frame[])
      .filter((m) => m.type === "user_input")
      .map((m) => m.text);
    expect(history).toEqual(["first", "second"]);
  });

  it("rejects a new input while a pending model change delays the drain of the queued item", async () => {
    const ws = await connect(true);
    const { sessionId, sim } = await startOmp(ws);
    let firstPrompt: Frame | undefined;
    let heldThinking: Frame | undefined;
    sim.responders.set("prompt", (command) => {
      sim.addUserEntry(String(command.message));
      sim.respond(command);
      if (firstPrompt) {
        sim.reply(command, `re:${String(command.message)}`);
        return MANUAL;
      }
      firstPrompt = command;
      sim.send({ type: "agent_start" });
      return MANUAL;
    });
    sim.responders.set("set_thinking_level", (command) => {
      heldThinking = command;
      return MANUAL;
    });
    await handle(ws, { type: "input", sessionId, text: "first" });
    await until(() => bridgeAny().sessionManager.get(sessionId)?.status === "running");
    await handle(ws, { type: "input", sessionId, text: "second", clientMessageId: "c2" });
    expect(lastOf(ws, (m) => m.type === "input_ack" && m.clientMessageId === "c2")?.queued).toBe(true);
    // Deferred while busy: omp applies it when the run ends, before input_ready.
    await handle(ws, { type: "set_omp_model", sessionId, thinkingLevel: "max" });
    sim.reply(firstPrompt!, "first done");
    await until(() => heldThinking);
    expect(bridgeAny().sessionManager.get(sessionId).process.isWaitingForInput).toBe(true);

    await handle(ws, { type: "input", sessionId, text: "third", clientMessageId: "c3" });
    expect(lastOf(ws, (m) => m.clientMessageId === "c3")).toMatchObject({
      type: "input_rejected",
      reason: "Queue is full",
    });

    sim.respond(heldThinking!);
    sim.send({ type: "thinking_level_changed", thinkingLevel: "max" });
    await until(() => sent(ws).some((m) => m.type === "result" && m.result === "re:second"), 5000);
    expect(sim.commandsOf("prompt").map((command) => command.message)).toEqual(["first", "second"]);
    const history = (bridgeAny().sessionManager.get(sessionId).history as Frame[])
      .filter((m) => m.type === "user_input")
      .map((m) => m.text);
    expect(history).toEqual(["first", "second"]);
  });

  it("edits, cancels and steers the queued omp item through the queue handlers", async () => {
    const ws = await connect(true);
    const { sessionId, sim } = await startOmp(ws);
    let running: Frame | undefined;
    sim.responders.set("prompt", (command) => {
      sim.addUserEntry(String(command.message));
      sim.respond(command);
      if (!running) {
        running = command;
        sim.send({ type: "agent_start" });
      } else {
        sim.reply(command, "done");
      }
      return MANUAL;
    });
    await handle(ws, { type: "input", sessionId, text: "long run" });
    await until(() => bridgeAny().sessionManager.get(sessionId)?.status === "running");

    await handle(ws, { type: "input", sessionId, text: "first draft" });
    const itemId = String(
      (lastOf(ws, (m) => m.type === "conversation_queue")!.items as Frame[])[0].itemId,
    );
    await handle(ws, { type: "update_queued_input", sessionId, itemId, text: "edited" });
    expect((lastOf(ws, (m) => m.type === "conversation_queue")!.items as Frame[])[0]).toMatchObject({
      text: "edited",
    });
    await handle(ws, { type: "cancel_queued_input", sessionId, itemId });
    expect(lastOf(ws, (m) => m.type === "conversation_queue")!.items).toEqual([]);

    await handle(ws, { type: "input", sessionId, text: "Also PINEAPPLE" });
    const steerId = String(
      (lastOf(ws, (m) => m.type === "conversation_queue")!.items as Frame[])[0].itemId,
    );
    await handle(ws, { type: "steer_queued_input", sessionId, itemId: steerId });
    expect(sim.commandsOf("steer")[0]).toMatchObject({ message: "Also PINEAPPLE" });
    expect(lastOf(ws, (m) => m.type === "conversation_queue")!.items).toEqual([]);
    expect(
      sent(ws).filter((m) => m.type === "user_input" && m.text === "Also PINEAPPLE"),
    ).toHaveLength(1);
    // Nothing was sent as a second prompt.
    expect(sim.commandsOf("prompt")).toHaveLength(1);
    sim.reply(running!, "finished PINEAPPLE");
    await until(() => sent(ws).some((m) => m.type === "result" && m.sessionId === sessionId));
  });

  it("routes approvals to omp, keeps omp's text and appends a denial note once", async () => {
    const ws = await connect(true);
    const { sessionId, sim } = await startOmp(ws);
    // The user sent "not now" earlier; the denial note must stay a separate entry.
    await handle(ws, { type: "input", sessionId, text: "not now" });
    await until(() => sent(ws).some((m) => m.type === "result" && m.sessionId === sessionId));
    await until(() => bridgeAny().sessionManager.get(sessionId)?.process.isWaitingForInput);

    rpcPromptWithApproval(sim);
    await handle(ws, { type: "input", sessionId, text: "Run: echo bye" });
    const request = await until(() => lastOf(ws, (m) => m.type === "permission_request"));
    expect(request).toMatchObject({
      toolUseId: "call-1",
      toolName: "Bash",
      input: { command: "echo bye", approvalDetails: ["Command: echo bye"] },
    });

    await handle(ws, { type: "reject", sessionId, id: "call-1", message: "not now" });
    expect(sim.commands).toContainEqual({
      type: "extension_ui_response",
      id: "dlg-1",
      value: "Deny",
    });
    await until(() => sim.commandsOf("steer").length === 1);
    expect(sim.commandsOf("steer")[0].message).toBe("not now");
    const session = bridgeAny().sessionManager.get(sessionId);
    const notes = session.history.filter(
      (m: Frame) => m.type === "user_input" && m.text === "not now",
    );
    expect(notes).toHaveLength(2);
  });

  it("approves through omp and answers a pending approval without a match with an error", async () => {
    const ws = await connect(true);
    const { sessionId, sim } = await startOmp(ws);
    rpcPromptWithApproval(sim);
    await handle(ws, { type: "input", sessionId, text: "Run: echo bye" });
    await until(() => lastOf(ws, (m) => m.type === "permission_request"));
    await handle(ws, { type: "approve", sessionId, id: "unknown-id" });
    expect(lastOf(ws, (m) => m.type === "error")).toMatchObject({
      message: "No matching pending tool action.",
    });
    await handle(ws, { type: "approve", sessionId, id: "call-1" });
    expect(sim.commands).toContainEqual({
      type: "extension_ui_response",
      id: "dlg-1",
      value: "Approve",
    });
    expect(lastOf(ws, (m) => m.type === "permission_resolved")).toMatchObject({
      toolUseId: "call-1",
    });
  });

  it("rejects approve with clearContext, sandbox changes and fork for omp", async () => {
    const ws = await connect(true);
    const { sessionId } = await startOmp(ws);
    await handle(ws, { type: "approve", sessionId, id: "x", clearContext: true });
    expect(lastOf(ws, (m) => m.type === "error")).toMatchObject({
      errorCode: "omp_mode_unsupported",
    });
    await handle(ws, { type: "set_sandbox_mode", sessionId, sandboxMode: "on" });
    expect(lastOf(ws, (m) => m.type === "error")).toMatchObject({
      errorCode: "omp_sandbox_unsupported",
    });
    await handle(ws, { type: "fork", sessionId, targetUuid: "omp:entry:e1" });
    await until(() => lastOf(ws, (m) => m.errorCode === "fork_failed"));
  });

  it("validates and forwards set_omp_model", async () => {
    await bridgeAny().refreshOmpModels();
    const ws = await connect(true);
    const { sessionId, sim } = await startOmp(ws, { model: `baseten/${GLM.id}` });

    await handle(ws, { type: "set_omp_model", sessionId, model: "claude-opus-4-7" });
    expect(lastOf(ws, (m) => m.type === "error")).toMatchObject({
      errorCode: "set_omp_model_failed",
    });
    await handle(ws, {
      type: "set_omp_model",
      sessionId,
      model: `baseten/${MINIMAX.id}`,
      thinkingLevel: "high",
    });
    expect(lastOf(ws, (m) => m.type === "error")?.message).toContain("thinking level high");
    expect(sim.commandsOf("set_model")).toHaveLength(0);

    await handle(ws, {
      type: "set_omp_model",
      sessionId,
      model: `baseten/${MINIMAX.id}`,
      thinkingLevel: "off",
    });
    const settings = await until(() =>
      lastOf(ws, (m) => m.subtype === "omp_settings" && m.model === `baseten/${MINIMAX.id}`),
    );
    expect(settings).toMatchObject({ thinkingLevel: "off", thinkingLevels: ["off"] });
    expect(sim.commandsOf("set_model")[0]).toMatchObject({
      provider: "baseten",
      modelId: MINIMAX.id,
    });
    // omp_settings is state, not transcript.
    const history = bridgeAny().sessionManager.get(sessionId).history as Frame[];
    expect(history.some((m) => m.subtype === "omp_settings")).toBe(false);
  });

  it("rejects set_omp_model at once, without the deferred tip, when the omp child exited", async () => {
    await bridgeAny().refreshOmpModels();
    const ws = await connect(true);
    const { sessionId, sim } = await startOmp(ws, { model: `baseten/${GLM.id}` });
    sim.child.exit(1);
    await until(() => sent(ws).some((m) => m.type === "error" && m.errorCode === "omp_process_exited"));
    const before = sent(ws).length;

    await handle(ws, { type: "set_omp_model", sessionId, thinkingLevel: "max" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = sent(ws).slice(before);
    expect(after).toEqual([
      expect.objectContaining({
        type: "error",
        sessionId,
        errorCode: "set_omp_model_failed",
        message: "The omp process is not running. Resume the session to continue.",
      }),
    ]);
    expect(sim.commandsOf("set_thinking_level")).toHaveLength(0);
  });

  it("maps set_permission_mode, rejects plan/auto and respawns in the same Bridge session", async () => {
    const ws = await connect(true);
    const { sessionId, sim } = await startOmp(ws);

    await handle(ws, { type: "set_permission_mode", sessionId, mode: "plan" });
    expect(lastOf(ws, (m) => m.type === "error")).toMatchObject({
      errorCode: "omp_mode_unsupported",
    });
    await handle(ws, { type: "set_permission_mode", sessionId, mode: "auto" });
    expect(lastOf(ws, (m) => m.type === "error")).toMatchObject({
      errorCode: "omp_mode_unsupported",
    });

    // The session file exists after the first answer (omp materializes it).
    writeSessionFile({ id: String(sim.state.sessionId), cwd: projectDir, users: [] });
    sim.state = {
      ...sim.state,
      sessionFile: join(fakeStoreBucket(), `2026-09-28T18-57-12-742Z_${sim.state.sessionId}.jsonl`),
    };
    await handle(ws, {
      type: "set_permission_mode",
      sessionId,
      mode: "bypassPermissions",
      executionMode: "fullAccess",
    });
    const applied = await until(() =>
      lastOf(ws, (m) => m.subtype === "set_permission_mode" && m.sessionId === sessionId),
    );
    expect(applied).toMatchObject({
      executionMode: "fullAccess",
      permissionMode: "bypassPermissions",
    });
    const respawned = sims.at(-1)!;
    expect(respawned).not.toBe(sim);
    expect(respawned.approvalMode).toBe("yolo");
    expect(bridgeAny().sessionManager.get(sessionId)).toBeDefined();
  });

  it("answers a mode change while busy with the deferred tip", async () => {
    const ws = await connect(true);
    const { sessionId, sim } = await startOmp(ws);
    sim.responders.set("prompt", (command) => {
      sim.respond(command);
      sim.send({ type: "agent_start" });
      return MANUAL;
    });
    await handle(ws, { type: "input", sessionId, text: "long" });
    await until(() => bridgeAny().sessionManager.get(sessionId)?.status === "running");
    await handle(ws, {
      type: "set_permission_mode",
      sessionId,
      mode: "acceptEdits",
      executionMode: "acceptEdits",
    });
    expect(lastOf(ws, (m) => m.subtype === "tip")).toMatchObject({
      tipCode: "omp_change_deferred",
    });
  });

  it("sends the queue state and an omp_settings snapshot with get_history and history deltas", async () => {
    const ws = await connect(true);
    const { sessionId } = await startOmp(ws);
    ws.send.mockClear();
    await handle(ws, { type: "get_history", sessionId });
    expect(sent(ws).map((m) => `${m.type}${m.subtype ? `/${m.subtype}` : ""}`)).toEqual(
      expect.arrayContaining(["history", "system/omp_settings", "status", "conversation_queue"]),
    );
    expect(lastOf(ws, (m) => m.subtype === "omp_settings")).toMatchObject({
      sessionId,
      provider: "omp",
      model: `baseten/${GLM.id}`,
      thinkingLevel: "high",
      thinkingLevels: ["off", "high", "max"],
    });
    ws.send.mockClear();
    await handle(ws, { type: "get_history_delta", sessionId, sinceSeq: 0 });
    expect(sent(ws).map((m) => m.type)).toEqual(
      expect.arrayContaining(["history_delta", "system", "conversation_queue"]),
    );
  });

  it("awaits the omp assist for git_commit with the session model", async () => {
    const ws = await connect(true);
    const { sessionId } = await startOmp(ws);
    execGit(["init", "-q"]);
    execGit(["config", "user.email", "t@example.com"]);
    execGit(["config", "user.name", "T"]);
    writeFileSync(join(projectDir, "a.txt"), "a\n");
    execGit(["add", "a.txt"]);
    printOutput = "feat: add a";
    await handle(ws, {
      type: "git_commit",
      sessionId,
      projectPath: projectDir,
      autoGenerate: true,
      requestId: "g1",
    });
    expect(lastOf(ws, (m) => m.type === "git_commit_result")).toMatchObject({
      success: true,
      message: "feat: add a",
    });
    const printCall = spawnMock.mock.calls.find((call) => (call[1] as string[])[0] === "-p")!;
    expect(printCall[1]).toEqual(expect.arrayContaining(["--model", `baseten/${GLM.id}`]));
  });
});

function rpcPromptWithApproval(sim: FakeOmp): void {
  sim.responders.set("prompt", (command) => {
    sim.respond(command);
    sim.send({ type: "agent_start" });
    sim.send({
      type: "message_end",
      messageId: "m1",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", name: "bash", arguments: { i: "Echo", command: "echo bye" } },
        ],
        stopReason: "toolUse",
      },
    });
    sim.send({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "echo bye" },
    });
    sim.send({
      type: "extension_ui_request",
      id: "dlg-1",
      method: "select",
      title: "Allow tool: bash\nCommand: echo bye",
      options: ["Approve", "Deny"],
    });
    return MANUAL;
  });
}

function execGit(args: string[]): void {
  // Only spawn is faked; execFileSync is the real one.
  execFileSync("git", args, { cwd: projectDir });
}

describe("omp resume", () => {
  it("resumes in the recorded cwd, sends session_created after the handshake and serves past history", async () => {
    await bridgeAny().refreshOmpModels();
    const recordedCwd = join(tempHome, "recorded");
    mkdirSync(recordedCwd);
    writeSessionFile({
      id: "01a0e960-d626-7359-b8e8-44ce5c598088",
      cwd: recordedCwd,
      title: "Fix login redirect",
      users: [
        { id: "u1", text: "first" },
        { id: "u2", text: "second" },
      ],
    });
    const ws = await connect(true);
    await handle(ws, {
      type: "resume_session",
      sessionId: "01a0e960-d626-7359-b8e8-44ce5c598088",
      projectPath: recordedCwd,
      provider: "omp",
      executionMode: "acceptEdits",
      resumeRequestId: "rr-1",
    });
    const created = await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    const sim = sims[0];
    expect(flag(sim.argv, "--cwd")).toBe(recordedCwd);
    expect(flag(sim.argv, "--resume")).toMatch(/_01a0e960-d626-7359-b8e8-44ce5c598088\.jsonl$/);
    expect(sim.approvalMode).toBe("write");
    expect(sim.commandsOf("get_state").length).toBeGreaterThan(0);
    expect(created).toMatchObject({
      provider: "omp",
      claudeSessionId: "01a0e960-d626-7359-b8e8-44ce5c598088",
      executionMode: "acceptEdits",
      permissionMode: "acceptEdits",
      planMode: false,
      resumeRequestId: "rr-1",
      model: `baseten/${GLM.id}`,
    });
    expect(sent(ws).some((m) => m.subtype === "tip" && m.tipCode === "omp_cwd_missing")).toBe(false);

    const bridgeId = String(created.sessionId);
    const session = bridgeAny().sessionManager.get(bridgeId);
    expect(session.name).toBe("Fix login redirect");
    ws.send.mockClear();
    await handle(ws, { type: "get_history", sessionId: bridgeId });
    const past = lastOf(ws, (m) => m.type === "past_history")!;
    expect(past.claudeSessionId).toBe("01a0e960-d626-7359-b8e8-44ce5c598088");
    const users = (past.messages as Frame[]).filter((m) => m.role === "user");
    expect(users.map((m) => m.uuid)).toEqual(["omp:entry:u1", "omp:entry:u2"]);
  });

  it("falls back to the project path with a tip when the recorded cwd is gone", async () => {
    writeSessionFile({
      id: "omp-gone",
      cwd: join(tempHome, "deleted-dir"),
      users: [{ id: "u1", text: "hi" }],
    });
    const ws = await connect(true);
    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-gone",
      projectPath: projectDir,
      provider: "omp",
    });
    const created = await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    expect(flag(sims[0].argv, "--cwd")).toBe(projectDir);
    expect(
      sent(ws).some(
        (m) => m.subtype === "tip" && m.tipCode === "omp_cwd_missing" && m.sessionId === created.sessionId,
      ),
    ).toBe(true);
  });

  it("sanitizes the legacy app payload: no Claude model, no plan, no sandbox echo", async () => {
    await bridgeAny().refreshOmpModels();
    const fixtureMsg = JSON.parse(
      readFileSync(
        new URL("../../../test/fixtures/protocol/v1/legacy-app-omp-resume.json", import.meta.url),
        "utf8",
      ),
    ) as Frame;
    const recorded = join(tempHome, "wt");
    mkdirSync(recorded);
    writeSessionFile({
      id: String(fixtureMsg.sessionId),
      cwd: recorded,
      users: [{ id: "u1", text: "hi" }],
    });
    const ws = await connect(true);
    await handle(ws, { ...fixtureMsg, projectPath: recorded });
    const created = await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    const sim = sims[0];
    expect(flag(sim.argv, "--model")).toBeUndefined();
    expect(sim.approvalMode).toBe("always-ask");
    expect(created).toMatchObject({ planMode: false, executionMode: "default", permissionMode: "default" });
    expect(created).not.toHaveProperty("sandboxMode");
    const tips = sent(ws).filter((m) => m.subtype === "tip").map((m) => m.tipCode);
    expect(tips).toEqual(expect.arrayContaining(["omp_model_ignored", "omp_mode_mapped"]));
  });

  it("fails the resume with the start error code, destroys the session and does not replay it", async () => {
    writeSessionFile({ id: "omp-broken", cwd: projectDir, users: [{ id: "u1", text: "x" }] });
    const ws = await connect(true);
    failNextRpcBeforeReady = "boom";
    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-broken",
      projectPath: projectDir,
      provider: "omp",
      resumeRequestId: "rr-2",
    });
    const failed = await until(() => lastOf(ws, (m) => m.subtype === "session_resume_failed"));
    expect(failed).toMatchObject({ provider: "omp", sourceSessionId: "omp-broken" });
    expect(lastOf(ws, (m) => m.type === "error")).toMatchObject({
      errorCode: "omp_start_failed",
      requestId: "rr-2",
    });
    expect(sent(ws).some((m) => m.subtype === "session_created")).toBe(false);
    expect(bridgeAny().sessionManager.list()).toHaveLength(0);

    // A retry starts a new attempt instead of replaying the failure.
    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-broken",
      projectPath: projectDir,
      provider: "omp",
      resumeRequestId: "rr-2",
    });
    await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    expect(sims).toHaveLength(1);
  });

  it("fails a resume whose omp child never becomes ready and destroys the session", async () => {
    writeSessionFile({ id: "omp-silent", cwd: projectDir, users: [{ id: "u1", text: "x" }] });
    const ws = await connect(true);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      silentNextRpc = true;
      const resuming = handle(ws, {
        type: "resume_session",
        sessionId: "omp-silent",
        projectPath: projectDir,
        provider: "omp",
        resumeRequestId: "rr-silent",
      });
      const silent = await until(() => silentChildren[0]);
      expect(sent(ws).some((m) => m.subtype === "session_created")).toBe(false);
      // omp's ready timeout (§2.4 step 3) is 60 s.
      await vi.advanceTimersByTimeAsync(60_000);
      await resuming;
      expect(lastOf(ws, (m) => m.subtype === "session_resume_failed")).toMatchObject({
        provider: "omp",
        sourceSessionId: "omp-silent",
        resumeRequestId: "rr-silent",
      });
      expect(lastOf(ws, (m) => m.type === "error")).toMatchObject({
        errorCode: "omp_start_failed",
        requestId: "rr-silent",
      });
      expect(sent(ws).some((m) => m.subtype === "session_created")).toBe(false);
      expect(bridgeAny().sessionManager.list()).toHaveLength(0);
      await until(() => silent.exited);
    } finally {
      vi.useRealTimers();
    }

    // The failure is not replayed: the same request starts a new attempt.
    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-silent",
      projectPath: projectDir,
      provider: "omp",
      resumeRequestId: "rr-silent",
    });
    await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    expect(sims).toHaveLength(1);
  });

  it("replaces a Bridge session whose omp child exited instead of attaching to it", async () => {
    writeSessionFile({ id: "omp-crashed", cwd: projectDir, users: [{ id: "u1", text: "x" }] });
    const ws = await connect(true);
    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-crashed",
      projectPath: projectDir,
      provider: "omp",
      resumeRequestId: "first",
    });
    const first = await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    sims[0].child.exit(1);
    await until(() => sent(ws).some((m) => m.type === "error" && m.errorCode === "omp_process_exited"));

    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-crashed",
      projectPath: projectDir,
      provider: "omp",
      resumeRequestId: "second",
    });
    const second = await until(() =>
      lastOf(ws, (m) => m.subtype === "session_created" && m.resumeRequestId === "second"),
    );
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(sims).toHaveLength(2);
    expect(flag(sims[1].argv, "--resume")).toMatch(/_omp-crashed\.jsonl$/);
    expect(bridgeAny().sessionManager.list().map((s: Frame) => s.id)).toEqual([second.sessionId]);

    await handle(ws, { type: "input", sessionId: String(second.sessionId), text: "hello" });
    expect(lastOf(ws, (m) => m.type === "input_ack")).toMatchObject({ queued: false });
    await until(() => sims[1].commandsOf("prompt").length === 1);
  });

  it("resolves a link to an omp session whose child exited to its recent entry", async () => {
    writeSessionFile({ id: "omp-link-crashed", cwd: projectDir, users: [{ id: "u1", text: "x" }] });
    const ws = await connect(true);
    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-link-crashed",
      projectPath: projectDir,
      provider: "omp",
    });
    const created = await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    const bridgeId = String(created.sessionId);
    const { sessionId: unsavedId } = await startOmp(ws);
    sims[0].child.exit(1);
    sims[1].child.exit(1);
    await until(() => sent(ws).filter((m) => m.errorCode === "omp_process_exited").length === 2);

    // A local notification carries the Bridge id, a push the omp id.
    for (const [requestId, sessionId, provider] of [
      ["by-bridge-id", bridgeId, "claude"],
      ["by-omp-id", "omp-link-crashed", "omp"],
    ]) {
      await handle(ws, { type: "resolve_session_link", requestId, sessionId, provider });
      const resolution = await until(() =>
        lastOf(ws, (m) => m.type === "session_link_resolution" && m.requestId === requestId),
      );
      expect(resolution).toMatchObject({
        sourceSessionId: sessionId,
        status: "recent",
        provider: "omp",
        recentSession: { sessionId: "omp-link-crashed", provider: "omp" },
      });
    }

    // Nothing to resume from yet: the exited session opens as before.
    await handle(ws, { type: "resolve_session_link", requestId: "unsaved", sessionId: unsavedId, provider: "claude" });
    expect(
      await until(() => lastOf(ws, (m) => m.type === "session_link_resolution" && m.requestId === "unsaved")),
    ).toMatchObject({ status: "live", bridgeSessionId: unsavedId, provider: "omp" });
  });

  it("answers omp_session_not_found for an unknown id", async () => {
    const ws = await connect(true);
    await handle(ws, {
      type: "resume_session",
      sessionId: "does-not-exist",
      projectPath: projectDir,
      provider: "omp",
    });
    await until(() => lastOf(ws, (m) => m.subtype === "session_resume_failed"));
    expect(lastOf(ws, (m) => m.type === "error")).toMatchObject({
      errorCode: "omp_session_not_found",
    });
  });

  it("attaches a plain resume to the live session and refuses an edited one", async () => {
    writeSessionFile({ id: "omp-live", cwd: projectDir, users: [{ id: "u1", text: "x" }] });
    const ws = await connect(true);
    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-live",
      projectPath: projectDir,
      provider: "omp",
      executionMode: "default",
      resumeRequestId: "a",
    });
    const first = await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-live",
      projectPath: projectDir,
      provider: "omp",
      executionMode: "default",
      resumeRequestId: "b",
    });
    const attached = await until(() =>
      lastOf(ws, (m) => m.subtype === "session_created" && m.resumeRequestId === "b"),
    );
    expect(attached.sessionId).toBe(first.sessionId);
    expect(sims).toHaveLength(1);

    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-live",
      projectPath: projectDir,
      provider: "omp",
      executionMode: "fullAccess",
      resumeRequestId: "c",
    });
    await until(() => lastOf(ws, (m) => m.subtype === "session_resume_failed"));
    expect(lastOf(ws, (m) => m.type === "error")).toMatchObject({
      errorCode: "omp_session_already_open",
    });
  });

  it("attaches a resume that repeats the live session's model and thinking level", async () => {
    await bridgeAny().refreshOmpModels();
    writeSessionFile({ id: "omp-same", cwd: projectDir, users: [{ id: "u1", text: "x" }] });
    const ws = await connect(true);
    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-same",
      projectPath: projectDir,
      provider: "omp",
      executionMode: "default",
      resumeRequestId: "a",
    });
    const first = await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    expect(first).toMatchObject({ model: `baseten/${GLM.id}`, thinkingLevel: "high" });

    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-same",
      projectPath: projectDir,
      provider: "omp",
      executionMode: "default",
      model: `baseten/${GLM.id}`,
      thinkingLevel: "high",
      resumeRequestId: "same",
    });
    const attached = await until(() =>
      lastOf(ws, (m) => m.subtype === "session_created" && m.resumeRequestId === "same"),
    );
    expect(attached.sessionId).toBe(first.sessionId);
    expect(sims).toHaveLength(1);

    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-same",
      projectPath: projectDir,
      provider: "omp",
      executionMode: "default",
      thinkingLevel: "max",
      resumeRequestId: "other",
    });
    await until(() => lastOf(ws, (m) => m.subtype === "session_resume_failed"));
    expect(lastOf(ws, (m) => m.type === "error")).toMatchObject({
      errorCode: "omp_session_already_open",
    });
  });

  it("waits for the previous child to exit before resuming a stopped session", async () => {
    writeSessionFile({ id: "omp-dispose", cwd: projectDir, users: [{ id: "u1", text: "x" }] });
    const ws = await connect(true);
    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-dispose",
      projectPath: projectDir,
      provider: "omp",
    });
    const created = await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    const first = sims[0];
    first.holdExit = true;
    await handle(ws, { type: "stop_session", sessionId: String(created.sessionId) });

    const resuming = handle(ws, {
      type: "resume_session",
      sessionId: "omp-dispose",
      projectPath: projectDir,
      provider: "omp",
      resumeRequestId: "again",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sims).toHaveLength(1);
    first.child.exit(0);
    await resuming;
    await until(() => lastOf(ws, (m) => m.subtype === "session_created" && m.resumeRequestId === "again"));
    expect(sims).toHaveLength(2);
  });

  it("keeps the timestamp of a past tool result", async () => {
    const file = writeSessionFile({ id: "omp-tool-time", cwd: projectDir, users: [{ id: "u1", text: "Run: echo hi" }] });
    const toolLines = [
      {
        type: "message",
        id: "a-call",
        parentId: "a0",
        timestamp: "2026-09-28T18:58:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" } }],
          provider: "baseten",
          model: GLM.id,
          stopReason: "toolUse",
        },
      },
      {
        type: "message",
        id: "r-call",
        parentId: "a-call",
        timestamp: "2026-09-28T18:59:19.125Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "hi" }],
        },
      },
    ];
    writeFileSync(file, `${readFileSync(file, "utf8")}${toolLines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const ws = await connect(true);
    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-tool-time",
      projectPath: projectDir,
      provider: "omp",
    });
    const created = await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    await handle(ws, { type: "get_history", sessionId: String(created.sessionId) });
    const past = await until(() => lastOf(ws, (m) => m.type === "past_history"));
    const result = (past.messages as Frame[]).find((m) => m.role === "tool_result");
    expect(result).toMatchObject({ toolUseId: "call-1", timestamp: "2026-09-28T18:59:19.125Z" });
  });

  it("registers blob images for past history without sending omp references", async () => {
    const hash = "a".repeat(64);
    mkdirSync(join(tempHome, "omp-agent", "blobs"), { recursive: true });
    writeFileSync(join(tempHome, "omp-agent", "blobs", hash), Buffer.from("png-bytes"));
    writeSessionFile({
      id: "omp-images",
      cwd: projectDir,
      users: [
        {
          id: "u1",
          text: "look",
          images: [{ data: `blob:sha256:${hash}`, mimeType: "image/png" }],
        },
      ],
    });
    const registerFromBase64 = vi.fn(() => ({ id: "img-1", url: "/images/img-1", mimeType: "image/png" }));
    bridgeAny().imageStore = { registerFromBase64, registerImages: vi.fn(async () => []), extractImagePaths: () => [] };
    const ws = await connect(true);
    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-images",
      projectPath: projectDir,
      provider: "omp",
    });
    const created = await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    await handle(ws, { type: "get_history", sessionId: String(created.sessionId) });
    const past = lastOf(ws, (m) => m.type === "past_history")!;
    const user = (past.messages as Frame[]).find((m) => m.role === "user")!;
    expect(user).not.toHaveProperty("ompImages");
    expect(user).not.toHaveProperty("imageBase64");
    expect(user.images).toEqual([{ id: "img-1", url: "/images/img-1", mimeType: "image/png" }]);
    expect(registerFromBase64).toHaveBeenCalledWith(
      Buffer.from("png-bytes").toString("base64"),
      "image/png",
    );
  });
});

describe("omp recent sessions, rename and archive", () => {
  it("lists omp sessions for provider omp and in a providers list", async () => {
    writeSessionFile({ id: "omp-r1", cwd: projectDir, title: "Named", users: [{ id: "u1", text: "hi" }] });
    const ws = await connect(true);
    await handle(ws, { type: "list_recent_sessions", provider: "omp", requestId: "l1" });
    const listed = await until(() => lastOf(ws, (m) => m.type === "recent_sessions" && m.requestId === "l1"));
    expect(listed.sessions).toEqual([
      expect.objectContaining({
        sessionId: "omp-r1",
        provider: "omp",
        name: "Named",
        firstPrompt: "hi",
        workspace: { kind: "unassigned", rootPaths: [projectDir] },
      }),
    ]);
    // Only the omp loader ran: no Codex app-server process was spawned.
    expect(spawnMock.mock.calls.some((call) => call[0] === "codex")).toBe(false);

    await handle(ws, {
      type: "list_recent_sessions",
      providers: ["claude", "omp"],
      requestId: "l2",
    });
    const both = await until(() => lastOf(ws, (m) => m.type === "recent_sessions" && m.requestId === "l2"));
    expect((both.sessions as Frame[]).map((s) => s.sessionId)).toEqual(["omp-r1"]);
  });

  it("renames a running omp session through its process and refuses to clear the name", async () => {
    const ws = await connect(true);
    const { sessionId, sim } = await startOmp(ws);
    await handle(ws, { type: "rename_session", sessionId, name: "Fix login" });
    expect(sim.commandsOf("set_session_name")[0]).toMatchObject({ name: "Fix login" });
    expect(lastOf(ws, (m) => m.type === "rename_result")).toMatchObject({
      sessionId,
      name: "Fix login",
      success: true,
    });
    await handle(ws, { type: "rename_session", sessionId });
    expect(lastOf(ws, (m) => m.type === "rename_result")).toMatchObject({
      success: false,
      error: "omp session names cannot be cleared",
    });
  });

  it("sends a recent-list rename of a live session to the live process", async () => {
    writeSessionFile({ id: "omp-rename-live", cwd: projectDir, users: [{ id: "u1", text: "x" }] });
    const ws = await connect(true);
    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-rename-live",
      projectPath: projectDir,
      provider: "omp",
    });
    await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    await handle(ws, {
      type: "rename_session",
      sessionId: "omp-rename-live",
      provider: "omp",
      providerSessionId: "omp-rename-live",
      projectPath: projectDir,
      name: "Renamed",
    });
    expect(sims).toHaveLength(1);
    expect(sims[0].commandsOf("set_session_name")[0]).toMatchObject({ name: "Renamed" });
    expect(lastOf(ws, (m) => m.type === "rename_result")).toMatchObject({ success: true });
  });

  it("renames a stopped omp session through a short-lived rpc process", async () => {
    writeSessionFile({ id: "omp-rename-stopped", cwd: projectDir, users: [{ id: "u1", text: "x" }] });
    const ws = await connect(true);
    await handle(ws, {
      type: "rename_session",
      sessionId: "omp-rename-stopped",
      provider: "omp",
      providerSessionId: "omp-rename-stopped",
      projectPath: projectDir,
      name: "Stopped name",
    });
    expect(sims).toHaveLength(1);
    expect(flag(sims[0].argv, "--mode")).toBe("rpc");
    expect(sims[0].argv).toEqual(expect.arrayContaining(["--no-extensions", "--resume"]));
    expect(sims[0].commandsOf("set_session_name")[0]).toMatchObject({ name: "Stopped name" });
    expect(lastOf(ws, (m) => m.type === "rename_result")).toMatchObject({ success: true });
  });

  it("renames a session whose omp child exited through a short-lived rpc process", async () => {
    writeSessionFile({ id: "omp-crashed-name", cwd: projectDir, users: [{ id: "u1", text: "x" }] });
    const ws = await connect(true);
    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-crashed-name",
      projectPath: projectDir,
      provider: "omp",
    });
    const created = await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    const bridgeId = String(created.sessionId);
    sims[0].child.exit(1);
    await until(() => sent(ws).some((m) => m.type === "error" && m.errorCode === "omp_process_exited"));

    // By Bridge id (the chat screen) ...
    await handle(ws, { type: "rename_session", sessionId: bridgeId, name: "After crash" });
    expect(lastOf(ws, (m) => m.type === "rename_result")).toMatchObject({
      sessionId: bridgeId,
      success: true,
    });
    expect(sims).toHaveLength(2);
    expect(flag(sims[1].argv, "--mode")).toBe("rpc");
    expect(sims[1].commandsOf("set_session_name")[0]).toMatchObject({ name: "After crash" });
    expect(bridgeAny().sessionManager.get(bridgeId).name).toBe("After crash");

    // ... and from the recent list.
    await handle(ws, {
      type: "rename_session",
      sessionId: "omp-crashed-name",
      provider: "omp",
      providerSessionId: "omp-crashed-name",
      projectPath: projectDir,
      name: "From recent",
    });
    expect(lastOf(ws, (m) => m.type === "rename_result")).toMatchObject({ success: true });
    expect(sims).toHaveLength(3);
    expect(sims[2].commandsOf("set_session_name")[0]).toMatchObject({ name: "From recent" });
    expect(bridgeAny().sessionManager.get(bridgeId).name).toBe("From recent");
  });

  it("writes the auto-rename name to the file when the session stopped while omp -p ran", async () => {
    const file = writeSessionFile({ id: "omp-new-1", cwd: projectDir, users: [{ id: "u1", text: "x" }] });
    rpcBehaviour = (sim) => {
      sim.state = { ...sim.state, sessionFile: file };
    };
    const original = spawnMock.getMockImplementation()!;
    let printStarted = false;
    spawnMock.mockImplementation((command: string, argv: string[], options: { cwd: string }) => {
      if (argv[0] !== "-p") return original(command, argv, options);
      printStarted = true;
      const child = new FakeChild();
      setTimeout(() => {
        child.stdout.emit("data", "Deploy pipeline fix\n");
        child.exit(0);
      }, 150);
      return child;
    });
    const ws = await connect(true);
    const { sessionId, sim } = await startOmp(ws, { autoRename: true });
    await handle(ws, { type: "input", sessionId, text: "Fix the deploy pipeline" });
    await until(() => lastOf(ws, (m) => m.type === "result" && m.sessionId === sessionId));
    await until(() => printStarted);
    await handle(ws, { type: "stop_session", sessionId });

    const helper = await until(() => sims[1]);
    expect(flag(helper.argv, "--mode")).toBe("rpc");
    expect(flag(helper.argv, "--resume")).toBe(file);
    await until(() => helper.commandsOf("set_session_name").length > 0);
    expect(helper.commandsOf("set_session_name")[0]).toMatchObject({ name: "Deploy pipeline fix" });
    expect(sim.commandsOf("set_session_name")).toHaveLength(0);
  });

  it("archives an omp session with the Bridge marker only", async () => {
    writeSessionFile({ id: "omp-archive", cwd: projectDir, users: [{ id: "u1", text: "x" }] });
    const ws = await connect(true);
    // The Bridge initializes its archive store in the background; use one
    // whose load has finished so the marker cannot be overwritten by it.
    const archiveStore = new ArchiveStore();
    await archiveStore.init();
    bridgeAny().archiveStore = archiveStore;
    await handle(ws, {
      type: "archive_session",
      sessionId: "omp-archive",
      provider: "omp",
      projectPath: projectDir,
    });
    await until(() => lastOf(ws, (m) => m.type === "archive_result"));
    expect(lastOf(ws, (m) => m.type === "archive_result")).toMatchObject({ success: true });
    await handle(ws, { type: "list_recent_sessions", provider: "omp", requestId: "after" });
    const listed = await until(() => lastOf(ws, (m) => m.type === "recent_sessions" && m.requestId === "after"));
    expect(listed.sessions).toEqual([]);
    expect(sims).toHaveLength(0);
  });
});

describe("omp rewind", () => {
  async function resumeWithHistory(ws: FakeSocket): Promise<{ sessionId: string; sim: FakeOmp; file: string }> {
    const file = writeSessionFile({
      id: "omp-rewind",
      cwd: projectDir,
      title: "Rewind me",
      users: [
        { id: "u1", text: "first" },
        { id: "u2", text: "second" },
      ],
    });
    await handle(ws, {
      type: "resume_session",
      sessionId: "omp-rewind",
      projectPath: projectDir,
      provider: "omp",
    });
    const created = await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    return { sessionId: String(created.sessionId), sim: sims[0], file };
  }

  it("supports only conversation rewind", async () => {
    const ws = await connect(true);
    const { sessionId } = await resumeWithHistory(ws);
    await handle(ws, { type: "rewind", sessionId, targetUuid: "omp:entry:u2", mode: "code" });
    await until(() => lastOf(ws, (m) => m.type === "rewind_result"));
    expect(lastOf(ws, (m) => m.type === "rewind_result")).toMatchObject({
      success: false,
      error: "omp only supports conversation rewind",
    });
    await handle(ws, { type: "rewind_dry_run", sessionId, targetUuid: "omp:entry:u2" });
    expect(lastOf(ws, (m) => m.type === "rewind_preview")).toMatchObject({
      canRewind: false,
      error: "omp only supports conversation rewind",
    });
  });

  /** A refused rewind answers success:false and leaves the session as it was. */
  async function expectRewindRefused(
    ws: FakeSocket,
    sessionId: string,
    sim: FakeOmp,
    error: string,
  ): Promise<void> {
    const from = sent(ws).length;
    const children = sims.length;
    await handle(ws, { type: "rewind", sessionId, targetUuid: "omp:entry:u2", mode: "conversation" });
    const result = await until(() => sent(ws).slice(from).find((m) => m.type === "rewind_result"));
    expect(result).toMatchObject({ success: false, mode: "conversation", error });
    expect(sim.commandsOf("branch")).toHaveLength(0);
    expect(sims).toHaveLength(children);
    expect(sent(ws).slice(from).some((m) => m.subtype === "session_created")).toBe(false);
    expect(bridgeAny().sessionManager.get(sessionId)).toBeDefined();
  }

  it("refuses a rewind while omp is running", async () => {
    const ws = await connect(true);
    const { sessionId, sim } = await resumeWithHistory(ws);
    sim.responders.set("prompt", (command) => {
      sim.respond(command);
      sim.send({ type: "agent_start" });
      return MANUAL;
    });
    await handle(ws, { type: "input", sessionId, text: "long run" });
    await until(() => bridgeAny().sessionManager.get(sessionId)?.status === "running");
    await expectRewindRefused(ws, sessionId, sim, "Cannot rewind while omp is running");
  });

  it("refuses a rewind while an approval is open", async () => {
    const ws = await connect(true);
    const { sessionId, sim } = await resumeWithHistory(ws);
    rpcPromptWithApproval(sim);
    await handle(ws, { type: "input", sessionId, text: "Run: echo bye" });
    await until(() => lastOf(ws, (m) => m.type === "permission_request"));
    await expectRewindRefused(ws, sessionId, sim, "Cannot rewind while omp is running");
  });

  it("refuses a rewind while idle omp still has queued input", async () => {
    const ws = await connect(true);
    const { sessionId, sim } = await resumeWithHistory(ws);
    let firstPrompt: Frame | undefined;
    let heldThinking: Frame | undefined;
    sim.responders.set("prompt", (command) => {
      sim.respond(command);
      firstPrompt = command;
      sim.send({ type: "agent_start" });
      return MANUAL;
    });
    // A model change deferred to the end of the run keeps the queued item
    // waiting for its drain while omp is already idle.
    sim.responders.set("set_thinking_level", (command) => {
      heldThinking = command;
      return MANUAL;
    });
    await handle(ws, { type: "input", sessionId, text: "long run" });
    await until(() => bridgeAny().sessionManager.get(sessionId)?.status === "running");
    await handle(ws, { type: "input", sessionId, text: "queued" });
    expect((lastOf(ws, (m) => m.type === "conversation_queue")!.items as Frame[])).toHaveLength(1);
    await handle(ws, { type: "set_omp_model", sessionId, thinkingLevel: "max" });
    sim.reply(firstPrompt!, "done");
    await until(() => heldThinking);
    expect(bridgeAny().sessionManager.get(sessionId).process.isWaitingForInput).toBe(true);
    await expectRewindRefused(ws, sessionId, sim, "Cannot rewind while omp has queued input");
  });

  it("refuses a rewind after the omp child exited", async () => {
    const ws = await connect(true);
    const { sessionId, sim } = await resumeWithHistory(ws);
    sim.child.exit(1);
    await until(() => sent(ws).some((m) => m.type === "error" && m.errorCode === "omp_process_exited"));
    await expectRewindRefused(ws, sessionId, sim, "The omp process is not running");
  });

  it("refuses an invalid target without side effects", async () => {
    const ws = await connect(true);
    const { sessionId, sim } = await resumeWithHistory(ws);
    await handle(ws, { type: "rewind", sessionId, targetUuid: "omp:entry:a0", mode: "conversation" });
    await until(() => lastOf(ws, (m) => m.type === "rewind_result"));
    expect(lastOf(ws, (m) => m.type === "rewind_result")).toMatchObject({
      success: false,
      error: "Invalid omp rewind target",
    });
    expect(sim.commandsOf("branch")).toHaveLength(0);
    expect(bridgeAny().sessionManager.get(sessionId)).toBeDefined();
  });

  it("keeps the session when omp refuses the branch", async () => {
    const ws = await connect(true);
    const { sessionId, sim } = await resumeWithHistory(ws);
    sim.responders.set("branch", (command) => {
      sim.fail(command, "Entry not found");
      return MANUAL;
    });
    await handle(ws, { type: "rewind", sessionId, targetUuid: "omp:entry:u2", mode: "conversation" });
    await until(() => lastOf(ws, (m) => m.type === "rewind_result"));
    expect(lastOf(ws, (m) => m.type === "rewind_result")).toMatchObject({
      success: false,
      error: "Entry not found",
    });
    expect(bridgeAny().sessionManager.get(sessionId)).toBeDefined();
  });

  it("branches in the running process and opens a new Bridge session on the branched file", async () => {
    const ws = await connect(true);
    const { sessionId, sim } = await resumeWithHistory(ws);
    bridgeAny().pendingSessionWorkspaces.set(sessionId, {
      kind: "project",
      projectId: "p1",
      projectName: "Project",
      rootPaths: [projectDir],
    });
    sim.responders.set("branch", (command) => {
      const branched = writeSessionFile({
        id: "omp-branched",
        cwd: projectDir,
        title: "Rewind me",
        users: [{ id: "u1", text: "first" }],
      });
      sim.state = { ...sim.state, sessionId: "omp-branched", sessionFile: branched };
      expect(command.entryId).toBe("u2");
      return { cancelled: false };
    });
    await handle(ws, { type: "rewind", sessionId, targetUuid: "omp:entry:u2", mode: "conversation" });
    const result = await until(() => lastOf(ws, (m) => m.type === "rewind_result"));
    expect(result).toMatchObject({ success: true, mode: "conversation" });
    const created = lastOf(ws, (m) => m.subtype === "session_created" && m.sourceSessionId === sessionId)!;
    expect(created).toMatchObject({ provider: "omp", claudeSessionId: "omp-branched" });
    expect(bridgeAny().sessionManager.get(sessionId)).toBeUndefined();
    const reopened = sims.at(-1)!;
    expect(flag(reopened.argv, "--resume")).toMatch(/_omp-branched\.jsonl$/);
    const newSession = bridgeAny().sessionManager.get(String(created.sessionId));
    expect(newSession.name).toBe("Rewind me");
    expect(bridgeAny().workspaceForRuntimeSession(newSession)).toMatchObject({ projectId: "p1" });
  });

  it("answers success:false when the rewound session cannot be reopened", async () => {
    const ws = await connect(true);
    const { sessionId, sim } = await resumeWithHistory(ws);
    sim.responders.set("branch", () => {
      const branched = writeSessionFile({
        id: "omp-branched-2",
        cwd: projectDir,
        users: [{ id: "u1", text: "first" }],
      });
      sim.state = { ...sim.state, sessionId: "omp-branched-2", sessionFile: branched };
      failNextRpcBeforeReady = "cannot start";
      return { cancelled: false };
    });
    await handle(ws, { type: "rewind", sessionId, targetUuid: "omp:entry:u2", mode: "conversation" });
    const result = await until(() => lastOf(ws, (m) => m.type === "rewind_result"));
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("omp could not reopen the rewound session");
  });
});

describe("omp fixtures", () => {
  function fixtures(name: string): Frame[] {
    const value = JSON.parse(
      readFileSync(
        new URL(`../../../test/fixtures/protocol/v1/${name}.json`, import.meta.url),
        "utf8",
      ),
    ) as Frame | Frame[];
    return Array.isArray(value) ? value : [value];
  }

  it("builds session_created, init and omp_settings as the protocol fixtures describe", async () => {
    await bridgeAny().refreshOmpModels();
    const ws = await connect(true);
    const { sessionId } = await startOmp(ws, {
      executionMode: "acceptEdits",
      permissionMode: "acceptEdits",
      model: `baseten/${GLM.id}`,
      thinkingLevel: "high",
    });
    // Fixture ids and paths describe their own state; compare the rest.
    const [startCreated] = fixtures("omp-session-created");
    expect(lastOf(ws, (m) => m.subtype === "session_created")).toMatchObject({
      ...startCreated,
      sessionId,
      projectPath: projectDir,
      requestId: "start-0",
    });

    const [init] = fixtures("omp-init");
    const { historySeq: _historySeq, ...liveInit } = lastOf(ws, (m) => m.subtype === "init")!;
    expect(liveInit).toEqual({ ...init, sessionId });

    await handle(ws, {
      type: "set_omp_model",
      sessionId,
      model: `baseten/${MINIMAX.id}`,
      thinkingLevel: "off",
    });
    const [settings] = fixtures("omp-settings");
    expect(
      await until(() =>
        lastOf(ws, (m) => m.subtype === "omp_settings" && m.model === settings.model),
      ),
    ).toEqual({ ...settings, sessionId });
    // The --config overlay was written under the (temp) home.
    expect(existsSync(join(tempHome, ".ccpocket", "omp-rpc-overlay.yml"))).toBe(true);
  });

  it("builds the omp-session-list.json session entry for the same running session", async () => {
    await bridgeAny().refreshOmpModels();
    const [expected] = fixtures("omp-session-list");
    const [fixtureSession] = expected.sessions as Frame[];
    execGit(["init", "-q", "-b", String(fixtureSession.gitBranch)]);
    execGit(["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init"]);
    writeSessionFile({
      id: String(fixtureSession.claudeSessionId),
      cwd: projectDir,
      title: String(fixtureSession.name),
      users: [{ id: "u1", text: "Fix the login redirect" }],
    });
    const ws = await connect(true);
    await handle(ws, {
      type: "resume_session",
      sessionId: String(fixtureSession.claudeSessionId),
      projectPath: projectDir,
      provider: "omp",
      executionMode: String(fixtureSession.executionMode),
    });
    const created = await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    const sessionId = String(created.sessionId);
    const sim = sims[0];
    sim.responders.set("prompt", (command) => {
      sim.addUserEntry(String(command.message));
      sim.respond(command);
      sim.reply(command, String(fixtureSession.lastMessage));
      return MANUAL;
    });
    await handle(ws, { type: "input", sessionId, text: "Keep the query string" });
    await until(() => sent(ws).some((m) => m.type === "result" && m.sessionId === sessionId));
    await waitIdle(ws, sessionId);

    ws.send.mockClear();
    bridgeAny().sendSessionList(ws);
    const list = lastOf(ws, (m) => m.type === "session_list")!;
    const built = (list.sessions as Frame[]).map((session) => ({
      ...session,
      // Instance-specific values of the fixture's own state.
      id: fixtureSession.id,
      projectPath: fixtureSession.projectPath,
      createdAt: fixtureSession.createdAt,
      lastActivityAt: fixtureSession.lastActivityAt,
    }));
    expect(built).toEqual(expected.sessions);
    // The omp fields of the list; Codex metadata travels next to them.
    const { sessions: _sessions, ...ompFields } = expected;
    expect(list).toMatchObject(ompFields);
    expect(list.ompModels).toEqual(expected.ompModels);
  });

  it("builds the resume session_created as the fixture describes", async () => {
    await bridgeAny().refreshOmpModels();
    const [, resumeCreated] = fixtures("omp-session-created");
    const worktreeCwd = join(tempHome, "project-worktrees", "fix-login");
    mkdirSync(worktreeCwd, { recursive: true });
    writeSessionFile({
      id: String(resumeCreated.claudeSessionId),
      cwd: worktreeCwd,
      users: [{ id: "u1", text: "Fix the login redirect" }],
    });
    const [resume] = fixtures("omp-resume");
    const ws = await connect(true);
    await handle(ws, { ...resume, projectPath: worktreeCwd });
    const created = await until(() => lastOf(ws, (m) => m.subtype === "session_created"));
    expect(created).toMatchObject({
      ...resumeCreated,
      sessionId: created.sessionId,
      projectPath: worktreeCwd,
    });
  });
});
