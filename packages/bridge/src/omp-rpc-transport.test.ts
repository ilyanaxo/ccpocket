import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, fakeChildren } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  fakeChildren: [] as FakeChildProcess[],
}));

class FakeWritable extends EventEmitter {
  public writes: string[] = [];
  public ended = false;
  /** Node v24: write() after end() returns false and the line is lost. */
  write(chunk: string): boolean {
    if (this.ended) return false;
    this.writes.push(chunk);
    this.emit("write", chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
}

class FakeReadable extends EventEmitter {
  public destroyed = false;
  setEncoding(_encoding: string): void {}
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeChildProcess extends EventEmitter {
  public stdout = new FakeReadable();
  public stderr = new FakeReadable();
  public stdin = new FakeWritable();
  public pid: number | undefined = 4242;
  public signals: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
  commands(): Array<Record<string, unknown>> {
    return this.stdin.writes.map((line) => JSON.parse(line));
  }
  send(frame: unknown): void {
    this.stdout.emit("data", `${JSON.stringify(frame)}\n`);
  }
  /** Node order: `exit`, then `close` once stdio is drained. */
  exit(code: number | null): void {
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
  OMP_BREADCRUMB_ENV_VARS,
  OMP_RPC_OVERLAY_CONTENT,
  resolveOmpBin,
  resolveOmpStore,
  sanitizedOmpEnv,
  writeOmpRpcOverlay,
} from "./omp-env.js";
import {
  buildOmpRpcArgs,
  buildOmpSpawnSpec,
  OmpRpcTransport,
  type OmpSpawnSpec,
} from "./omp-rpc-transport.js";

// OBSERVED P1
const READY = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
};

const SPEC: OmpSpawnSpec = {
  command: "omp",
  args: ["--mode", "rpc-ui"],
  options: { cwd: "/proj", stdio: "pipe", env: {} },
};

function startTransport(
  options: ConstructorParameters<typeof OmpRpcTransport>[0] = {},
  spec: OmpSpawnSpec = SPEC,
) {
  const transport = new OmpRpcTransport(options);
  const frames: Array<Record<string, unknown>> = [];
  transport.on("frame", (frame) => frames.push(frame));
  transport.start(spec);
  return { transport, child: fakeChildren.at(-1)!, frames };
}

async function negotiate(child: FakeChildProcess): Promise<void> {
  child.send(READY);
  const [negotiation] = child.commands();
  expect(negotiation).toEqual({ id: "b1", type: "negotiate_protocol", protocolVersion: 2 });
  child.send({
    id: negotiation.id,
    type: "response",
    command: "negotiate_protocol",
    success: true,
    data: { protocolVersion: 2 },
  });
  await Promise.resolve();
  await Promise.resolve();
}

function chunkFrames(object: unknown, chunkId: string, sliceBytes: number) {
  const bytes = Buffer.from(JSON.stringify(object), "utf8");
  const count = Math.ceil(bytes.length / sliceBytes);
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk",
    chunkId,
    index,
    count,
    byteLength: bytes.length,
    data: bytes.subarray(index * sliceBytes, (index + 1) * sliceBytes).toString("base64"),
  }));
}

describe("omp spawn spec (§2.1)", () => {
  it("orders the arguments as the design specifies", () => {
    expect(
      buildOmpRpcArgs({
        cwd: "/proj",
        approvalMode: "always-ask",
        overlayPath: "/home/user/.ccpocket/omp-rpc-overlay.yml",
        model: "baseten/zai-org/GLM-5.3-Fast",
        thinkingLevel: "high",
        additionalDirectories: ["/extra/one", "/extra/two"],
        resumeSessionFile: "/store/2026_01.jsonl",
      }),
    ).toEqual([
      "--mode", "rpc-ui",
      "--cwd", "/proj",
      "--allow-home",
      "--approval-mode", "always-ask",
      "--config", "/home/user/.ccpocket/omp-rpc-overlay.yml",
      "--model", "baseten/zai-org/GLM-5.3-Fast",
      "--thinking", "high",
      "--add-dir", "/extra/one",
      "--add-dir", "/extra/two",
      "--resume", "/store/2026_01.jsonl",
    ]);
  });

  it("never passes session, skill or extension overrides", () => {
    const args = buildOmpRpcArgs({ cwd: "/p", approvalMode: "yolo", overlayPath: "/o.yml" });
    for (const flag of ["--no-session", "--session-dir", "--no-skills", "--no-extensions", "--no-rules", "--no-lsp", "--no-title", "--yolo", "--auto-approve"]) {
      expect(args).not.toContain(flag);
    }
  });

  it("uses BRIDGE_OMP_BIN when set and non-empty", () => {
    expect(resolveOmpBin({ BRIDGE_OMP_BIN: "/opt/omp/bin/omp" })).toBe("/opt/omp/bin/omp");
    expect(resolveOmpBin({ BRIDGE_OMP_BIN: "  " })).toBe("omp");
    expect(resolveOmpBin({})).toBe("omp");
    const spec = buildOmpSpawnSpec(
      { cwd: "/p", approvalMode: "write", overlayPath: "/o.yml" },
      { BRIDGE_OMP_BIN: "/opt/omp" },
    );
    expect(spec.command).toBe("/opt/omp");
    expect(spec.options.cwd).toBe("/p");
    expect(spec.options.stdio).toBe("pipe");
  });

  it("removes the terminal breadcrumb variables and keeps the store variables", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin", OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/agent" };
    for (const key of OMP_BREADCRUMB_ENV_VARS) env[key] = "x";
    const sanitized = sanitizedOmpEnv(env);
    for (const key of OMP_BREADCRUMB_ENV_VARS) expect(sanitized[key]).toBeUndefined();
    expect(sanitized).toEqual({ PATH: "/bin", OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/agent" });
    expect(env.TMUX_PANE).toBe("x");
    const spec = buildOmpSpawnSpec({ cwd: "/p", approvalMode: "yolo", overlayPath: "/o" }, env);
    expect(spec.options.env.KITTY_WINDOW_ID).toBeUndefined();
  });
});

describe("writeOmpRpcOverlay", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes ask.timeout 0 with mode 0600 and rewrites changed content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-overlay-"));
    dirs.push(dir);
    const path = join(dir, "nested", "omp-rpc-overlay.yml");
    await expect(writeOmpRpcOverlay(path)).resolves.toBe(path);
    expect(await readFile(path, "utf8")).toBe(OMP_RPC_OVERLAY_CONTENT);
    expect(OMP_RPC_OVERLAY_CONTENT).toContain("ask:\n  timeout: 0\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await writeFile(path, "ask:\n  timeout: 120\n", { mode: 0o644 });
    await writeOmpRpcOverlay(path);
    expect(await readFile(path, "utf8")).toBe(OMP_RPC_OVERLAY_CONTENT);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("resolveOmpStore", () => {
  it("defaults to ~/.omp/agent", () => {
    expect(resolveOmpStore({}, "/home/user")).toEqual({
      root: "/home/user/.omp",
      agentDir: "/home/user/.omp/agent",
      sessionsDir: "/home/user/.omp/agent/sessions",
      blobsDir: "/home/user/.omp/agent/blobs",
    });
  });

  it("honors PI_CONFIG_DIR, profiles and PI_CODING_AGENT_DIR", () => {
    expect(resolveOmpStore({ PI_CONFIG_DIR: ".pi" }, "/h").agentDir).toBe("/h/.pi/agent");
    expect(resolveOmpStore({ OMP_PROFILE: "work" }, "/h")).toMatchObject({
      profile: "work",
      agentDir: "/h/.omp/profiles/work/agent",
    });
    expect(resolveOmpStore({ PI_PROFILE: "legacy" }, "/h").agentDir).toBe("/h/.omp/profiles/legacy/agent");
    // An explicitly empty OMP_PROFILE selects the default profile over PI_PROFILE.
    expect(resolveOmpStore({ OMP_PROFILE: "", PI_PROFILE: "legacy" }, "/h").agentDir).toBe("/h/.omp/agent");
    expect(resolveOmpStore({ OMP_PROFILE: " default " }, "/h").agentDir).toBe("/h/.omp/agent");
    // Names omp rejects ("Invalid OMP profile") are reported; the paths stay the default ones.
    expect(resolveOmpStore({ OMP_PROFILE: "Bad Name" }, "/h")).toMatchObject({
      invalidProfile: "Bad Name",
      agentDir: "/h/.omp/agent",
    });
    for (const name of ["..", "work.", "nul", "COM1.txt"]) {
      expect(resolveOmpStore({ OMP_PROFILE: name }, "/h").invalidProfile).toBe(name);
    }
    expect(resolveOmpStore({ OMP_PROFILE: "work", PI_PROFILE: "Bad Name" }, "/h").invalidProfile).toBeUndefined();
    expect(resolveOmpStore({ OMP_PROFILE: "", PI_PROFILE: "Bad Name" }, "/h").invalidProfile).toBeUndefined();
    expect(resolveOmpStore({ PI_CODING_AGENT_DIR: "/custom/agent" }, "/h")).toMatchObject({
      agentDir: "/custom/agent",
      sessionsDir: "/custom/agent/sessions",
      blobsDir: "/custom/agent/blobs",
    });
    // A named profile derives its own directory.
    expect(resolveOmpStore({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/custom" }, "/h").agentDir).toBe(
      "/h/.omp/profiles/work/agent",
    );
    // An agent dir inherited from a bypassed PI_PROFILE is ignored, as omp does.
    expect(
      resolveOmpStore(
        { OMP_PROFILE: "", PI_PROFILE: "work", PI_CODING_AGENT_DIR: "/h/.omp/profiles/work/agent" },
        "/h",
      ).agentDir,
    ).toBe("/h/.omp/agent");
  });

  it("reports PI_CODING_AGENT_SESSION_DIR as a flat session directory", () => {
    expect(resolveOmpStore({ PI_CODING_AGENT_SESSION_DIR: "/flat" }, "/h").flatSessionDir).toBe("/flat");
  });
});

describe("OmpRpcTransport", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    fakeChildren.length = 0;
    spawnMock.mockImplementation(() => {
      const child = new FakeChildProcess();
      fakeChildren.push(child);
      return child;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("negotiates protocol v2 after ready and writes nothing else before it", async () => {
    const { transport, child } = startTransport();
    const negotiated = vi.fn();
    transport.on("negotiated", negotiated);
    const early = transport.request({ type: "get_state" });
    child.send(READY);
    expect(child.commands()).toEqual([{ id: "b2", type: "negotiate_protocol", protocolVersion: 2 }]);
    child.send({ id: "b2", type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    await vi.waitFor(() => expect(negotiated).toHaveBeenCalled());
    expect(negotiated.mock.calls[0][0]).toMatchObject({ supportedProtocolVersions: [1, 2] });
    // The outbox holds commands until the owner opens it.
    expect(child.commands()).toHaveLength(1);
    transport.openOutbox();
    expect(child.commands()[1]).toEqual({ id: "b1", type: "get_state" });
    child.send({ id: "b1", type: "response", command: "get_state", success: true, data: { sessionId: "s" } });
    await expect(early).resolves.toEqual({ sessionId: "s" });
  });

  it("negotiates with the verbatim P1 frames", async () => {
    const records = readFileSync(new URL("./omp-fixtures/p1-handshake.jsonl", import.meta.url), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { dir: string; frame: Record<string, unknown> });
    const { transport, child } = startTransport();
    const negotiated = vi.fn();
    transport.on("negotiated", negotiated);
    child.send(records[0].frame);
    const written = child.commands()[0];
    expect({ ...written, id: "np" }).toEqual(records[1].frame);
    child.send({ ...records[2].frame, id: written.id });
    await vi.waitFor(() => expect(negotiated).toHaveBeenCalled());
  });

  it("fails with omp_protocol_unsupported when ready lacks v2", () => {
    const { transport, child } = startTransport();
    const failed = vi.fn();
    transport.on("failed", failed);
    child.send({ ...READY, supportedProtocolVersions: [1] });
    expect(failed.mock.calls[0][0]).toMatchObject({ code: "omp_protocol_unsupported" });
    expect(child.commands()).toEqual([]);
    expect(child.stdin.ended).toBe(true);
  });

  it("fails with omp_protocol_unsupported when negotiation is refused", async () => {
    const { transport, child } = startTransport();
    const failed = vi.fn();
    transport.on("failed", failed);
    child.send(READY);
    child.send({ id: "b1", type: "response", command: "negotiate_protocol", success: false, error: "nope" });
    await vi.waitFor(() => expect(failed).toHaveBeenCalled());
    expect(failed.mock.calls[0][0]).toMatchObject({ code: "omp_protocol_unsupported" });
  });

  it("splits on LF only and keeps U+2028 inside a JSON string", async () => {
    const { child, frames } = startTransport();
    await negotiate(child);
    const text = "line\u2028separated\u2029too";
    child.stdout.emit("data", `${JSON.stringify({ type: "notice", level: "info", message: text })}\n`);
    expect(frames).toEqual([{ type: "notice", level: "info", message: text }]);
  });

  it("reassembles frames split across arbitrary stdout chunks", async () => {
    const { child, frames } = startTransport();
    await negotiate(child);
    const payload = [
      { type: "agent_start" },
      { type: "message_update", messageId: "msg-2", assistantMessageEvent: { type: "text_delta", delta: "héllo ✓" } },
      { type: "agent_end", messages: [], isTerminal: true, yielded: true },
    ]
      .map((frame) => JSON.stringify(frame))
      .join("\n") + "\n";
    for (let i = 0; i < payload.length; i += 7) child.stdout.emit("data", payload.slice(i, i + 7));
    expect(frames.map((frame) => frame.type)).toEqual(["agent_start", "message_update", "agent_end"]);
  });

  it("skips empty lines and drops non-JSON lines", async () => {
    const { child, frames } = startTransport();
    await negotiate(child);
    child.stdout.emit("data", "\n   \nnot json at all\n{\"type\":\"agent_start\"}\n");
    expect(frames).toEqual([{ type: "agent_start" }]);
  });

  it("fails the connection when a line exceeds the limit", async () => {
    const { transport, child } = startTransport({ maxLineChars: 200 });
    await negotiate(child);
    const fatal = vi.fn();
    transport.on("fatal", fatal);
    child.stdout.emit("data", "x".repeat(120));
    child.stdout.emit("data", "y".repeat(120));
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  describe("rpc_chunk reassembly (§2.3)", () => {
    it("decodes once so a multi-byte character split across chunks survives", async () => {
      const { child, frames } = startTransport();
      await negotiate(child);
      const object = { type: "notice", level: "info", message: "日本語テキスト🙂".repeat(20) };
      const chunks = chunkFrames(object, "rpc-1", 7);
      expect(chunks.length).toBeGreaterThan(3);
      for (const chunk of chunks) child.send(chunk);
      expect(frames).toEqual([object]);
    });

    it("resolves a chunked response", async () => {
      const { transport, child } = startTransport();
      await negotiate(child);
      transport.openOutbox();
      const request = transport.request({ type: "set_todos", phases: [] });
      const response = { id: "b2", type: "response", command: "set_todos", success: true, data: { todoPhases: ["x".repeat(300)] } };
      for (const chunk of chunkFrames(response, "rpc-1", 100)) child.send(chunk);
      await expect(request).resolves.toEqual({ todoPhases: ["x".repeat(300)] });
    });

    it("discards a slot with a gap", async () => {
      const { child, frames } = startTransport();
      await negotiate(child);
      const chunks = chunkFrames({ type: "notice", message: "a".repeat(50) }, "rpc-1", 10);
      child.send(chunks[0]);
      child.send(chunks[2]);
      for (const chunk of chunks.slice(3)) child.send(chunk);
      expect(frames).toEqual([]);
    });

    it("discards a slot with a repeated index", async () => {
      const { child, frames } = startTransport();
      await negotiate(child);
      const chunks = chunkFrames({ type: "notice", message: "a".repeat(50) }, "rpc-1", 10);
      child.send(chunks[0]);
      child.send(chunks[1]);
      child.send(chunks[1]);
      for (const chunk of chunks.slice(2)) child.send(chunk);
      expect(frames).toEqual([]);
    });

    it("discards the slot when another frame interleaves, and still dispatches that frame", async () => {
      const { child, frames } = startTransport();
      await negotiate(child);
      const chunks = chunkFrames({ type: "notice", message: "a".repeat(50) }, "rpc-1", 10);
      child.send(chunks[0]);
      child.send({ type: "agent_start" });
      for (const chunk of chunks.slice(1)) child.send(chunk);
      expect(frames).toEqual([{ type: "agent_start" }]);
    });

    it("discards a reassembly whose length differs from byteLength", async () => {
      const { child, frames } = startTransport();
      await negotiate(child);
      const chunks = chunkFrames({ type: "notice", message: "abc" }, "rpc-1", 1000);
      child.send({ ...chunks[0], byteLength: chunks[0].byteLength + 5 });
      expect(frames).toEqual([]);
    });

    it("rejects an oversized announcement without buffering", async () => {
      const { child, frames } = startTransport();
      child.send({ ...READY, maxReassembledFrameBytes: 100 });
      child.send({ id: "b1", type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
      await Promise.resolve();
      const chunks = chunkFrames({ type: "notice", message: "a".repeat(200) }, "rpc-1", 50);
      for (const chunk of chunks) child.send(chunk);
      expect(frames).toEqual([]);
      child.send({ type: "agent_start" });
      expect(frames).toEqual([{ type: "agent_start" }]);
    });
  });

  describe("request correlation (§2.4)", () => {
    it("numbers requests b<n> and rejects success:false with its code", async () => {
      const { transport, child } = startTransport();
      await negotiate(child);
      transport.openOutbox();
      const entries = transport.request({ type: "get_entries", since: "gone" });
      expect(child.commands().at(-1)).toEqual({ id: "b2", type: "get_entries", since: "gone" });
      child.send({ id: "b2", type: "response", command: "get_entries", success: false, error: "Unknown entries cursor: gone", code: "unknown_since" });
      await expect(entries).rejects.toMatchObject({ message: "Unknown entries cursor: gone", code: "unknown_since" });
    });

    it("times out control commands after 30 s but never prompts", async () => {
      vi.useFakeTimers();
      const { transport, child } = startTransport();
      await negotiate(child);
      transport.openOutbox();
      const control = transport.request({ type: "get_state" });
      const prompt = transport.request({ type: "prompt", message: "long" }, { timeoutMs: null });
      const controlResult = expect(control).rejects.toMatchObject({ code: "omp_command_timeout" });
      await vi.advanceTimersByTimeAsync(30_001);
      await controlResult;
      let settled = false;
      prompt.then(() => (settled = true), () => (settled = true));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(settled).toBe(false);
      child.send({ id: "b3", type: "response", command: "prompt", success: true });
      await expect(prompt).resolves.toBeUndefined();
    });

    it("reports a second response for a resolved id as late", async () => {
      const { transport, child } = startTransport();
      await negotiate(child);
      transport.openOutbox();
      const late = vi.fn();
      transport.on("late_response", late);
      const prompt = transport.request({ type: "prompt", message: "x" }, { timeoutMs: null });
      // OBSERVED P5: success, then an error response with the same id
      child.send({ id: "b2", type: "response", command: "prompt", success: true });
      child.send({ id: "b2", type: "response", command: "prompt", success: false, error: "Agent is already processing." });
      await expect(prompt).resolves.toBeUndefined();
      expect(late).toHaveBeenCalledTimes(1);
      child.send({ id: "b999", type: "response", command: "x", success: true });
      expect(late).toHaveBeenCalledTimes(1);
    });

    it("writes notifications without an id and refuses writes after stdin closed", async () => {
      const { transport, child } = startTransport();
      await negotiate(child);
      transport.openOutbox();
      expect(transport.notify({ type: "extension_ui_response", id: "d1", value: "Approve" })).toBe(true);
      expect(child.commands().at(-1)).toEqual({ type: "extension_ui_response", id: "d1", value: "Approve" });
      transport.endInput();
      expect(transport.notify({ type: "extension_ui_response", id: "d2", value: "Deny" })).toBe(false);
      await expect(transport.request({ type: "get_state" })).rejects.toMatchObject({ code: "omp_process_exited" });
      expect(child.stdin.writes).toHaveLength(2);
    });

    it("rejects pending requests when the child exits", async () => {
      const { transport, child } = startTransport();
      await negotiate(child);
      transport.openOutbox();
      const pending = transport.request({ type: "get_state" });
      child.exit(0);
      await expect(pending).rejects.toMatchObject({ code: "omp_process_exited" });
      await expect(transport.exited).resolves.toBe(0);
    });

    it("reads frames and responses that arrive after the exit event", async () => {
      // Node can emit `exit` before the last stdout chunk is read, for example
      // when the event loop was blocked while omp finished.
      const { transport, child, frames } = startTransport();
      await negotiate(child);
      transport.openOutbox();
      const pending = transport.request({ type: "get_state" });
      const exit = vi.fn();
      transport.on("exit", exit);
      child.emit("exit", 1, null);
      child.send({ id: "b2", type: "response", command: "get_state", success: true, data: { ok: true } });
      child.send({ type: "notice", message: "last words" });
      expect(exit).not.toHaveBeenCalled();
      child.emit("close", 1, null);
      await expect(pending).resolves.toEqual({ ok: true });
      expect(frames).toContainEqual({ type: "notice", message: "last words" });
      expect(exit).toHaveBeenCalledWith(1);
      await expect(transport.exited).resolves.toBe(1);
    });

    it("settles 2 s after exit when a grandchild keeps the pipes open", async () => {
      vi.useFakeTimers();
      const { transport, child } = startTransport();
      await negotiate(child);
      transport.openOutbox();
      const pending = transport.request({ type: "prompt", message: "p" }, { timeoutMs: null });
      const rejected = expect(pending).rejects.toMatchObject({ code: "omp_process_exited" });
      child.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(1999);
      expect(transport.hasExited).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(transport.hasExited).toBe(true);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
    });
  });

  describe("start failures (§2.6)", () => {
    it("reports an exit before ready with the stderr tail", async () => {
      const { transport, child } = startTransport();
      const failed = vi.fn();
      const exit = vi.fn();
      transport.on("failed", failed);
      transport.on("exit", exit);
      // OBSERVED P12a
      child.stderr.emit("data", 'Model "baseten/does-not-exist" not found\n\nSet an API key environment variable:\n');
      child.exit(1);
      expect(failed.mock.calls[0][0]).toMatchObject({
        code: "omp_start_failed",
        message: expect.stringContaining('omp exited before it was ready (code 1): Model "baseten/does-not-exist" not found'),
      });
      expect(exit).toHaveBeenCalledWith(1);
    });

    it("keeps the stderr tail that is read after the exit event", () => {
      const { transport, child } = startTransport();
      const failed = vi.fn();
      transport.on("failed", failed);
      child.emit("exit", 1, null);
      child.stderr.emit("data", "Invalid OMP profile: x\n");
      expect(failed).not.toHaveBeenCalled();
      child.emit("close", 1, null);
      expect(failed.mock.calls[0][0]).toMatchObject({
        code: "omp_start_failed",
        message: "omp exited before it was ready (code 1): Invalid OMP profile: x",
      });
    });

    function failingSpawn(cwd: string) {
      spawnMock.mockImplementationOnce(() => {
        const child = new FakeChildProcess();
        child.pid = undefined;
        fakeChildren.push(child);
        return child;
      });
      const { transport, child } = startTransport({}, { ...SPEC, options: { ...SPEC.options, cwd } });
      const failed = vi.fn();
      transport.on("failed", failed);
      // Node raises ENOENT for a missing binary and for a missing cwd alike.
      child.emit("error", Object.assign(new Error("spawn omp ENOENT"), { code: "ENOENT" }));
      return { transport, failed };
    }

    it("reports a missing binary as omp_cli_not_found", async () => {
      const { transport, failed } = failingSpawn(tmpdir());
      expect(failed.mock.calls[0][0]).toMatchObject({
        code: "omp_cli_not_found",
        message: "omp CLI not found. Install omp or set BRIDGE_OMP_BIN.",
      });
      await expect(transport.exited).resolves.toBeNull();
    });

    it("reports a missing working directory as omp_start_failed, not as a missing CLI", async () => {
      const missing = join(tmpdir(), "omp-missing-cwd-does-not-exist");
      const { transport, failed } = failingSpawn(missing);
      expect(failed.mock.calls[0][0]).toMatchObject({
        code: "omp_start_failed",
        message: `omp could not be started: the working directory does not exist: ${missing}`,
      });
      await expect(transport.exited).resolves.toBeNull();
    });

    it("fails and terminates the child when ready does not arrive in time", async () => {
      vi.useFakeTimers();
      const { transport, child } = startTransport({ readyTimeoutMs: 1000 });
      const failed = vi.fn();
      transport.on("failed", failed);
      await vi.advanceTimersByTimeAsync(1001);
      expect(failed.mock.calls[0][0]).toMatchObject({ code: "omp_start_failed" });
      expect(child.signals).toEqual(["SIGTERM"]);
    });
  });
});
