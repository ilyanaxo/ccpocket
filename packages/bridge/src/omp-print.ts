import { spawn } from "node:child_process";
import { OMP_CLI_NOT_FOUND_MESSAGE } from "./omp-rpc-transport.js";
import {
  missingSpawnCwd,
  resolveOmpAssistModel,
  resolveOmpBin,
  sanitizedOmpEnv,
} from "./omp-env.js";
import { ompError } from "./omp-types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 2_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const STDERR_TAIL_CHARS = 2_000;
/** Print mode waits for every MCP server before the first turn (default 30 s). */
const PRINT_MCP_TIMEOUT_MS = "3000";

export interface OmpPrintOptions {
  cwd: string;
  prompt: string;
  /** Written to stdin, which is then closed; omp combines it with the prompt. */
  stdin?: string;
  /**
   * The session's current model selector. `BRIDGE_OMP_ASSIST_MODEL` in `env`
   * overrides it (§8.0); without either, omp uses its default model.
   */
  model?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Arguments of a one-shot `omp -p` run without tools, extensions or session. */
export function buildOmpPrintArgs(options: { prompt: string; model?: string }): string[] {
  return [
    "-p",
    "--no-session",
    "--no-tools",
    "--no-skills",
    "--no-extensions",
    "--no-rules",
    "--no-lsp",
    "--no-title",
    // --no-tools keeps MCP tools; print mode has no UI, so always-ask makes
    // every write/exec-tier call fail closed instead of running unattended.
    "--approval-mode",
    "always-ask",
    ...(options.model ? ["--model", options.model] : []),
    "--thinking",
    "off",
    options.prompt,
  ];
}

/**
 * Run `omp -p` and resolve with its trimmed stdout.
 *
 * `spawn` rather than `execFile`: `omp -p` reads a non-TTY stdin until EOF,
 * and async `execFile` cannot close it; a sync variant would block the event
 * loop (and every session's stdout reader) for seconds.
 */
export function runOmpPrint(options: OmpPrintOptions): Promise<string> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let killTimer: NodeJS.Timeout | undefined;

    const args = buildOmpPrintArgs({
      prompt: options.prompt,
      model: resolveOmpAssistModel(options.model, env),
    });
    const child = spawn(resolveOmpBin(env), args, {
      cwd: options.cwd,
      env: { ...sanitizedOmpEnv(env), OMP_MCP_TIMEOUT_MS: PRINT_MCP_TIMEOUT_MS },
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const terminate = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, KILL_GRACE_MS);
    };

    const timeoutTimer = setTimeout(() => {
      terminate();
      finish(ompError("omp_print_timeout", `omp -p did not finish within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        terminate();
        finish(ompError("omp_print_failed", "omp -p output exceeded 1 MiB"));
        return;
      }
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_CHARS);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      const missingCwd = missingSpawnCwd(err, options.cwd);
      if (missingCwd !== null) {
        finish(ompError("omp_print_failed", `omp -p could not be started: the working directory does not exist: ${missingCwd}`));
        return;
      }
      if (err.code === "ENOENT") {
        finish(ompError("omp_cli_not_found", OMP_CLI_NOT_FOUND_MESSAGE));
        return;
      }
      finish(ompError("omp_print_failed", `omp -p could not be started: ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) {
        finish(null, stdout.trim());
        return;
      }
      const reason = stderr.trim() || (signal ? `killed by ${signal}` : "no output");
      finish(ompError("omp_print_failed", `omp -p exited with code ${code ?? "null"}: ${reason}`));
    });

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        // The child may exit before reading everything (for example a bad model).
      });
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}
