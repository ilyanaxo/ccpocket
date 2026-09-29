import { EventEmitter } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, fakeChildren, vanishedFiles } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  fakeChildren: [] as FakeChildProcess[],
  /** Files whose `open` fails with ENOENT, as when omp archives one mid-listing. */
  vanishedFiles: new Set<string>(),
}));

class FakeWritable extends EventEmitter {
  public writes: string[] = [];
  public ended = false;
  write(chunk: string): boolean {
    if (this.ended) return false;
    this.writes.push(chunk);
    this.emit("write", chunk);
    return true;
  }
  end(): void {
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
  public pid: number | undefined = 777;
  public signals: string[] = [];
  constructor(public command: string, public args: string[], public options: Record<string, unknown>) {
    super();
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
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
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (path: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
    if (vanishedFiles.has(String(path))) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${String(path)}'`), {
        code: "ENOENT",
      });
    }
    return (actual.open as (...args: unknown[]) => ReturnType<typeof actual.open>)(path, ...rest);
  }) as typeof actual.open;
  return { ...actual, open };
});

import {
  clearOmpSessionCaches,
  findOmpSessionFile,
  getOmpSessionName,
  listOmpModels,
  listOmpRecentSessions,
  parseOmpModels,
  readOmpSessionHeader,
  renameOmpRecentSession,
} from "./omp-sessions.js";
import { createOmpWriterRegistry } from "./omp-writers.js";

const FIXTURES = fileURLToPath(new URL("./omp-fixtures/", import.meta.url));

let root: string;
let agentDir: string;
let sessionsDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omp-sessions-"));
  agentDir = join(root, "agent");
  sessionsDir = join(agentDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  env = { PI_CODING_AGENT_DIR: agentDir };
  clearOmpSessionCaches();
  spawnMock.mockReset();
  fakeChildren.length = 0;
  vanishedFiles.clear();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function titleSlot(title: string): string {
  const base = JSON.stringify({ type: "title", v: 1, title, source: "user", updatedAt: "2026-09-28T20:00:00.000Z", pad: "" });
  return base.replace('"pad":""', `"pad":"${" ".repeat(Math.max(0, 255 - base.length))}"`);
}

function header(id: string, cwd: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-28T20:00:00.000Z", cwd, ...extra });
}

let entrySeq = 0;
function entry(type: string, fields: Record<string, unknown>): string {
  entrySeq += 1;
  return JSON.stringify({ type, id: `x${entrySeq}`, parentId: null, timestamp: "2026-09-28T20:00:01.000Z", ...fields });
}

const userLine = (text: string, extra: Record<string, unknown> = {}) =>
  entry("message", { message: { role: "user", content: [{ type: "text", text }], ...extra } });
const assistantLine = (text: string) =>
  entry("message", { message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });

async function writeSessionFile(bucket: string, name: string, lines: string[]): Promise<string> {
  const dir = join(sessionsDir, bucket);
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, `${lines.join("\n")}\n`);
  return file;
}

async function copyFixture(fixture: string, bucket: string, name: string): Promise<string> {
  const dir = join(sessionsDir, bucket);
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await copyFile(join(FIXTURES, fixture), file);
  return file;
}

describe("listOmpRecentSessions (§6.1)", () => {
  it("lists a session with the fields of the recent-sessions entry", async () => {
    // OBSERVED P7: renamed, model and thinking changed mid-session.
    const file = await copyFixture(
      "session-p7-settings.jsonl",
      "-tmp-omp-design-probe-07",
      "2026-09-28T18-57-12-742Z_01a0e960-d626-7359-b8e8-44ce5c598088.jsonl",
    );
    const sessions = await listOmpRecentSessions({ env });
    expect(sessions).toEqual([
      {
        sessionId: "01a0e960-d626-7359-b8e8-44ce5c598088",
        provider: "omp",
        name: "Probe seven",
        summary: "OK2",
        firstPrompt: "Reply with exactly: OK",
        lastPrompt: "Reply with exactly: OK2",
        created: "2026-09-28T18:57:12.742Z",
        modified: new Date((await stat(file)).mtimeMs).toISOString(),
        gitBranch: "",
        projectPath: "/tmp/omp-design/probe-07",
        isSidechain: false,
        ompSettings: { model: "baseten/deepseek-ai/DeepSeek-V4-Flash-0731", thinkingLevel: "low" },
      },
    ]);
  });

  it("uses the renamed slot title and lists branch results", async () => {
    await copyFixture(
      "session-v4-renamed-side-branch.jsonl",
      "-tmp-omp-design-probe-v04-a",
      "2026-09-28T20-14-29-722Z_01a0e9a7-975a-7047-8e2c-84ced2279309.jsonl",
    );
    await copyFixture(
      "session-p9-branched.jsonl",
      "-tmp-omp-design-probe-09",
      "2026-09-28T19-01-08-116Z_01a0e964-6d94-752c-9fcd-caf2ba46b422.jsonl",
    );
    const sessions = await listOmpRecentSessions({ env });
    const renamed = sessions.find((session) => session.sessionId === "01a0e9a7-975a-7047-8e2c-84ced2279309");
    expect(renamed).toMatchObject({
      name: "Renamed V4",
      firstPrompt: "Reply with exactly: ONE",
      lastPrompt: "SIDE BRANCH PROMPT",
      ompSettings: { model: "baseten/zai-org/GLM-5.3-Fast", thinkingLevel: "max" },
    });
    const branched = sessions.find((session) => session.sessionId === "01a0e964-6d94-752c-9fcd-caf2ba46b422");
    expect(branched).toMatchObject({ firstPrompt: "Reply with exactly: ONE", lastPrompt: "Reply with exactly: THREE" });
    expect(branched?.name).toBeUndefined();
  });

  it("accepts loose file names and excludes artifacts, backups and archives", async () => {
    const lines = [titleSlot(""), header("0123456789abcdef", "/proj"), userLine("legacy id")];
    await writeSessionFile("-proj", "2025-01-01T00-00-00-000Z_0123456789abcdef.jsonl", lines);
    await writeSessionFile("-proj", "2025-01-01T00-00-00-000Z_0123456789abcdef.jsonl.1.bak", lines);
    await writeSessionFile("-proj", "2025-01-01T00-00-00-000Z_0123456789abcdef.jsonl.gz", lines);
    await writeSessionFile("-proj/2025-01-01T00-00-00-000Z_0123456789abcdef", "agent-1.jsonl", lines);
    await writeSessionFile("-proj", "notes.jsonl", lines);
    await writeSessionFile("-proj", "2025-01-02T00-00-00-000Z_no-user.jsonl", [
      titleSlot(""),
      header("no-user", "/proj"),
      assistantLine("hello"),
      userLine("injected", { synthetic: true }),
    ]);
    await writeSessionFile("-proj", "2025-01-03T00-00-00-000Z_bad-header.jsonl", [titleSlot(""), userLine("orphan")]);
    const sessions = await listOmpRecentSessions({ env });
    expect(sessions.map((session) => session.sessionId)).toEqual(["0123456789abcdef"]);
  });

  it("takes projectPath from the header cwd, folding worktrees and ignoring colliding bucket names", async () => {
    await writeSessionFile("-work-proj-worktrees-feature", "2026-01-01T00-00-00-000Z_wt.jsonl", [
      titleSlot(""),
      header("wt", "/work/proj-worktrees/feature"),
      userLine("in the worktree"),
    ]);
    // `/a/b` and `/a-b` encode to the same bucket; the newest file belongs to `/a-b`.
    await writeSessionFile("-a-b", "2026-01-01T00-00-00-000Z_slash.jsonl", [
      titleSlot(""),
      header("slash", "/a/b"),
      userLine("slash project"),
    ]);
    await writeSessionFile("-a-b", "2026-01-02T00-00-00-000Z_dash.jsonl", [
      titleSlot(""),
      header("dash", "/a-b"),
      userLine("dash project"),
    ]);

    // The project filter itself runs in getAllRecentSessions after repository
    // grouping (sessions-index.test.ts); every bucket is listed here.
    const sessions = await listOmpRecentSessions({ env });
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    expect(byId.get("wt")).toEqual(
      expect.objectContaining({ projectPath: "/work/proj", resumeCwd: "/work/proj-worktrees/feature" }),
    );
    expect(byId.get("slash")?.projectPath).toBe("/a/b");
    expect(byId.get("dash")?.projectPath).toBe("/a-b");
    expect(byId.get("slash")?.resumeCwd).toBeUndefined();
    expect(byId.get("dash")?.resumeCwd).toBeUndefined();
  });

  it("recovers a first prompt longer than the head window from the cut line", async () => {
    const longPrompt = `START ${"é".repeat(70_000)} END`;
    await writeSessionFile("-proj", "2026-01-01T00-00-00-000Z_long.jsonl", [
      titleSlot(""),
      header("long", "/proj"),
      userLine(longPrompt),
      entry("custom", { customType: "filler", data: { text: "f".repeat(80_000) } }),
      assistantLine("final answer"),
    ]);
    const [session] = await listOmpRecentSessions({ env });
    expect(session.firstPrompt.startsWith("START éé")).toBe(true);
    expect(session.firstPrompt.length).toBeLessThan(longPrompt.length);
    expect(session.firstPrompt.endsWith("�")).toBe(false);
    expect(session.summary).toBe("final answer");
  });

  it("finds a first prompt behind more than 64 KiB of entries with a bounded scan", async () => {
    await writeSessionFile("-proj", "2026-01-01T00-00-00-000Z_late.jsonl", [
      titleSlot(""),
      header("late", "/proj"),
      entry("custom", { customType: "filler", data: { text: "a".repeat(90_000) } }),
      userLine("hidden first prompt"),
      entry("custom", { customType: "filler", data: { text: "b".repeat(90_000) } }),
      assistantLine("done"),
    ]);
    const [session] = await listOmpRecentSessions({ env });
    expect(session.firstPrompt).toBe("hidden first prompt");
    expect(session.lastPrompt).toBeUndefined();
  });

  it("applies the name rule to slot, title_change and header titles", async () => {
    const full = `A very long session title ${"t".repeat(300)}`;
    await writeSessionFile("-proj", "2026-01-01T00-00-00-000Z_trunc.jsonl", [
      titleSlot(full.slice(0, 120)),
      header("trunc", "/proj"),
      userLine("p"),
      entry("title_change", { title: full, source: "user" }),
    ]);
    await writeSessionFile("-proj", "2026-01-02T00-00-00-000Z_slot.jsonl", [
      titleSlot("Newer slot title"),
      header("slot", "/proj", { title: "Header title" }),
      userLine("p"),
      entry("title_change", { title: "Older title", source: "user" }),
    ]);
    await writeSessionFile("-proj", "2026-01-03T00-00-00-000Z_legacy.jsonl", [
      header("legacy", "/proj", { title: "Header title" }),
      userLine("p"),
    ]);
    await writeSessionFile("-proj", "2026-01-04T00-00-00-000Z_legacy2.jsonl", [
      header("legacy2", "/proj"),
      userLine("p"),
      entry("title_change", { title: "Only title change", source: "user" }),
    ]);
    const names = Object.fromEntries(
      (await listOmpRecentSessions({ env })).map((session) => [session.sessionId, session.name]),
    );
    expect(names).toEqual({
      trunc: full,
      slot: "Newer slot title",
      legacy: "Header title",
      legacy2: "Only title change",
    });
    await expect(getOmpSessionName("trunc", { env })).resolves.toBe(full);
    await expect(getOmpSessionName("missing", { env })).resolves.toBeNull();
  });

  it("takes a title_change that extends the slot only from the tail window", async () => {
    const filler = (text: string) => entry("custom", { customType: "filler", data: { text: text.repeat(70_000) } });
    // An early long name in the head window, a later shorter rename between the
    // windows: the slot holds the current name.
    await writeSessionFile("-proj", "2026-01-01T00-00-00-000Z_shorter.jsonl", [
      titleSlot("Fix login bug"),
      header("shorter", "/proj"),
      userLine("p"),
      entry("title_change", { title: "Fix login bug in the auth module", source: "auto" }),
      filler("a"),
      entry("title_change", { title: "Fix login bug", source: "user" }),
      filler("b"),
      userLine("last"),
    ]);
    // Legacy file without a slot: the head's title_change is the only name.
    await writeSessionFile("-proj", "2026-01-02T00-00-00-000Z_legacy-head.jsonl", [
      header("legacy-head", "/proj"),
      userLine("p"),
      entry("title_change", { title: "Legacy name", source: "user" }),
      filler("c"),
      filler("d"),
      userLine("last"),
    ]);
    const names = Object.fromEntries(
      (await listOmpRecentSessions({ env })).map((session) => [session.sessionId, session.name]),
    );
    expect(names).toEqual({ shorter: "Fix login bug", "legacy-head": "Legacy name" });
    await expect(getOmpSessionName("shorter", { env })).resolves.toBe("Fix login bug");
  });

  it("skips a session file that cannot be read instead of failing the listing", async () => {
    await writeSessionFile("-proj", "2026-01-01T00-00-00-000Z_good.jsonl", [
      titleSlot(""),
      header("good", "/proj"),
      userLine("hello good"),
    ]);
    const bad = await writeSessionFile("-proj", "2026-01-02T00-00-00-000Z_bad.jsonl", [
      titleSlot("Bad"),
      header("bad", "/proj"),
      userLine("hello bad"),
    ]);
    expect((await listOmpRecentSessions({ env })).map((session) => session.sessionId).sort()).toEqual([
      "bad",
      "good",
    ]);
    // The file changes (cache miss, header still cached), then vanishes before it is read.
    await writeFile(bad, `${(await readFile(bad, "utf8"))}${userLine("more")}\n`);
    vanishedFiles.add(bad);
    expect((await listOmpRecentSessions({ env })).map((session) => session.sessionId)).toEqual(["good"]);
    await expect(getOmpSessionName("bad", { env })).resolves.toBeNull();
  });

  it("reads settings from the tail, else from the head", async () => {
    await writeSessionFile("-proj", "2026-01-01T00-00-00-000Z_head.jsonl", [
      titleSlot(""),
      header("head", "/proj"),
      entry("model_change", { model: "baseten/zai-org/GLM-5.3-Fast" }),
      entry("thinking_level_change", { thinkingLevel: "max", configured: null }),
      userLine("p"),
      entry("custom", { customType: "filler", data: { text: "c".repeat(150_000) } }),
      assistantLine("a"),
    ]);
    await writeSessionFile("-proj", "2026-01-02T00-00-00-000Z_cleared.jsonl", [
      titleSlot(""),
      header("cleared", "/proj"),
      entry("model_change", { model: "baseten/MiniMaxAI/MiniMax-M3" }),
      entry("thinking_level_change", { thinkingLevel: "high" }),
      userLine("p"),
      entry("thinking_level_change", {}),
    ]);
    const settings = Object.fromEntries(
      (await listOmpRecentSessions({ env })).map((session) => [session.sessionId, session.ompSettings]),
    );
    expect(settings).toEqual({
      head: { model: "baseten/zai-org/GLM-5.3-Fast", thinkingLevel: "max" },
      cleared: { model: "baseten/MiniMaxAI/MiniMax-M3" },
    });
  });

  it("caches entries by path, mtime and size", async () => {
    const file = await writeSessionFile("-proj", "2026-01-01T00-00-00-000Z_c.jsonl", [
      titleSlot(""),
      header("c", "/proj"),
      userLine("first"),
    ]);
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    await utimes(file, fixed, fixed);
    expect((await listOmpRecentSessions({ env }))[0].firstPrompt).toBe("first");
    // Same size and mtime: the cached entry is kept.
    const content = await readFile(file, "utf8");
    await writeFile(file, content.replace("first", "FIRST"));
    await utimes(file, fixed, fixed);
    expect((await listOmpRecentSessions({ env }))[0].firstPrompt).toBe("first");
    // A new mtime invalidates it.
    await utimes(file, fixed, new Date("2026-01-01T00:00:05.000Z"));
    expect((await listOmpRecentSessions({ env }))[0].firstPrompt).toBe("FIRST");
  });

  it("lists the flat PI_CODING_AGENT_SESSION_DIR", async () => {
    const flat = join(root, "flat");
    await mkdir(flat, { recursive: true });
    await writeFile(
      join(flat, "2026-01-01T00-00-00-000Z_flat.jsonl"),
      `${[titleSlot(""), header("flat", "/proj"), userLine("flat prompt")].join("\n")}\n`,
    );
    const sessions = await listOmpRecentSessions({ env: { ...env, PI_CODING_AGENT_SESSION_DIR: flat } });
    expect(sessions.map((session) => session.sessionId)).toEqual(["flat"]);
  });

  it("lists nothing, and finds no file, for a profile name omp rejects", async () => {
    await writeSessionFile("-proj", "2026-01-01T00-00-00-000Z_bad.jsonl", [
      titleSlot(""),
      header("bad", "/proj"),
      userLine("p"),
    ]);
    expect((await listOmpRecentSessions({ env })).map((session) => session.sessionId)).toEqual(["bad"]);
    clearOmpSessionCaches();
    // omp exits with "Invalid OMP profile" in this environment.
    const invalid = { ...env, OMP_PROFILE: "Bad Name" };
    await expect(listOmpRecentSessions({ env: invalid })).resolves.toEqual([]);
    await expect(findOmpSessionFile("bad", { env: invalid })).resolves.toBeNull();
  });

  it("returns an empty list without a session store", async () => {
    await expect(listOmpRecentSessions({ env: { PI_CODING_AGENT_DIR: join(root, "none") } })).resolves.toEqual([]);
  });
});

describe("findOmpSessionFile and readOmpSessionHeader", () => {
  it("finds a file by id through a bucket scan", async () => {
    const file = await copyFixture(
      "session-p9-source.jsonl",
      "-tmp-omp-design-probe-09",
      "2026-09-28T19-01-03-727Z_01a0e964-5c6f-709e-b709-9a4c92b85f91.jsonl",
    );
    await expect(findOmpSessionFile("01a0e964-5c6f-709e-b709-9a4c92b85f91", { env })).resolves.toBe(file);
    await expect(findOmpSessionFile("01a0e964", { env })).resolves.toBeNull();
    await expect(findOmpSessionFile("../etc", { env })).resolves.toBeNull();
    await expect(readOmpSessionHeader(file)).resolves.toEqual({
      id: "01a0e964-5c6f-709e-b709-9a4c92b85f91",
      cwd: "/tmp/omp-design/probe-09",
      timestamp: "2026-09-28T19:01:03.727Z",
    });
  });

  it("reads the parent of a branched file", async () => {
    const file = await copyFixture(
      "session-p9-branched.jsonl",
      "-tmp-omp-design-probe-09",
      "2026-09-28T19-01-08-116Z_01a0e964-6d94-752c-9fcd-caf2ba46b422.jsonl",
    );
    expect((await readOmpSessionHeader(file))?.parentSession).toBe(
      "/tmp/omp-design/probe-09/sessions/2026-09-28T19-01-03-727Z_01a0e964-5c6f-709e-b709-9a4c92b85f91.jsonl",
    );
  });
});

describe("renameOmpRecentSession (§6.3)", () => {
  function autoRenameChild(child: FakeChildProcess): void {
    child.stdin.on("write", (line: string) => {
      const command = JSON.parse(line);
      if (command.type === "negotiate_protocol") {
        child.send({ id: command.id, type: "response", command: command.type, success: true, data: { protocolVersion: 2 } });
      } else if (command.type === "set_session_name") {
        child.send({ id: command.id, type: "response", command: command.type, success: true });
      }
    });
    child.stdin.on("end", () => queueMicrotask(() => child.exit(0)));
    queueMicrotask(() =>
      child.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }),
    );
  }

  it("waits for the live writer, then renames through a short rpc process", async () => {
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    const file = await writeSessionFile("-project", "2026-01-01T00-00-00-000Z_r1.jsonl", [
      titleSlot(""),
      header("r1", cwd),
      userLine("p"),
    ]);
    spawnMock.mockImplementation((command: string, args: string[], options: Record<string, unknown>) => {
      const child = new FakeChildProcess(command, args, options);
      fakeChildren.push(child);
      autoRenameChild(child);
      return child;
    });
    const writers = createOmpWriterRegistry();
    let releaseLive!: () => void;
    writers.register(file, {
      owner: "bridge-session",
      sessionId: "r1",
      exited: new Promise<void>((resolve) => (releaseLive = resolve)),
    });

    const rename = renameOmpRecentSession({ sessionId: "r1", name: "Renamed", env, writers });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawnMock).not.toHaveBeenCalled();

    releaseLive();
    await expect(rename).resolves.toBe(true);
    const child = fakeChildren[0];
    expect(child.args).toEqual([
      "--mode", "rpc",
      "--cwd", cwd,
      "--allow-home",
      "--approval-mode", "always-ask",
      "--no-skills", "--no-extensions", "--no-rules", "--no-lsp",
      "--resume", file,
    ]);
    expect(child.stdin.writes.map((line) => JSON.parse(line).type)).toEqual(["negotiate_protocol", "set_session_name"]);
    expect(JSON.parse(child.stdin.writes[1]).name).toBe("Renamed");
    expect(child.stdin.ended).toBe(true);
    await writers.waitForRelease(file, 100);
  });

  it("holds the file for its helper, so a resume waiting for the same exit starts after it", async () => {
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    const file = await writeSessionFile("-project", "2026-01-01T00-00-00-000Z_r3.jsonl", [
      titleSlot(""),
      header("r3", cwd),
      userLine("p"),
    ]);
    const order: string[] = [];
    const writers = createOmpWriterRegistry();
    let ownerAtSpawn: unknown;
    spawnMock.mockImplementation((command: string, args: string[], options: Record<string, unknown>) => {
      ownerAtSpawn = writers.ownerBySessionId("r3");
      const child = new FakeChildProcess(command, args, options);
      fakeChildren.push(child);
      autoRenameChild(child);
      child.on("exit", () => order.push("rename helper exited"));
      return child;
    });
    let releaseLive!: () => void;
    writers.register(file, {
      owner: "stopped-session",
      sessionId: "r3",
      exited: new Promise<void>((resolve) => (releaseLive = resolve)),
    });
    const rename = renameOmpRecentSession({ sessionId: "r3", name: "Renamed", env, writers });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawnMock).not.toHaveBeenCalled();
    // A resume of the same session waits for the same exit.
    const resume = writers.acquire(file, { owner: "bridge-resume", sessionId: "r3" }).then((lease) => {
      order.push("resume acquired");
      lease.release();
    });
    releaseLive();
    await rename;
    await resume;
    expect(ownerAtSpawn).toEqual({ owner: "omp-rename:r3", file });
    expect(order).toEqual(["rename helper exited", "resume acquired"]);
  });

  it("returns false for an unknown session and rejects when omp refuses the name", async () => {
    await expect(renameOmpRecentSession({ sessionId: "none", name: "x", env })).resolves.toBe(false);

    await writeSessionFile("-p", "2026-01-01T00-00-00-000Z_r2.jsonl", [titleSlot(""), header("r2", "/missing/cwd"), userLine("p")]);
    spawnMock.mockImplementation((command: string, args: string[], options: Record<string, unknown>) => {
      const child = new FakeChildProcess(command, args, options);
      fakeChildren.push(child);
      child.stdin.on("write", (line: string) => {
        const cmd = JSON.parse(line);
        if (cmd.type === "negotiate_protocol") {
          child.send({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { protocolVersion: 2 } });
        } else {
          // OBSERVED V1
          child.send({ id: cmd.id, type: "response", command: cmd.type, success: false, error: "Session name cannot be empty" });
        }
      });
      child.stdin.on("end", () => queueMicrotask(() => child.exit(0)));
      queueMicrotask(() => child.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] }));
      return child;
    });
    await expect(
      renameOmpRecentSession({ sessionId: "r2", name: " ", env, writers: createOmpWriterRegistry() }),
    ).rejects.toThrow("Session name cannot be empty");
    // The recorded cwd is gone: omp runs in the home directory instead.
    expect(fakeChildren[0].options.cwd).not.toBe("/missing/cwd");
  });
});

describe("listOmpModels (§7.1)", () => {
  function modelsChild(behaviour: (child: FakeChildProcess) => void) {
    spawnMock.mockImplementation((command: string, args: string[], options: Record<string, unknown>) => {
      const child = new FakeChildProcess(command, args, options);
      fakeChildren.push(child);
      queueMicrotask(() => behaviour(child));
      return child;
    });
  }

  it("parses the catalogue of omp models --json", async () => {
    // OBSERVED P10: one model of `omp models --json` per fixture line.
    const models = (await readFile(join(FIXTURES, "p10-models.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    const output = `${JSON.stringify({ models })}\n`;
    modelsChild((child) => {
      child.stdout.emit("data", output.slice(0, 100));
      child.stdout.emit("data", output.slice(100));
      child.exit(0);
    });
    const result = await listOmpModels({ env: { BRIDGE_OMP_BIN: "/opt/omp", TMUX_PANE: "%3" } });
    expect(fakeChildren[0].command).toBe("/opt/omp");
    expect(fakeChildren[0].args).toEqual(["models", "--json"]);
    expect((fakeChildren[0].options.env as NodeJS.ProcessEnv).TMUX_PANE).toBeUndefined();
    expect(fakeChildren[0].options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(result.availability).toBe("available");
    expect(result.models).toEqual([
      { selector: "baseten/MiniMaxAI/MiniMax-M3", provider: "baseten", name: "MiniMax M3", thinkingLevels: ["off"], input: ["text", "image"] },
      { selector: "baseten/moonshotai/Kimi-K3", provider: "baseten", name: "Kimi K3", thinkingLevels: ["off", "low", "high", "max"], input: ["text", "image"] },
      {
        selector: "baseten/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
        provider: "baseten",
        name: "Nemotron Ultra",
        thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
        input: ["text"],
      },
      { selector: "baseten/zai-org/GLM-5.3-Fast", provider: "baseten", name: "GLM 5.3 Fast", thinkingLevels: ["off", "high", "max"], input: ["text", "image"] },
    ]);
  });

  it("keeps output that is read after the exit event", async () => {
    // Node can emit `exit` before the last stdout chunk is read, for example
    // when the event loop was blocked while omp finished.
    modelsChild((child) => {
      child.emit("exit", 0, null);
      child.stdout.emit("data", '{"models":[{"provider":"p","id":"m","name":"M","input":["text"]}]}\n');
      child.emit("close", 0, null);
    });
    await expect(listOmpModels({ env: {} })).resolves.toEqual({
      models: [{ selector: "p/m", provider: "p", name: "M", thinkingLevels: ["off"], input: ["text"] }],
      availability: "available",
    });
  });

  it("filters thinking levels the Bridge does not know", () => {
    expect(
      parseOmpModels({ models: [{ provider: "p", id: "m", name: "M", thinking: ["high", "ultra", "max"], input: ["text"] }] }),
    ).toEqual([{ selector: "p/m", provider: "p", name: "M", thinkingLevels: ["off", "high", "max"], input: ["text"] }]);
  });

  it("reports not_installed, no_models and failures", async () => {
    modelsChild((child) => {
      child.pid = undefined;
      child.emit("error", Object.assign(new Error("spawn omp ENOENT"), { code: "ENOENT" }));
    });
    await expect(listOmpModels({ env: {} })).resolves.toEqual({ models: [], availability: "not_installed" });

    modelsChild((child) => {
      child.stdout.emit("data", '{"models":[]}');
      child.exit(0);
    });
    await expect(listOmpModels({ env: {} })).resolves.toEqual({ models: [], availability: "no_models" });

    modelsChild((child) => child.exit(1));
    await expect(listOmpModels({ env: {} })).resolves.toEqual({ models: [], availability: "no_models" });

    modelsChild((child) => {
      child.stdout.emit("data", "not json");
      child.exit(0);
    });
    await expect(listOmpModels({ env: {} })).rejects.toMatchObject({ code: "omp_models_failed" });
  });
});
