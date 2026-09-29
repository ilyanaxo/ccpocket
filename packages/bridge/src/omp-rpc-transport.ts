import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { missingSpawnCwd, onChildClosed, resolveOmpBin, sanitizedOmpEnv } from "./omp-env.js";
import {
  ompError,
  type OmpApprovalMode,
  type OmpCodedError,
  type OmpThinkingLevel,
} from "./omp-types.js";

/** Bridge-side limit per physical stdout line (UTF-16 code units). */
export const OMP_MAX_STDOUT_LINE_CHARS = 64 * 1024 * 1024;
/** Bridge-side ceiling for a reassembled `rpc_chunk` object (bytes). */
export const OMP_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
export const OMP_READY_TIMEOUT_MS = 60_000;
export const OMP_CONTROL_TIMEOUT_MS = 30_000;
const STDERR_TAIL_CHARS = 8 * 1024;
const RESOLVED_ID_MEMORY = 256;

export const OMP_CLI_NOT_FOUND_MESSAGE =
  "omp CLI not found. Install omp or set BRIDGE_OMP_BIN.";

type JsonRecord = Record<string, unknown>;

export interface OmpSpawnSpec {
  command: string;
  args: string[];
  options: { cwd: string; stdio: "pipe"; env: NodeJS.ProcessEnv };
}

export interface OmpRpcLaunchOptions {
  cwd: string;
  approvalMode: OmpApprovalMode;
  overlayPath: string;
  model?: string;
  thinkingLevel?: OmpThinkingLevel;
  additionalDirectories?: string[];
  /** Absolute path of the session file to reopen. */
  resumeSessionFile?: string;
}

/** Arguments of an `omp --mode rpc-ui` session process, in the order of §2.1. */
export function buildOmpRpcArgs(options: OmpRpcLaunchOptions): string[] {
  const args = [
    "--mode",
    "rpc-ui",
    "--cwd",
    options.cwd,
    "--allow-home",
    "--approval-mode",
    options.approvalMode,
    "--config",
    options.overlayPath,
  ];
  if (options.model) args.push("--model", options.model);
  if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
  for (const dir of options.additionalDirectories ?? []) {
    args.push("--add-dir", dir);
  }
  if (options.resumeSessionFile) {
    args.push("--resume", options.resumeSessionFile);
  }
  return args;
}

export function buildOmpSpawnSpec(
  options: OmpRpcLaunchOptions,
  env: NodeJS.ProcessEnv = process.env,
): OmpSpawnSpec {
  return {
    command: resolveOmpBin(env),
    args: buildOmpRpcArgs(options),
    options: { cwd: options.cwd, stdio: "pipe", env: sanitizedOmpEnv(env) },
  };
}

export interface OmpReadyFrame {
  type: "ready";
  protocolVersion: number;
  supportedProtocolVersions: number[];
  maxFrameBytes?: number;
  maxReassembledFrameBytes?: number;
}

export interface OmpRequestOptions {
  /** `null` disables the timeout (prompts). Default: 30 s. */
  timeoutMs?: number | null;
  /** Write before the outbox opens (handshake commands). */
  immediate?: boolean;
}

export interface OmpRpcTransportEvents {
  /** Every logical stdout frame except `ready`, `response` and `rpc_chunk`. */
  frame: [JsonRecord];
  /** `ready` arrived and protocol v2 was negotiated. */
  negotiated: [OmpReadyFrame];
  /** The process could not be started or negotiated with. */
  failed: [OmpCodedError];
  /** stdout could not be read any further; the child is being terminated. */
  fatal: [Error];
  /** A `response` for an id that had already resolved. */
  late_response: [JsonRecord];
  exit: [code: number | null];
}

interface PendingRequest {
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timeoutMs: number | null;
  timer?: NodeJS.Timeout;
}

interface ChunkSlot {
  chunkId: string;
  count: number;
  byteLength: number;
  parts: Buffer[];
  bytes: number;
}

export interface OmpRpcTransportOptions {
  readyTimeoutMs?: number;
  controlTimeoutMs?: number;
  maxLineChars?: number;
  logPrefix?: string;
}

/**
 * One omp RPC child over stdio: spawn, LF framing, protocol v2 negotiation,
 * `rpc_chunk` reassembly, request correlation and an outbox that holds
 * commands until the owner has finished its own handshake.
 */
export class OmpRpcTransport extends EventEmitter<OmpRpcTransportEvents> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: "new" | "spawned" | "negotiating" | "negotiated" | "failed" | "exited" =
    "new";
  private inputEnded = false;
  private outboxOpen = false;
  private readonly outbox: Array<{ id?: string; frame: JsonRecord }> = [];
  private readonly pending = new Map<string, PendingRequest>();
  private readonly resolvedIds: string[] = [];
  private readonly resolvedIdSet = new Set<string>();
  private nextId = 1;
  private _lastRequestId = "";
  private readyTimer: NodeJS.Timeout | null = null;
  private maxReassembledBytes = OMP_MAX_REASSEMBLED_BYTES;
  private lineChunks: string[] = [];
  private lineChars = 0;
  private stdoutFailed = false;
  private chunkSlot: ChunkSlot | null = null;
  private stderrBuffer = "";
  private stderrLine = "";
  private exitResolve!: (code: number | null) => void;
  private readonly readyTimeoutMs: number;
  private readonly controlTimeoutMs: number;
  private readonly maxLineChars: number;
  private readonly logPrefix: string;

  /**
   * Resolves when the child has exited and its stdout and stderr have been
   * read (`close`, or 2 s after `exit` when a grandchild holds the pipes), or
   * when it failed to spawn.
   */
  readonly exited: Promise<number | null>;

  constructor(options: OmpRpcTransportOptions = {}) {
    super();
    this.readyTimeoutMs = options.readyTimeoutMs ?? OMP_READY_TIMEOUT_MS;
    this.controlTimeoutMs = options.controlTimeoutMs ?? OMP_CONTROL_TIMEOUT_MS;
    this.maxLineChars = options.maxLineChars ?? OMP_MAX_STDOUT_LINE_CHARS;
    this.logPrefix = options.logPrefix ?? "[omp-rpc]";
    this.exited = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
  }

  get isNegotiated(): boolean {
    return this.state === "negotiated";
  }

  get hasExited(): boolean {
    return this.state === "exited";
  }

  /** stdin is open and the child has not exited. */
  get isWritable(): boolean {
    return this.child !== null && !this.inputEnded && this.state !== "exited";
  }

  /** Id of the most recent `request()` (assigned synchronously). */
  get lastRequestId(): string {
    return this._lastRequestId;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Last 8 KiB of stderr, trimmed. */
  get stderrTail(): string {
    return `${this.stderrBuffer}${this.stderrLine}`.slice(-STDERR_TAIL_CHARS).trim();
  }

  start(spec: OmpSpawnSpec): void {
    if (this.state !== "new") throw new Error("omp transport already started");
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spec.command, spec.args, spec.options);
    } catch (err) {
      this.state = "failed";
      queueMicrotask(() => {
        this.emit("failed", spawnError(err, spec.options.cwd));
        this.markExited(null);
      });
      return;
    }
    this.child = child;
    this.state = "spawned";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdoutChunk(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.handleStderrChunk(chunk));
    child.stdin.on("error", (err: Error) => {
      console.warn(`${this.logPrefix} stdin error: ${err.message}`);
    });
    child.on("error", (err: Error) => {
      if (this.state === "exited") return;
      if (child.pid === undefined) {
        // Spawn failed: Node emits `error` and `close`, never `exit`.
        this.failStart(spawnError(err, spec.options.cwd));
        this.markExited(null);
        return;
      }
      console.error(`${this.logPrefix} process error: ${err.message}`);
    });
    // The child is gone, so it can no longer become ready.
    child.on("exit", () => this.clearReadyTimer());
    // Settle only after stdout and stderr are drained: the last frames and
    // the stderr tail can still be unread when `exit` fires.
    onChildClosed(child, (code) => this.handleExit(code));

    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.state !== "spawned") return;
      this.failStart(
        ompError(
          "omp_start_failed",
          `omp did not become ready within ${Math.round(this.readyTimeoutMs / 1000)} s${this.stderrSuffix()}`,
        ),
      );
      this.kill("SIGTERM");
    }, this.readyTimeoutMs);
  }

  /**
   * Send a command and resolve with its `data`. `success:false` rejects with
   * the omp error (and its optional `code`).
   */
  request(frame: JsonRecord, options: OmpRequestOptions = {}): Promise<unknown> {
    const command = String(frame.type ?? "");
    if (this.state === "exited" || this.state === "failed" || this.inputEnded) {
      return Promise.reject(exitedError());
    }
    const id = `b${this.nextId++}`;
    this._lastRequestId = id;
    const timeoutMs =
      options.timeoutMs === undefined ? this.controlTimeoutMs : options.timeoutMs;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { command, resolve, reject, timeoutMs });
      const envelope = { id, ...frame };
      if (options.immediate || this.outboxOpen) {
        this.writeRequest(id, envelope);
      } else {
        this.outbox.push({ id, frame: envelope });
      }
    });
  }

  /** Write a frame without a response (`extension_ui_response`). */
  notify(frame: JsonRecord): boolean {
    if (this.state === "exited" || this.state === "failed" || this.inputEnded) {
      return false;
    }
    if (!this.outboxOpen) {
      this.outbox.push({ frame });
      return true;
    }
    return this.writeLine(frame);
  }

  /** Flush queued commands and write every later command at once. */
  openOutbox(): void {
    if (this.outboxOpen) return;
    this.outboxOpen = true;
    for (const item of this.outbox.splice(0)) {
      if (item.id) this.writeRequest(item.id, item.frame);
      else this.writeLine(item.frame);
    }
  }

  /** Close stdin: omp drains accepted commands, disposes the session and exits. */
  endInput(): void {
    if (this.inputEnded) return;
    this.inputEnded = true;
    for (const item of this.outbox.splice(0)) {
      if (item.id) this.rejectPending(item.id, exitedError());
    }
    try {
      this.child?.stdin.end();
    } catch (err) {
      console.warn(`${this.logPrefix} failed to close stdin: ${String(err)}`);
    }
  }

  kill(signal: NodeJS.Signals): void {
    if (!this.child || this.state === "exited") return;
    try {
      this.child.kill(signal);
    } catch (err) {
      console.warn(`${this.logPrefix} kill(${signal}) failed: ${String(err)}`);
    }
  }

  private writeRequest(id: string, envelope: JsonRecord): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (!this.writeLine(envelope)) {
      this.rejectPending(id, exitedError());
      return;
    }
    if (pending.timeoutMs !== null) {
      pending.timer = setTimeout(() => {
        this.rejectPending(
          id,
          ompError(
            "omp_command_timeout",
            `omp did not answer ${pending.command} within ${Math.round((pending.timeoutMs ?? 0) / 1000)} s`,
          ),
        );
      }, pending.timeoutMs);
    }
  }

  private writeLine(frame: JsonRecord): boolean {
    if (!this.child || this.inputEnded || this.state === "exited") return false;
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch (err) {
      console.warn(`${this.logPrefix} write failed: ${String(err)}`);
      return false;
    }
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    this.rememberResolved(id);
    pending.reject(error);
  }

  private rememberResolved(id: string): void {
    this.resolvedIdSet.add(id);
    this.resolvedIds.push(id);
    while (this.resolvedIds.length > RESOLVED_ID_MEMORY) {
      this.resolvedIdSet.delete(this.resolvedIds.shift()!);
    }
  }

  // ---- stdout ----

  private handleStdoutChunk(chunk: string): void {
    if (this.stdoutFailed) return;
    let lineStart = 0;
    while (lineStart < chunk.length) {
      const newlineIndex = chunk.indexOf("\n", lineStart);
      const end = newlineIndex < 0 ? chunk.length : newlineIndex;
      const fragment = chunk.slice(lineStart, end);
      this.lineChars += fragment.length;
      if (this.lineChars > this.maxLineChars) {
        this.failStdout(
          new Error(
            `omp wrote a stdout line above the Bridge limit of ${this.maxLineChars} characters. ` +
              "Only this omp session was closed; Bridge is still running.",
          ),
        );
        return;
      }
      if (newlineIndex < 0) {
        this.lineChunks.push(fragment);
        return;
      }
      let line: string;
      try {
        this.lineChunks.push(fragment);
        line = this.lineChunks.join("");
      } catch (err) {
        this.failStdout(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.lineChunks = [];
      this.lineChars = 0;
      lineStart = newlineIndex + 1;
      if (line.trim().length === 0) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        console.warn(`${this.logPrefix} dropped a non-JSON stdout line (${line.length} chars)`);
        continue;
      }
      if (frame && typeof frame === "object" && !Array.isArray(frame)) {
        this.handlePhysicalFrame(frame as JsonRecord);
      }
      if (this.stdoutFailed) return;
    }
  }

  private failStdout(error: Error): void {
    this.stdoutFailed = true;
    this.lineChunks = [];
    this.lineChars = 0;
    this.chunkSlot = null;
    console.error(`${this.logPrefix} ${error.message}`);
    if (this.state === "spawned" || this.state === "negotiating") {
      this.failStart(ompError("omp_start_failed", error.message));
    } else {
      this.emit("fatal", error);
    }
    this.kill("SIGTERM");
  }

  private handlePhysicalFrame(frame: JsonRecord): void {
    if (frame.type === "rpc_chunk") {
      this.handleChunk(frame);
      return;
    }
    if (this.chunkSlot) {
      console.warn(
        `${this.logPrefix} protocol error: ${String(frame.type)} frame inside rpc_chunk ${this.chunkSlot.chunkId}; chunk discarded`,
      );
      this.chunkSlot = null;
    }
    this.handleFrame(frame);
  }

  private handleChunk(frame: JsonRecord): void {
    const { chunkId, index, count, byteLength, data } = frame;
    if (
      typeof chunkId !== "string" ||
      typeof index !== "number" ||
      typeof count !== "number" ||
      typeof byteLength !== "number" ||
      typeof data !== "string"
    ) {
      console.warn(`${this.logPrefix} protocol error: malformed rpc_chunk`);
      this.chunkSlot = null;
      return;
    }
    if (index === 0) {
      if (this.chunkSlot) {
        console.warn(
          `${this.logPrefix} protocol error: rpc_chunk ${chunkId} started before ${this.chunkSlot.chunkId} finished; previous chunk discarded`,
        );
      }
      this.chunkSlot = null;
      if (byteLength > this.maxReassembledBytes || count < 1) {
        console.warn(
          `${this.logPrefix} protocol error: rpc_chunk ${chunkId} announces ${byteLength} bytes (limit ${this.maxReassembledBytes}); dropped`,
        );
        return;
      }
      this.chunkSlot = { chunkId, count, byteLength, parts: [], bytes: 0 };
    }
    const slot = this.chunkSlot;
    if (!slot) {
      console.warn(`${this.logPrefix} protocol error: rpc_chunk ${chunkId} #${index} without a start; dropped`);
      return;
    }
    if (slot.chunkId !== chunkId || index !== slot.parts.length || count !== slot.count) {
      console.warn(
        `${this.logPrefix} protocol error: rpc_chunk ${chunkId} #${index} out of sequence (expected ${slot.chunkId} #${slot.parts.length}); chunk discarded`,
      );
      this.chunkSlot = null;
      return;
    }
    const part = Buffer.from(data, "base64");
    slot.bytes += part.length;
    if (slot.bytes > slot.byteLength) {
      console.warn(`${this.logPrefix} protocol error: rpc_chunk ${chunkId} exceeds its byteLength; discarded`);
      this.chunkSlot = null;
      return;
    }
    slot.parts.push(part);
    if (slot.parts.length < slot.count) return;
    this.chunkSlot = null;
    const joined = Buffer.concat(slot.parts);
    if (joined.length !== slot.byteLength) {
      console.warn(
        `${this.logPrefix} protocol error: rpc_chunk ${chunkId} has ${joined.length} bytes, announced ${slot.byteLength}; discarded`,
      );
      return;
    }
    let parsed: unknown;
    try {
      // Decode once: a 256 KiB slice can split a multi-byte character.
      parsed = JSON.parse(joined.toString("utf8"));
    } catch {
      console.warn(`${this.logPrefix} protocol error: rpc_chunk ${chunkId} is not JSON; discarded`);
      return;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      this.handleFrame(parsed as JsonRecord);
    }
  }

  private handleFrame(frame: JsonRecord): void {
    if (frame.type === "ready") {
      this.handleReady(frame);
      return;
    }
    if (this.state !== "negotiating" && this.state !== "negotiated") {
      console.warn(`${this.logPrefix} dropped ${String(frame.type)} frame (${this.state})`);
      return;
    }
    if (frame.type === "response") {
      this.handleResponse(frame);
      return;
    }
    this.emit("frame", frame);
  }

  private handleReady(frame: JsonRecord): void {
    if (this.state !== "spawned") {
      console.warn(`${this.logPrefix} ignored a second ready frame`);
      return;
    }
    this.clearReadyTimer();
    const versions = Array.isArray(frame.supportedProtocolVersions)
      ? frame.supportedProtocolVersions
      : [];
    if (!versions.includes(2)) {
      this.failStart(
        ompError(
          "omp_protocol_unsupported",
          `omp does not support RPC protocol v2 (supported: ${versions.join(", ") || "none"}). Update omp.`,
        ),
      );
      this.endInput();
      return;
    }
    const ready: OmpReadyFrame = {
      type: "ready",
      protocolVersion: typeof frame.protocolVersion === "number" ? frame.protocolVersion : 1,
      supportedProtocolVersions: versions.filter((v): v is number => typeof v === "number"),
      ...(typeof frame.maxFrameBytes === "number" ? { maxFrameBytes: frame.maxFrameBytes } : {}),
      ...(typeof frame.maxReassembledFrameBytes === "number"
        ? { maxReassembledFrameBytes: frame.maxReassembledFrameBytes }
        : {}),
    };
    if (ready.maxReassembledFrameBytes !== undefined) {
      this.maxReassembledBytes = Math.min(
        ready.maxReassembledFrameBytes,
        OMP_MAX_REASSEMBLED_BYTES,
      );
    }
    this.state = "negotiating";
    const negotiation = this.request(
      { type: "negotiate_protocol", protocolVersion: 2 },
      { immediate: true },
    );
    negotiation.then(
      (data) => {
        const version = isRecord(data) ? data.protocolVersion : undefined;
        if (version !== 2) {
          this.failStart(
            ompError(
              "omp_protocol_unsupported",
              `omp negotiated RPC protocol ${String(version)} instead of 2`,
            ),
          );
          this.endInput();
          return;
        }
        if (this.state !== "negotiating") return;
        this.state = "negotiated";
        this.emit("negotiated", ready);
      },
      (err: unknown) => {
        if (this.state !== "negotiating") return;
        this.failStart(
          ompError(
            "omp_protocol_unsupported",
            `omp rejected RPC protocol v2: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        this.endInput();
      },
    );
  }

  private handleResponse(frame: JsonRecord): void {
    const id = typeof frame.id === "string" ? frame.id : undefined;
    const pending = id ? this.pending.get(id) : undefined;
    if (!id || !pending) {
      if (id && this.resolvedIdSet.has(id)) {
        console.log(
          `${this.logPrefix} second response for ${id} (${String(frame.command)}, success=${String(frame.success)})`,
        );
        this.emit("late_response", frame);
      } else {
        console.warn(`${this.logPrefix} response for unknown id ${String(frame.id)} dropped`);
      }
      return;
    }
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    this.rememberResolved(id);
    if (frame.success === true) {
      pending.resolve(frame.data);
      return;
    }
    const message =
      typeof frame.error === "string" && frame.error ? frame.error : `${pending.command} failed`;
    const error = new Error(message) as Error & { code?: string; command?: string };
    if (typeof frame.code === "string") error.code = frame.code;
    error.command = pending.command;
    pending.reject(error);
  }

  // ---- stderr / exit ----

  private handleStderrChunk(chunk: string): void {
    const lines = `${this.stderrLine}${chunk}`.split("\n");
    this.stderrLine = (lines.pop() ?? "").slice(-STDERR_TAIL_CHARS);
    for (const line of lines) {
      this.stderrBuffer = `${this.stderrBuffer}${line}\n`.slice(-STDERR_TAIL_CHARS);
      const trimmed = line.trim();
      if (trimmed) console.log(`${this.logPrefix} stderr: ${trimmed}`);
    }
  }

  private handleExit(code: number | null): void {
    if (this.state === "exited") return;
    this.clearReadyTimer();
    if (this.state === "spawned" || this.state === "negotiating") {
      this.failStart(
        ompError(
          "omp_start_failed",
          `omp exited before it was ready (code ${code ?? "null"})${this.stderrSuffix()}`,
        ),
      );
    }
    this.markExited(code);
  }

  private markExited(code: number | null): void {
    if (this.state === "exited") return;
    this.clearReadyTimer();
    this.state = "exited";
    this.chunkSlot = null;
    const error = exitedError();
    for (const item of this.outbox.splice(0)) {
      if (item.id) this.rejectPending(item.id, error);
    }
    for (const id of [...this.pending.keys()]) this.rejectPending(id, error);
    this.exitResolve(code);
    this.emit("exit", code);
  }

  private clearReadyTimer(): void {
    if (!this.readyTimer) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private failStart(error: OmpCodedError): void {
    if (this.state === "failed" || this.state === "exited" || this.state === "negotiated") {
      return;
    }
    this.state = "failed";
    this.emit("failed", error);
  }

  private stderrSuffix(): string {
    const tail = this.stderrTail;
    return tail ? `: ${tail}` : "";
  }
}

function spawnError(err: unknown, cwd: string): OmpCodedError {
  const missingCwd = missingSpawnCwd(err, cwd);
  if (missingCwd !== null) {
    return ompError(
      "omp_start_failed",
      `omp could not be started: the working directory does not exist: ${missingCwd}`,
    );
  }
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  if (code === "ENOENT") return ompError("omp_cli_not_found", OMP_CLI_NOT_FOUND_MESSAGE);
  return ompError(
    "omp_start_failed",
    `omp could not be started: ${err instanceof Error ? err.message : String(err)}`,
  );
}

function exitedError(): OmpCodedError {
  return ompError("omp_process_exited", "The omp process is not running.");
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
