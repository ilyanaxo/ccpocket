import { EventEmitter } from "node:events";
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
  write(chunk: string): boolean {
    if (this.ended) return false;
    this.writes.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
}

class FakeReadable extends EventEmitter {
  setEncoding(_encoding: string): void {}
}

class FakeChildProcess extends EventEmitter {
  public stdout = new FakeReadable();
  public stderr = new FakeReadable();
  public stdin: FakeWritable | null = new FakeWritable();
  public signals: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
  finish(code: number, stdout = "", stderr = ""): void {
    if (stdout) this.stdout.emit("data", stdout);
    if (stderr) this.stderr.emit("data", stderr);
    this.emit("exit", code, null);
  }
}

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { buildOmpPrintArgs, runOmpPrint } from "./omp-print.js";

describe("runOmpPrint", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    fakeChildren.length = 0;
    spawnMock.mockImplementation((_cmd: string, _args: string[], options: { stdio: unknown[] }) => {
      const child = new FakeChildProcess();
      if (options.stdio[0] === "ignore") child.stdin = null;
      fakeChildren.push(child);
      return child;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a tool-less, session-less print run that fails closed", () => {
    expect(buildOmpPrintArgs({ prompt: "Title this", model: "baseten/zai-org/GLM-5.3-Fast" })).toEqual([
      "-p",
      "--no-session",
      "--no-tools",
      "--no-skills",
      "--no-extensions",
      "--no-rules",
      "--no-lsp",
      "--no-title",
      "--approval-mode",
      "always-ask",
      "--model",
      "baseten/zai-org/GLM-5.3-Fast",
      "--thinking",
      "off",
      "Title this",
    ]);
    expect(buildOmpPrintArgs({ prompt: "p" })).not.toContain("--model");
  });

  it("spawns BRIDGE_OMP_BIN with the sanitized env and a short MCP timeout", async () => {
    const env = { BRIDGE_OMP_BIN: "/opt/omp", TMUX_PANE: "%1", WT_SESSION: "x", HOME: "/home/user" };
    const run = runOmpPrint({ cwd: "/proj", prompt: "Reply", env });
    fakeChildren[0].finish(0, "OK\n", "Working...\n");
    await expect(run).resolves.toBe("OK");
    const [command, args, options] = spawnMock.mock.calls[0];
    expect(command).toBe("/opt/omp");
    expect(args.at(-1)).toBe("Reply");
    expect(options.cwd).toBe("/proj");
    expect(options.env.TMUX_PANE).toBeUndefined();
    expect(options.env.WT_SESSION).toBeUndefined();
    expect(options.env.HOME).toBe("/home/user");
    expect(options.env.OMP_MCP_TIMEOUT_MS).toBe("3000");
  });

  it("ignores stdin when no input is given", async () => {
    const run = runOmpPrint({ cwd: "/proj", prompt: "p", env: {} });
    expect(spawnMock.mock.calls[0][2].stdio).toEqual(["ignore", "pipe", "pipe"]);
    fakeChildren[0].finish(0, "x\n");
    await run;
  });

  it("writes stdin and closes it at once", async () => {
    const run = runOmpPrint({ cwd: "/proj", prompt: "Commit message", stdin: "diff --git a b", env: {} });
    const child = fakeChildren[0];
    expect(spawnMock.mock.calls[0][2].stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(child.stdin?.writes).toEqual(["diff --git a b"]);
    expect(child.stdin?.ended).toBe(true);
    child.finish(0, "chore(greet): expand greeting\n");
    await expect(run).resolves.toBe("chore(greet): expand greeting");
  });

  it("rejects with the stderr tail on a non-zero exit", async () => {
    const run = runOmpPrint({ cwd: "/proj", prompt: "p", model: "baseten/does-not-exist", env: {} });
    // OBSERVED P11f
    fakeChildren[0].finish(1, "", 'Model "baseten/does-not-exist" not found\n');
    await expect(run).rejects.toMatchObject({
      code: "omp_print_failed",
      message: expect.stringContaining('Model "baseten/does-not-exist" not found'),
    });
  });

  it("kills the child on timeout", async () => {
    vi.useFakeTimers();
    const run = runOmpPrint({ cwd: "/proj", prompt: "p", timeoutMs: 1000, env: {} });
    const assertion = expect(run).rejects.toMatchObject({ code: "omp_print_timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(fakeChildren[0].signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fakeChildren[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("reports a missing binary", async () => {
    const run = runOmpPrint({ cwd: tmpdir(), prompt: "p", env: {} });
    fakeChildren[0].emit("error", Object.assign(new Error("spawn omp ENOENT"), { code: "ENOENT" }));
    await expect(run).rejects.toMatchObject({ code: "omp_cli_not_found" });
  });

  it("reports a missing working directory instead of a missing binary", async () => {
    const missing = join(tmpdir(), "omp-print-missing-cwd-does-not-exist");
    const run = runOmpPrint({ cwd: missing, prompt: "p", env: {} });
    // Node raises ENOENT for a missing cwd as well.
    fakeChildren[0].emit("error", Object.assign(new Error("spawn omp ENOENT"), { code: "ENOENT" }));
    await expect(run).rejects.toMatchObject({
      code: "omp_print_failed",
      message: `omp -p could not be started: the working directory does not exist: ${missing}`,
    });
  });
});

describe("assist model (§8.0)", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    fakeChildren.length = 0;
    spawnMock.mockImplementation(() => {
      const child = new FakeChildProcess();
      child.stdin = null;
      fakeChildren.push(child);
      return child;
    });
  });

  async function modelArg(model: string | undefined, env: NodeJS.ProcessEnv): Promise<string | undefined> {
    const run = runOmpPrint({ cwd: "/proj", prompt: "p", ...(model ? { model } : {}), env });
    fakeChildren.at(-1)!.finish(0, "ok\n");
    await run;
    const args = spawnMock.mock.calls.at(-1)![1] as string[];
    const index = args.indexOf("--model");
    return index === -1 ? undefined : args[index + 1];
  }

  it("uses BRIDGE_OMP_ASSIST_MODEL over the session model", async () => {
    expect(
      await modelArg("baseten/zai-org/GLM-5.3-Fast", { BRIDGE_OMP_ASSIST_MODEL: " baseten/moonshotai/Kimi-K3 " }),
    ).toBe("baseten/moonshotai/Kimi-K3");
    expect(await modelArg(undefined, { BRIDGE_OMP_ASSIST_MODEL: "baseten/moonshotai/Kimi-K3" })).toBe(
      "baseten/moonshotai/Kimi-K3",
    );
  });

  it("falls back to the session model, then to omp's default", async () => {
    expect(await modelArg("baseten/zai-org/GLM-5.3-Fast", { BRIDGE_OMP_ASSIST_MODEL: "  " })).toBe(
      "baseten/zai-org/GLM-5.3-Fast",
    );
    expect(await modelArg(undefined, {})).toBeUndefined();
  });
});
