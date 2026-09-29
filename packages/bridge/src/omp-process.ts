import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { AssistantContent, ProcessStatus } from "./parser.js";
import {
  defaultOmpRpcOverlayPath,
  resolveOmpBin,
  writeOmpRpcOverlay,
} from "./omp-env.js";
import {
  buildOmpSpawnSpec,
  OmpRpcTransport,
  type OmpRpcTransportOptions,
} from "./omp-rpc-transport.js";
import {
  askUserQuestionInput,
  canonicalToolInput,
  canonicalToolName,
  isOmpReplaceEdit,
  isRecord,
  ompAskQuestions,
  ompCallIntent,
  ompEditPatchText,
  ompEditTargetPaths,
  ompInternalToolName,
  ompMessageText,
  ompResultImageBlocks,
  ompTodoPhases,
  ompTodoWriteInput,
  ompToolResultContent,
  stripOmpIntent,
  type OmpAskQuestion,
} from "./omp-tool-mapping.js";
import {
  approvalModeFor,
  isOmpThinkingLevel,
  legacyPermissionModeFor,
  ompError,
  ompErrorCode,
  ompThinkingLevelsFor,
  type OmpCodedError,
  type OmpExecutionMode,
  type OmpLegacyPermissionMode,
  type OmpProcessMessage,
  type OmpSettings,
  type OmpStartOptions,
  type OmpSystemMessage,
  type OmpThinkingLevel,
} from "./omp-types.js";
import {
  ompWriters,
  type OmpWriterRegistry,
  type OmpWriterReservation,
} from "./omp-writers.js";

type JsonRecord = Record<string, unknown>;

export interface OmpProcessEvents {
  message: [OmpProcessMessage];
  status: [ProcessStatus];
  exit: [number | null];
  input_ready: [];
  session_name: [string];
  user_entries: [Array<{ entryId: string; text: string }>];
}

export interface OmpProcessOptions {
  platform?: NodeJS.Platform;
  writers?: OmpWriterRegistry;
  env?: NodeJS.ProcessEnv;
  /** `--config` overlay path; default `~/.ccpocket/omp-rpc-overlay.yml`. */
  overlayPath?: string;
  transport?: OmpRpcTransportOptions;
}

export interface OmpImageInput {
  base64: string;
  mimeType: string;
}

const APPROVAL_TITLE_PREFIX = "Allow tool: ";
const APPROVAL_OPTIONS = ["Approve", "Deny"];
const ASK_OTHER_LABEL = "Other (type your own)";
const ASK_DONE_SUFFIX = "Done selecting";
const RECOMMENDED_SUFFIX = " (Recommended)";
const APPROVAL_PATCH_LINES = 40;
const APPROVAL_SCORE_PREFIX_CHARS = 120;
const STOP_SIGTERM_MS = 5_000;
const STOP_SIGKILL_MS = 10_000;
const INTERRUPT_CONFIRM_TIMEOUT_MS = 30_000;
const ANSI_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

type Lifecycle = "new" | "starting" | "ready" | "closing" | "exited";

interface PendingPrompt {
  rpcId?: string;
  sentAt: number;
  acceptedAt?: number;
}

interface ToolCallRecord {
  toolCallId: string;
  /** Internal omp tool name (wire aliases resolved). */
  name: string;
  /** Arguments without `i`. */
  args: JsonRecord;
  intent?: string;
  approvalDialogId: string | null;
  ended: boolean;
}

interface PermissionPayload {
  type: "permission_request";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface ApprovalDialog {
  kind: "approval";
  dialogId: string;
  toolUseId: string;
  name: string;
  /** omp's detail lines (the title without its first line). */
  details: string[];
  reason?: string;
  eligibleForAlways: boolean;
  payload: PermissionPayload;
}

interface GenericDialog {
  kind: "dialog";
  dialogId: string;
  toolUseId: string;
  method: "select" | "confirm" | "input" | "editor";
  options: string[];
  payload: PermissionPayload;
  timer?: NodeJS.Timeout;
}

type OpenDialog = ApprovalDialog | GenericDialog;

interface AskFrame {
  dialogId: string;
  method: "select" | "editor";
  questionIndex: number;
  options: string[];
}

interface AskState {
  toolCallId: string;
  questions: OmpAskQuestion[];
  /** Answer values per question index, once `answer()` arrived. */
  answers?: string[][];
  /** Labels already toggled per multi-select question. */
  toggled: Map<number, Set<string>>;
  cursor: number;
  requestEmitted: boolean;
  /** `permission_resolved` was sent (answered, declined, withdrawn). */
  resolved: boolean;
  rejected: boolean;
  awaitingFrame?: AskFrame;
  timer?: NodeJS.Timeout;
}

interface RunStats {
  startedAt: number;
  cost: number;
  input: number;
  cacheRead: number;
  output: number;
  toolCalls: number;
  fileEdits: number;
  lastText?: string;
  lastStopReason?: string;
  lastErrorMessage?: string;
}

interface DeferredCommand {
  run: () => void;
  reject: (error: Error) => void;
}

interface PendingModelChange {
  settings: OmpSettings;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * One omp session driven over `omp --mode rpc-ui` (docs/omp-integration.md
 * §2–§7). Translates omp frames into Bridge messages and exposes the
 * duck-typed members `SessionManager` and `websocket.ts` call on provider
 * processes.
 */
export class OmpProcess extends EventEmitter<OmpProcessEvents> {
  private readonly platform: NodeJS.Platform;
  private readonly writers: OmpWriterRegistry;
  private readonly env: NodeJS.ProcessEnv;
  private readonly overlayPath: string;
  private readonly transportOptions: OmpRpcTransportOptions;

  private transport: OmpRpcTransport | null = null;
  private lifecycle: Lifecycle = "new";
  private respawning = false;
  private _status: ProcessStatus = "starting";
  private exitDeferred: Deferred<number | null> = deferred();
  private readiness: "pending" | "ready" | "failed" = "pending";
  private readinessError: OmpCodedError | null = null;
  private readinessWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  /** Commands issued while starting, written after the handshake (§2.4). */
  private deferredCommands: DeferredCommand[] = [];
  private stopTimers: NodeJS.Timeout[] = [];
  private exitedWriteReported = false;
  private startupFailure: OmpCodedError | null = null;
  private fatalMessage: string | null = null;

  private cwd = "";
  private startOptions: OmpStartOptions | null = null;
  private _executionMode: OmpExecutionMode = "default";
  private _sessionId: string | null = null;
  private _sessionFile: string | null = null;
  private _settings: OmpSettings = {};
  private _thinkingLevels: OmpThinkingLevel[] = ["off"];
  private registeredFile: string | null = null;

  // run state (§2.5)
  private readonly pendingPrompts = new Set<PendingPrompt>();
  private runLive = false;
  private runAgentInitiated = false;
  private compacting = false;
  private settled = true;
  private stats: RunStats = emptyStats();

  // tool calls, dialogs, ask
  private calls: ToolCallRecord[] = [];
  private readonly startedArgs = new Map<string, { name: string; args: JsonRecord }>();
  private readonly heldTodos = new Map<string, ToolCallRecord>();
  private readonly dialogs = new Map<string, OpenDialog>();
  private readonly askStates = new Map<string, AskState>();
  private readonly alwaysAllowedTools = new Set<string>();

  // streaming
  private currentAssistantMessageId: string | null = null;
  private readonly streamedText = new Map<string, string>();

  // settings and pending changes
  private pendingModelChange: PendingModelChange | null = null;
  private modelChangeInFlight = false;
  /** Prompts sent while a model change is applied wait for it (ordering on stdin). */
  private modelChangeBarrier: Promise<void> | null = null;
  private suppressModelChanged = false;
  private thinkingEcho: { seen: boolean; level: OmpThinkingLevel | undefined } | null = null;
  private pendingApprovalMode: OmpExecutionMode | null = null;
  private pendingCommands: string[] | null = null;
  private initEmitted = false;

  // user uuid backfill (§6.6)
  private entryCursor: string | null = null;
  private backfillStopped = false;
  private backfillInFlight = false;
  private backfillAgain = false;

  private readonly loggedUnknownTypes = new Set<string>();

  constructor(options: OmpProcessOptions = {}) {
    super();
    this.platform = options.platform ?? process.platform;
    this.writers = options.writers ?? ompWriters;
    this.env = options.env ?? process.env;
    this.overlayPath = options.overlayPath ?? defaultOmpRpcOverlayPath();
    this.transportOptions = options.transport ?? {};
    // Resolved before any child exists so waiting on it is always safe.
    this.exitDeferred.resolve(null);
  }

  // ---- public state ----

  get status(): ProcessStatus {
    return this._status;
  }

  /** Idle and ready: a prompt can be sent now. */
  get isWaitingForInput(): boolean {
    return this._status === "idle" && this.lifecycle === "ready";
  }

  get isBusy(): boolean {
    return (
      this.lifecycle === "ready" &&
      (this._status === "running" ||
        this._status === "waiting_approval" ||
        this._status === "compacting")
    );
  }

  get isAlive(): boolean {
    return this.lifecycle === "starting" || this.lifecycle === "ready";
  }

  /** No background work is left (`session_settled` since the last run). */
  get isSettled(): boolean {
    return this.settled;
  }

  get isRunning(): boolean {
    return this.isAlive;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get sessionFile(): string | null {
    return this._sessionFile;
  }

  get executionMode(): OmpExecutionMode {
    return this._executionMode;
  }

  get permissionMode(): OmpLegacyPermissionMode {
    return legacyPermissionModeFor(this._executionMode);
  }

  get settings(): OmpSettings {
    return { ...this._settings };
  }

  /** Thinking levels offered by the current model. */
  get thinkingLevels(): OmpThinkingLevel[] {
    return [...this._thinkingLevels];
  }

  /** Resolves when the current child exits; replaced on an approval-mode respawn. */
  get exited(): Promise<number | null> {
    return this.exitDeferred.promise;
  }

  // ---- lifecycle ----

  start(cwd: string, options: OmpStartOptions): void {
    if (this.lifecycle !== "new") throw new Error("OmpProcess already started");
    this.cwd = options.cwd ?? cwd;
    this.startOptions = options;
    this._executionMode = options.executionMode;
    this._sessionId = options.resumeSessionId ?? null;
    this._sessionFile = options.resumeSessionFile ?? null;
    this._settings = {
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    };
    this.entryCursor = options.entryCursor ?? null;
    this.lifecycle = "starting";
    this.exitDeferred = deferred();

    if (this.platform === "win32" && !resolveOmpBin(this.env).toLowerCase().endsWith(".exe")) {
      // Deferred so listeners attached after start() see it.
      queueMicrotask(() =>
        this.failBeforeSpawn(
          ompError(
            "omp_unsupported_platform",
            "omp sessions are not supported on Windows. Set BRIDGE_OMP_BIN to omp.exe to try anyway.",
          ),
        ),
      );
      return;
    }
    void this.launch({
      resumeSessionFile: options.resumeSessionFile,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
    });
  }

  waitUntilReady(): Promise<void> {
    if (this.readiness === "ready") return Promise.resolve();
    if (this.readiness === "failed") {
      return Promise.reject(this.readinessError ?? ompError("omp_start_failed", "omp failed to start"));
    }
    return new Promise((resolve, reject) => {
      this.readinessWaiters.push({ resolve, reject });
    });
  }

  stop(): void {
    if (this.lifecycle === "closing" || this.lifecycle === "exited") return;
    const hadTransport = this.transport;
    const wasReady = this.lifecycle === "ready";
    this.lifecycle = "closing";
    this.respawning = false;
    this.pendingApprovalMode = null;
    this.rejectPendingModelChange(ompError("omp_process_exited", "The omp session was stopped."));
    this.rejectReadiness(ompError("omp_process_exited", "The omp session was stopped."));
    this.dropDeferredCommands("The omp session was stopped.");
    if (wasReady && hadTransport) {
      this.cancelAllDialogs(hadTransport);
      if (this.runLive || this.pendingPrompts.size > 0) {
        hadTransport.request({ type: "abort" }).catch(() => {});
      }
    }
    if (hadTransport) {
      this.shutdownTransport(hadTransport);
    }
    this.refreshStatus();
    console.log("[omp-process] Stopping");
  }

  interrupt(): void {
    if (this.lifecycle !== "ready" || !this.transport) return;
    if (!this.isBusy) return;
    const transport = this.transport;
    // omp does not withdraw approval dialogs on abort, and abort (plus every
    // later command) hangs until they are answered (OBSERVED P4a/P4b).
    this.cancelAllDialogs(transport);
    let confirmed = false;
    const timer = setTimeout(() => {
      if (!confirmed && this.lifecycle === "ready") {
        this.emitNotice("omp did not confirm the interrupt");
      }
    }, INTERRUPT_CONFIRM_TIMEOUT_MS);
    transport.request({ type: "abort" }, { timeoutMs: null }).then(
      () => {
        confirmed = true;
        clearTimeout(timer);
      },
      (err: unknown) => {
        confirmed = true;
        clearTimeout(timer);
        if (ompErrorCode(err) !== "omp_process_exited") {
          console.warn(`[omp-process] abort failed: ${errorMessage(err)}`);
        }
      },
    );
    this.refreshStatus();
  }

  // ---- input ----

  sendInput(text: string, options: { images?: OmpImageInput[] } = {}): boolean {
    if (!this.isAlive) {
      this.reportExitedWrite();
      return false;
    }
    const prompt: PendingPrompt = { sentAt: Date.now() };
    this.pendingPrompts.add(prompt);
    this.stats = emptyStats();
    const frame: JsonRecord = {
      type: "prompt",
      message: text,
      // omp consults it only while a run streams: a prompt that meets an
      // agent-initiated run is queued behind it instead of failing busy.
      streamingBehavior: "followUp",
      ...imagesField(options.images),
    };
    const send = () => this.command(frame, { timeoutMs: null, onId: (id) => (prompt.rpcId = id) });
    const sent = this.modelChangeBarrier ? this.modelChangeBarrier.then(send) : send();
    sent.then(
      (data) => {
        if (!this.pendingPrompts.has(prompt)) return;
        if (isRecord(data) && data.agentInvoked === false) {
          // Completed locally (built-in slash command); no prompt_result follows.
          this.pendingPrompts.delete(prompt);
          this.emitMessage({ type: "result", subtype: "success", ...this.sessionIdField() });
          this.refreshStatus();
          return;
        }
        prompt.acceptedAt = Date.now();
      },
      (err: unknown) => {
        if (!this.pendingPrompts.has(prompt)) return;
        this.pendingPrompts.delete(prompt);
        if (ompErrorCode(err) !== "omp_process_exited") {
          this.emitMessage({
            type: "result",
            subtype: "error",
            error: errorMessage(err),
            ...this.sessionIdField(),
          });
        }
        this.refreshStatus();
      },
    );
    this.refreshStatus();
    return true;
  }

  /**
   * Send `steer` while a run is live. omp would start a run for an idle steer
   * without a `prompt_result`, so an idle steer is refused (the caller sends a
   * prompt instead).
   */
  async steer(text: string, options: { images?: OmpImageInput[] } = {}): Promise<void> {
    if (!this.isAlive) {
      this.reportExitedWrite();
      throw ompError("omp_process_exited", "The omp process is not running.");
    }
    if (!this.isBusy) {
      throw ompError("omp_steer_not_busy", "omp is idle; send the message as a prompt.");
    }
    await this.command({ type: "steer", message: text, ...imagesField(options.images) });
  }

  // ---- approvals, questions, dialogs (§4) ----

  approve(toolUseId?: string): boolean {
    if (!this.isAlive) {
      this.reportExitedWrite();
      return false;
    }
    const dialog = this.findApproval(toolUseId);
    if (!dialog) return false;
    this.answerApproval(dialog, "Approve");
    this.refreshStatus();
    return true;
  }

  approveAlways(toolUseId?: string): boolean {
    if (!this.isAlive) {
      this.reportExitedWrite();
      return false;
    }
    const dialog = this.findApproval(toolUseId);
    if (!dialog) return false;
    this.alwaysAllowedTools.add(dialog.name);
    this.answerApproval(dialog, "Approve");
    for (const other of [...this.dialogs.values()]) {
      if (other.kind === "approval" && other.name === dialog.name && other.eligibleForAlways) {
        this.answerApproval(other, "Approve");
      }
    }
    this.refreshStatus();
    return true;
  }

  /** Deny an approval (and steer `message` after it), decline a question or dialog. */
  reject(toolUseId?: string, message?: string): boolean {
    if (!this.isAlive) {
      this.reportExitedWrite();
      return false;
    }
    const approval = this.findApproval(toolUseId);
    if (approval) {
      this.answerApproval(approval, "Deny");
      const note = message?.trim();
      if (note) {
        this.command({ type: "steer", message: note }).catch((err: unknown) =>
          console.warn(`[omp-process] steer after deny failed: ${errorMessage(err)}`),
        );
      }
      this.refreshStatus();
      return true;
    }
    if (toolUseId) {
      const ask = this.askStates.get(toolUseId);
      if (ask && !ask.rejected && !ask.answers) {
        this.rejectAsk(ask);
        this.refreshStatus();
        return true;
      }
      const dialog = this.findDialogByToolUseId(toolUseId);
      if (dialog) {
        this.respondToDialog(dialog, { cancelled: true });
        this.refreshStatus();
        return true;
      }
    }
    return false;
  }

  answer(toolUseId: string, result: string): boolean {
    if (!this.isAlive) {
      this.reportExitedWrite();
      return false;
    }
    const ask = this.askStates.get(toolUseId);
    if (ask) {
      if (ask.answers || ask.rejected) return false;
      const answers = parseAskAnswers(ask.questions, result);
      if (!answers) return false;
      ask.answers = answers;
      this.resolveAsk(ask);
      const frame = ask.awaitingFrame;
      if (frame) {
        ask.awaitingFrame = undefined;
        this.clearAskTimer(ask);
        this.replayAskFrame(ask, frame);
      }
      this.refreshStatus();
      return true;
    }
    const dialog = this.findDialogByToolUseId(toolUseId);
    if (!dialog) return false;
    const value = firstAnswerValue(result);
    switch (dialog.method) {
      case "select":
        this.respondToDialog(
          dialog,
          dialog.options.includes(value) ? { value } : { cancelled: true },
        );
        break;
      case "confirm":
        this.respondToDialog(dialog, { confirmed: value === "Yes" });
        break;
      default:
        this.respondToDialog(dialog, { value });
    }
    this.refreshStatus();
    return true;
  }

  getPendingPermission(
    toolUseId?: string,
  ): { toolUseId: string; toolName: string; input: Record<string, unknown> } | undefined {
    for (const dialog of this.dialogs.values()) {
      if (!toolUseId || dialog.toolUseId === toolUseId) return clonePayload(dialog.payload);
    }
    for (const ask of this.askStates.values()) {
      if (!isAskOpen(ask)) continue;
      if (!toolUseId || ask.toolCallId === toolUseId) {
        return {
          toolUseId: ask.toolCallId,
          toolName: "AskUserQuestion",
          input: askUserQuestionInput(ask.questions),
        };
      }
    }
    return undefined;
  }

  // ---- model, thinking, approval mode, name, branch (§6, §7) ----

  /**
   * Change model and/or thinking level. Applied at once when idle, otherwise
   * at the next transition into idle (a newer request replaces a pending one).
   * Rejects with `set_omp_model_failed` when omp refuses the change.
   */
  setModelSettings(settings: OmpSettings): Promise<void> {
    if (!this.isAlive) {
      this.reportExitedWrite();
      return Promise.reject(ompError("omp_process_exited", "The omp process is not running."));
    }
    return new Promise((resolve, reject) => {
      if (this.pendingModelChange) this.pendingModelChange.resolve();
      this.pendingModelChange = { settings, resolve, reject };
      if (this.isWaitingForInput && !this.modelChangeInFlight) {
        void this.applyPendingModelChange();
      }
    });
  }

  /**
   * omp has no RPC command for the approval mode: the Bridge respawns omp with
   * `--resume <file> --approval-mode <new>` once it is idle and settled (a
   * respawn ends background jobs).
   */
  async setApprovalMode(mode: OmpExecutionMode): Promise<{ applied: "now" | "deferred" }> {
    if (!this.isAlive) {
      this.reportExitedWrite();
      throw ompError("omp_process_exited", "The omp process is not running.");
    }
    if (mode === this._executionMode) {
      this.pendingApprovalMode = null;
      return { applied: "now" };
    }
    this.pendingApprovalMode = mode;
    if (!(this.isWaitingForInput && this.settled) || this.modelChangeInFlight) {
      return { applied: "deferred" };
    }
    this.startRespawn();
    return { applied: "now" };
  }

  async setSessionName(name: string): Promise<void> {
    if (!this.isAlive) {
      this.reportExitedWrite();
      throw ompError("omp_process_exited", "The omp process is not running.");
    }
    await this.command({ type: "set_session_name", name });
  }

  /**
   * Fork the conversation before user entry `entryId` inside this process.
   * omp writes the branched file at once and switches to it.
   */
  async branch(
    entryId: string,
  ): Promise<{ cancelled: boolean; sessionId: string; sessionFile: string | null }> {
    if (!this.isAlive) {
      this.reportExitedWrite();
      throw ompError("omp_process_exited", "The omp process is not running.");
    }
    const data = await this.command({ type: "branch", entryId });
    if (isRecord(data) && data.cancelled === true) {
      return { cancelled: true, sessionId: this._sessionId ?? "", sessionFile: this._sessionFile };
    }
    const state = await this.command({ type: "get_state" });
    const previousFile = this.registeredFile;
    this.applyState(state);
    this.entryCursor = null;
    if (previousFile && previousFile !== this._sessionFile) {
      this.writers.release(previousFile, this.ownerId());
      this.registeredFile = null;
    }
    this.registerWriter();
    return { cancelled: false, sessionId: this._sessionId ?? "", sessionFile: this._sessionFile };
  }

  // ---- launch and handshake (§2.1, §2.4) ----

  private async launch(spec: {
    resumeSessionFile?: string;
    model?: string;
    thinkingLevel?: OmpThinkingLevel;
  }): Promise<void> {
    // The resumed file stays reserved from before the spawn until the child
    // exits, so no other Bridge writer (rename, second resume) can start on it
    // during spawn and handshake (§6.7).
    let reservation: OmpWriterReservation | null = null;
    try {
      if (spec.resumeSessionFile) {
        reservation = await this.writers.acquire(spec.resumeSessionFile, {
          owner: this.ownerId(),
          sessionId: this._sessionId ?? "",
        });
      }
      if (this.lifecycle !== "starting") {
        reservation?.release();
        this.finishWithoutChild();
        return;
      }
      await writeOmpRpcOverlay(this.overlayPath);
    } catch (err) {
      reservation?.release();
      if (this.lifecycle !== "starting") {
        this.finishWithoutChild();
        return;
      }
      this.failBeforeSpawn(
        ompErrorCode(err) === "omp_session_busy"
          ? (err as OmpCodedError)
          : ompError("omp_start_failed", `omp could not be prepared: ${errorMessage(err)}`),
      );
      return;
    }
    if (this.lifecycle !== "starting") {
      reservation?.release();
      this.finishWithoutChild();
      return;
    }

    const transport = new OmpRpcTransport({ logPrefix: "[omp-process]", ...this.transportOptions });
    this.transport = transport;
    reservation?.holdUntil(transport.exited);
    const exitForThisChild = this.exitDeferred;
    transport.on("frame", (frame) => {
      if (transport === this.transport) this.handleFrame(frame);
    });
    transport.on("negotiated", () => {
      if (transport === this.transport) void this.completeHandshake(transport);
    });
    transport.on("failed", (error) => {
      if (transport === this.transport) this.failStartup(transport, error);
    });
    transport.on("fatal", (error) => {
      if (transport === this.transport) this.fatalMessage = error.message;
    });
    transport.on("exit", (code) => {
      exitForThisChild.resolve(code);
      if (transport === this.transport) this.handleTransportExit(code);
    });

    const additionalDirectories = this.startOptions?.additionalDirectories ?? [];
    console.log(
      `[omp-process] Starting omp (cwd: ${this.cwd}, approval: ${approvalModeFor(this._executionMode)}, model: ${spec.model ?? "default"}, resume: ${spec.resumeSessionFile ? "yes" : "no"})`,
    );
    transport.start(
      buildOmpSpawnSpec(
        {
          cwd: this.cwd,
          approvalMode: approvalModeFor(this._executionMode),
          overlayPath: this.overlayPath,
          ...(spec.model ? { model: spec.model } : {}),
          ...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
          additionalDirectories,
          ...(spec.resumeSessionFile ? { resumeSessionFile: spec.resumeSessionFile } : {}),
        },
        this.env,
      ),
    );
  }

  private async completeHandshake(transport: OmpRpcTransport): Promise<void> {
    try {
      await transport.request({ type: "set_interrupt_mode", mode: "wait" }, { immediate: true });
    } catch (err) {
      console.warn(`[omp-process] set_interrupt_mode failed: ${errorMessage(err)}`);
    }
    let state: unknown;
    try {
      state = await transport.request({ type: "get_state" }, { immediate: true });
    } catch (err) {
      if (transport !== this.transport || this.lifecycle !== "starting") return;
      this.failStartup(
        transport,
        ompError("omp_start_failed", `omp did not report its state: ${errorMessage(err)}`),
      );
      return;
    }
    if (transport !== this.transport || this.lifecycle !== "starting") return;

    this.applyState(state);
    this.registerWriter();
    const wasRespawn = this.respawning;
    this.respawning = false;
    this.lifecycle = "ready";
    transport.openOutbox();
    for (const deferredCommand of this.deferredCommands.splice(0)) deferredCommand.run();
    this.emitInit();
    if (wasRespawn) {
      this.emitMessage({
        type: "system",
        subtype: "set_permission_mode",
        provider: "omp",
        ...this.sessionIdField(),
        permissionMode: this.permissionMode,
        executionMode: this._executionMode,
      });
    }
    this.resolveReadiness();
    this.refreshStatus();
  }

  private applyState(state: unknown): void {
    if (!isRecord(state)) return;
    if (typeof state.sessionId === "string" && state.sessionId) this._sessionId = state.sessionId;
    this._sessionFile =
      typeof state.sessionFile === "string" && state.sessionFile ? state.sessionFile : null;
    if (isRecord(state.model)) this.applyModel(state.model);
    this._settings = {
      ...(this._settings.model ? { model: this._settings.model } : {}),
      ...(isOmpThinkingLevel(state.thinkingLevel) ? { thinkingLevel: state.thinkingLevel } : {}),
    };
    if (typeof state.isSettled === "boolean") this.settled = state.isSettled;
  }

  private applyModel(model: JsonRecord): void {
    const selector = modelSelector(model);
    if (selector) this._settings = { ...this._settings, model: selector };
    this._thinkingLevels = ompThinkingLevelsFor(model.thinking);
  }

  private registerWriter(): void {
    if (!this._sessionFile || !this.transport || !this._sessionId) return;
    this.writers.register(this._sessionFile, {
      owner: this.ownerId(),
      sessionId: this._sessionId,
      exited: this.transport.exited,
    });
    this.registeredFile = this._sessionFile;
  }

  private ownerId(): string {
    return this.startOptions?.bridgeSessionId ?? "omp";
  }

  private emitInit(): void {
    this.initEmitted = true;
    this.emitMessage({
      type: "system",
      subtype: "init",
      provider: "omp",
      ...this.sessionIdField(),
      ...(this._settings.model ? { model: this._settings.model } : {}),
      ...(this._settings.thinkingLevel ? { thinkingLevel: this._settings.thinkingLevel } : {}),
      thinkingLevels: [...this._thinkingLevels],
      executionMode: this._executionMode,
      permissionMode: this.permissionMode,
    });
    if (this.pendingCommands) {
      const commands = this.pendingCommands;
      this.pendingCommands = null;
      this.emitSupportedCommands(commands);
    }
  }

  // ---- failures, exit, stop ----

  private failBeforeSpawn(error: OmpCodedError): void {
    if (this.lifecycle === "exited") return;
    const wasRespawn = this.respawning;
    this.respawning = false;
    this.startupFailure = error;
    const reported = wasRespawn
      ? ompError("omp_respawn_failed", `omp could not be restarted: ${error.message}`)
      : error;
    this.lifecycle = "exited";
    this.emitMessage({ type: "error", errorCode: reported.code, message: reported.message });
    this.rejectReadiness(reported);
    this.clearRunState();
    this.rejectPendingModelChange(
      ompError("omp_process_exited", "The omp process is not running."),
    );
    this.refreshStatus();
    this.exitDeferred.resolve(null);
    this.emit("exit", null);
  }

  private failStartup(transport: OmpRpcTransport, error: OmpCodedError): void {
    if (this.lifecycle !== "starting") return;
    const wasRespawn = this.respawning;
    this.respawning = false;
    const reported = wasRespawn
      ? ompError("omp_respawn_failed", `omp could not be restarted: ${error.message}`)
      : error;
    this.startupFailure = reported;
    this.lifecycle = "closing";
    this.emitMessage({ type: "error", errorCode: reported.code, message: reported.message });
    this.rejectReadiness(reported);
    this.refreshStatus();
    if (!transport.hasExited) this.shutdownTransport(transport);
  }

  private finishWithoutChild(): void {
    this.lifecycle = "exited";
    this.clearRunState();
    this.refreshStatus();
    this.exitDeferred.resolve(null);
    this.emit("exit", null);
  }

  private handleTransportExit(code: number | null): void {
    const lifecycle = this.lifecycle;
    const transport = this.transport;
    for (const timer of this.stopTimers.splice(0)) clearTimeout(timer);
    if (lifecycle === "starting") {
      // Exit after negotiation but before the handshake finished.
      const tail = transport?.stderrTail;
      const detail = `omp exited before it was ready (code ${code ?? "null"})${tail ? `: ${tail}` : ""}`;
      const reported = this.respawning
        ? ompError("omp_respawn_failed", `omp could not be restarted: ${detail}`)
        : ompError("omp_start_failed", detail);
      this.respawning = false;
      this.startupFailure = reported;
      this.emitMessage({ type: "error", errorCode: reported.code, message: reported.message });
    } else if (lifecycle === "ready") {
      // Unexpected exit after the handshake.
      const tail = transport?.stderrTail;
      const detail = this.fatalMessage ?? `omp exited unexpectedly (code ${code ?? "null"})`;
      this.cancelAllDialogs(null);
      this.emitMessage({
        type: "error",
        errorCode: "omp_process_exited",
        message: tail ? `${detail}: ${tail}` : detail,
      });
    }
    this.lifecycle = "exited";
    this.clearRunState();
    this.rejectPendingModelChange(ompError("omp_process_exited", "The omp process exited."));
    this.rejectReadiness(
      this.startupFailure ?? ompError("omp_process_exited", "The omp process exited."),
    );
    this.refreshStatus();
    this.emit("exit", code);
  }

  /** Close stdin, keep reading until exit, SIGTERM after 5 s, SIGKILL after 10 s. */
  private shutdownTransport(transport: OmpRpcTransport): void {
    transport.endInput();
    const term = setTimeout(() => transport.kill("SIGTERM"), STOP_SIGTERM_MS);
    const kill = setTimeout(() => transport.kill("SIGKILL"), STOP_SIGKILL_MS);
    const clear = () => {
      clearTimeout(term);
      clearTimeout(kill);
    };
    transport.exited.then(clear, clear);
    this.stopTimers.push(term, kill);
  }

  private startRespawn(): void {
    const mode = this.pendingApprovalMode;
    const old = this.transport;
    if (!mode || !old || this.lifecycle !== "ready") return;
    this.pendingApprovalMode = null;
    this._executionMode = mode;
    this.respawning = true;
    this.lifecycle = "starting";
    this.readiness = "pending";
    this.readinessError = null;
    this.cancelAllDialogs(old);
    this.refreshStatus();
    const previousExit = old.exited;
    // Detach the old child: its exit must not end this session.
    this.transport = null;
    this.exitDeferred = deferred();
    this.shutdownTransport(old);
    void previousExit.then(() => {
      if (this.lifecycle !== "starting" || !this.respawning) {
        if (this.lifecycle === "closing") this.finishWithoutChild();
        return;
      }
      const file = this._sessionFile && existsSync(this._sessionFile) ? this._sessionFile : undefined;
      if (!file) {
        // Nothing was persisted yet: omp starts a new session with the same settings.
        this.entryCursor = null;
        this.backfillStopped = false;
      }
      void this.launch({
        resumeSessionFile: file,
        ...(file ? {} : { model: this._settings.model, thinkingLevel: this._settings.thinkingLevel }),
      });
    });
  }

  private clearRunState(): void {
    this.pendingPrompts.clear();
    this.runLive = false;
    this.runAgentInitiated = false;
    this.compacting = false;
    this.dropDeferredCommands("The omp process exited.");
    for (const dialog of this.dialogs.values()) {
      if (dialog.kind === "dialog" && dialog.timer) clearTimeout(dialog.timer);
    }
    this.dialogs.clear();
    for (const ask of this.askStates.values()) this.clearAskTimer(ask);
    this.askStates.clear();
  }

  private reportExitedWrite(): void {
    if (this.exitedWriteReported) return;
    this.exitedWriteReported = true;
    this.emitMessage({
      type: "error",
      errorCode: "omp_process_exited",
      message: "The omp session has ended. Resume it to continue.",
    });
  }

  // ---- readiness ----

  private resolveReadiness(): void {
    this.readiness = "ready";
    for (const waiter of this.readinessWaiters.splice(0)) waiter.resolve();
  }

  private rejectReadiness(error: OmpCodedError): void {
    this.readiness = "failed";
    this.readinessError = error;
    for (const waiter of this.readinessWaiters.splice(0)) waiter.reject(error);
  }

  // ---- commands ----

  /** Send a command now when ready, after the handshake when starting. */
  private command(
    frame: JsonRecord,
    options: { timeoutMs?: number | null; onId?: (id: string) => void } = {},
  ): Promise<unknown> {
    const send = (transport: OmpRpcTransport) => {
      const promise = transport.request(frame, { timeoutMs: options.timeoutMs });
      options.onId?.(transport.lastRequestId);
      return promise;
    };
    if (this.lifecycle === "ready" && this.transport) return send(this.transport);
    if (this.lifecycle === "starting") {
      return new Promise((resolve, reject) => {
        this.deferredCommands.push({
          run: () => {
            if (!this.transport) {
              reject(ompError("omp_process_exited", "The omp process is not running."));
              return;
            }
            send(this.transport).then(resolve, reject);
          },
          reject,
        });
      });
    }
    return Promise.reject(ompError("omp_process_exited", "The omp process is not running."));
  }

  /** Reject every command queued while starting (stop, failed start or respawn). */
  private dropDeferredCommands(message: string): void {
    for (const deferredCommand of this.deferredCommands.splice(0)) {
      deferredCommand.reject(ompError("omp_process_exited", message));
    }
  }

  private notifyUi(dialogId: string, response: JsonRecord): void {
    this.transport?.notify({ type: "extension_ui_response", id: dialogId, ...response });
  }

  // ---- status (§2.5) ----

  private deriveStatus(): ProcessStatus {
    if (this.lifecycle === "new" || this.lifecycle === "starting") return "starting";
    if (this.lifecycle !== "ready") return "idle";
    if (this.hasOpenDialogs()) return "waiting_approval";
    if (this.compacting) return "compacting";
    if (this.pendingPrompts.size > 0 || this.runLive) return "running";
    return "idle";
  }

  private hasOpenDialogs(): boolean {
    if (this.dialogs.size > 0) return true;
    for (const ask of this.askStates.values()) if (isAskOpen(ask)) return true;
    return false;
  }

  private refreshStatus(): void {
    const next = this.deriveStatus();
    if (next === this._status) return;
    this._status = next;
    this.emit("status", next);
    this.emitMessage({ type: "status", status: next });
    if (next === "idle" && this.lifecycle === "ready") this.onBecameIdle();
  }

  /**
   * Into idle: apply a pending model change first, then a pending approval
   * mode (respawn), then start the uuid backfill and drain the queue.
   */
  private onBecameIdle(): void {
    // Every frame of a run precedes its prompt_result, so nothing is in flight.
    this.calls = [];
    this.startedArgs.clear();
    this.heldTodos.clear();
    for (const [toolCallId, ask] of this.askStates) {
      if (!isAskOpen(ask)) {
        this.clearAskTimer(ask);
        this.askStates.delete(toolCallId);
      }
    }
    if (this.pendingModelChange && !this.modelChangeInFlight) {
      void this.applyPendingModelChange();
      return;
    }
    if (this.modelChangeInFlight) return;
    this.continueIdleWork();
  }

  private continueIdleWork(): void {
    if (!this.isWaitingForInput) return;
    if (this.pendingApprovalMode && this.settled) {
      this.startRespawn();
      return;
    }
    void this.backfillUserEntries();
    this.emit("input_ready");
  }

  // ---- frames (§3.1) ----

  private handleFrame(frame: JsonRecord): void {
    const type = typeof frame.type === "string" ? frame.type : "";
    switch (type) {
      case "agent_start":
        this.runLive = true;
        this.settled = false;
        if (this.pendingPrompts.size === 0) {
          this.runAgentInitiated = true;
          this.stats = emptyStats();
        } else {
          this.runAgentInitiated = false;
        }
        this.refreshStatus();
        return;
      case "agent_end":
        this.handleAgentEnd(frame);
        return;
      case "turn_start":
      case "turn_end":
        return;
      case "message_start":
        if (isRecord(frame.message) && frame.message.role === "assistant") {
          this.currentAssistantMessageId =
            typeof frame.messageId === "string" ? frame.messageId : null;
        }
        return;
      case "message_update":
        this.handleMessageUpdate(frame);
        return;
      case "message_end":
        this.handleMessageEnd(frame);
        return;
      case "tool_execution_start":
        this.handleToolStart(frame);
        return;
      case "tool_execution_update":
      case "tool_stream_update":
        return;
      case "tool_execution_end":
        this.handleToolEnd(frame);
        return;
      case "prompt_result":
        this.handlePromptResult(frame);
        return;
      case "session_settled":
        this.settled = true;
        if (this.isWaitingForInput && this.pendingApprovalMode && !this.modelChangeInFlight) {
          this.startRespawn();
        }
        return;
      case "auto_compaction_start":
        this.compacting = true;
        this.refreshStatus();
        return;
      case "auto_compaction_end":
        this.compacting = false;
        if (frame.skipped !== true && (frame.aborted === true || typeof frame.errorMessage === "string")) {
          this.emitNotice(
            typeof frame.errorMessage === "string" && frame.errorMessage
              ? `Compaction failed: ${frame.errorMessage}`
              : "Compaction was aborted",
          );
        }
        this.refreshStatus();
        return;
      case "auto_retry_start":
        this.emitNotice(
          `Retrying (${numberText(frame.attempt)}/${numberText(frame.maxAttempts)}) in ${
            typeof frame.delayMs === "number" ? Math.round(frame.delayMs / 100) / 10 : "?"
          }s: ${String(frame.errorMessage ?? "")}`,
        );
        return;
      case "auto_retry_end":
      case "retry_fallback_succeeded":
        return;
      case "retry_fallback_applied": {
        const to = typeof frame.to === "string" ? frame.to : undefined;
        this.emitNotice(`Model fallback: ${String(frame.from ?? "?")} → ${to ?? "?"}`);
        if (to) {
          this._settings = { ...this._settings, model: to };
          this.emitSettings();
        }
        return;
      }
      case "model_changed":
        if (!this.suppressModelChanged) void this.refreshSettingsFromState();
        return;
      case "config_update":
        if (isRecord(frame.model)) this.applyModel(frame.model);
        this._settings = {
          ...(this._settings.model ? { model: this._settings.model } : {}),
          ...(isOmpThinkingLevel(frame.thinkingLevel) ? { thinkingLevel: frame.thinkingLevel } : {}),
        };
        this.emitSettings();
        return;
      case "thinking_level_changed":
        this.handleThinkingLevelChanged(frame);
        return;
      case "session_info_update":
        if (typeof frame.title === "string" && frame.title.trim()) {
          this.emit("session_name", frame.title);
        }
        return;
      case "available_commands_update":
        this.handleAvailableCommands(frame);
        return;
      case "command_output":
        if (typeof frame.text === "string") {
          const text = frame.text.replace(ANSI_ESCAPE_RE, "").trim();
          if (text) this.emitAssistant([{ type: "text", text }]);
        }
        return;
      case "notice":
        if (frame.level === "warning" || frame.level === "error") {
          this.emitNotice(String(frame.message ?? ""));
        }
        return;
      case "extension_error":
        this.emitNotice(
          `Extension ${String(frame.extensionPath ?? "?")} failed in ${String(frame.event ?? "?")}: ${String(frame.error ?? "")}`,
        );
        return;
      case "extension_ui_request":
        this.handleUiRequest(frame);
        return;
      case "rpc_frame_error":
        this.handleFrameError(frame);
        return;
      case "subagent_lifecycle":
      case "subagent_progress":
      case "subagent_event":
      case "ttsr_triggered":
      case "todo_reminder":
      case "todo_auto_clear":
      case "irc_message":
      case "advisor_cost_changed":
      case "advisor_yielded":
      case "config_warnings_changed":
      case "goal_updated":
        return;
      default:
        if (type.startsWith("host_tool_") || type.startsWith("host_uri_")) {
          console.log(`[omp-process] ignored ${type} (no host tools registered)`);
          return;
        }
        if (!this.loggedUnknownTypes.has(type)) {
          this.loggedUnknownTypes.add(type);
          console.log(`[omp-process] ignored unknown frame type: ${type || "(none)"}`);
        }
    }
  }

  private handleAgentEnd(frame: JsonRecord): void {
    // omp's own yield rule: older sessions omit `yielded`, only terminal ends were yields.
    const yielded =
      typeof frame.yielded === "boolean" ? frame.yielded : frame.isTerminal !== false;
    if (!yielded) return;
    this.runLive = false;
    if (this.runAgentInitiated && this.pendingPrompts.size === 0) {
      this.emitRunResult(runStatusFromStopReason(this.stats.lastStopReason), this.stats);
      this.stats = emptyStats();
    }
    this.runAgentInitiated = false;
    this.refreshStatus();
  }

  private handleMessageUpdate(frame: JsonRecord): void {
    const event = isRecord(frame.assistantMessageEvent) ? frame.assistantMessageEvent : undefined;
    if (!event || typeof event.delta !== "string" || !event.delta) return;
    if (event.type === "text_delta") {
      const id = typeof frame.messageId === "string" ? frame.messageId : "";
      this.streamedText.set(id, (this.streamedText.get(id) ?? "") + event.delta);
      this.emitMessage({ type: "stream_delta", text: event.delta });
    } else if (event.type === "thinking_delta") {
      this.emitMessage({ type: "thinking_delta", text: event.delta });
    }
  }

  private handleMessageEnd(frame: JsonRecord): void {
    const message = isRecord(frame.message) ? frame.message : undefined;
    if (!message || message.role !== "assistant") return;
    const messageId = typeof frame.messageId === "string" ? frame.messageId : "";
    this.streamedText.delete(messageId);
    if (this.currentAssistantMessageId === messageId) this.currentAssistantMessageId = null;

    const usage = isRecord(message.usage) ? message.usage : undefined;
    if (usage) {
      this.stats.cost += numberOr0(isRecord(usage.cost) ? usage.cost.total : undefined);
      this.stats.input += numberOr0(usage.input);
      this.stats.cacheRead += numberOr0(usage.cacheRead);
      this.stats.output += numberOr0(usage.output);
    }
    if (typeof message.stopReason === "string") this.stats.lastStopReason = message.stopReason;
    if (typeof message.errorMessage === "string") this.stats.lastErrorMessage = message.errorMessage;

    const content: AssistantContent[] = [];
    const texts: string[] = [];
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        content.push({ type: "text", text: block.text });
        texts.push(block.text);
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        content.push({ type: "thinking", thinking: block.thinking });
      } else if (block.type === "toolCall" && typeof block.id === "string") {
        const call = this.recordCall(block);
        if (call.name === "todo") {
          // The todo card is built from the result's full state (§3.3).
          this.heldTodos.set(call.toolCallId, call);
          continue;
        }
        content.push({
          type: "tool_use",
          id: call.toolCallId,
          name: canonicalToolName(call.name, call.args),
          input: canonicalToolInput(call.name, call.args, call.intent),
        });
      }
    }
    if (texts.length > 0) this.stats.lastText = texts.join("\n");
    if (content.length === 0) return;
    this.emitAssistant(content, messageModel(message) ?? this._settings.model);
  }

  private recordCall(block: JsonRecord): ToolCallRecord {
    const call: ToolCallRecord = {
      toolCallId: String(block.id),
      name: ompInternalToolName(String(block.name ?? "")),
      args: stripOmpIntent(block.arguments),
      intent: ompCallIntent(block.intent, block.arguments),
      approvalDialogId: null,
      ended: false,
    };
    this.calls.push(call);
    if (call.name === "ask" && !this.askStates.has(call.toolCallId)) {
      this.askStates.set(call.toolCallId, newAskState(call.toolCallId, ompAskQuestions(call.args)));
    }
    return call;
  }

  private handleToolStart(frame: JsonRecord): void {
    const toolCallId = typeof frame.toolCallId === "string" ? frame.toolCallId : undefined;
    if (!toolCallId) return;
    const name = ompInternalToolName(String(frame.toolName ?? ""));
    const args = stripOmpIntent(frame.args);
    this.startedArgs.set(toolCallId, { name, args });
    if (name === "ask" && !this.askStates.has(toolCallId)) {
      this.askStates.set(toolCallId, newAskState(toolCallId, ompAskQuestions(args)));
    }
  }

  private handleToolEnd(frame: JsonRecord): void {
    const toolCallId = typeof frame.toolCallId === "string" ? frame.toolCallId : undefined;
    if (!toolCallId) return;
    const call = this.calls.find((entry) => entry.toolCallId === toolCallId);
    const started = this.startedArgs.get(toolCallId);
    this.startedArgs.delete(toolCallId);
    const name = call?.name ?? started?.name ?? ompInternalToolName(String(frame.toolName ?? ""));
    const args = call?.args ?? started?.args ?? {};
    const isError = frame.isError === true;
    if (call) {
      call.ended = true;
      this.unbindOpenApproval(call);
    }
    const ask = this.askStates.get(toolCallId);
    if (ask) {
      this.resolveAsk(ask);
      this.clearAskTimer(ask);
      this.askStates.delete(toolCallId);
    }
    this.stats.toolCalls += 1;
    if (!isError && (name === "edit" || name === "write")) this.stats.fileEdits += 1;

    if (name === "todo") {
      const held = this.heldTodos.get(toolCallId);
      this.heldTodos.delete(toolCallId);
      const phases = isError ? null : ompTodoPhases(isRecord(frame.result) ? frame.result.details : undefined);
      if (phases) {
        this.emitAssistant([
          { type: "tool_use", id: toolCallId, name: "TodoWrite", input: ompTodoWriteInput(phases) },
        ]);
      } else if (held) {
        this.emitAssistant([
          { type: "tool_use", id: toolCallId, name: "todo", input: canonicalToolInput("todo", held.args, held.intent) },
        ]);
      }
      this.emitMessage({
        type: "tool_result",
        toolUseId: toolCallId,
        toolName: phases ? "TodoWrite" : "todo",
        content: ompToolResultContent(name, args, frame.result),
      });
      this.refreshStatus();
      return;
    }

    const images = ompResultImageBlocks(frame.result);
    this.emitMessage({
      type: "tool_result",
      toolUseId: toolCallId,
      toolName: canonicalToolName(name, args),
      content: ompToolResultContent(name, args, frame.result),
      ...(images.length > 0 ? { rawContentBlocks: images } : {}),
    });
    this.refreshStatus();
  }

  private handlePromptResult(frame: JsonRecord): void {
    const id = typeof frame.id === "string" ? frame.id : undefined;
    if (frame.sessionSettled === true) this.settled = true;
    const prompt = [...this.pendingPrompts].find((entry) => entry.rpcId === id);
    if (!prompt) {
      console.log(`[omp-process] prompt_result for unknown prompt ${String(id)}`);
      this.refreshStatus();
      return;
    }
    this.pendingPrompts.delete(prompt);
    const status = frame.status === "aborted" || frame.status === "error" ? frame.status : "completed";
    const errorText =
      isRecord(frame.error) && typeof frame.error.message === "string" ? frame.error.message : undefined;
    if (frame.agentInvoked === false) {
      if (status === "error") {
        this.emitMessage({
          type: "result",
          subtype: "error",
          error: errorText ?? "omp could not run the prompt",
          ...this.sessionIdField(),
        });
      } else if (status === "aborted") {
        this.emitMessage({ type: "result", subtype: "interrupted", ...this.sessionIdField() });
      } else {
        this.emitMessage({ type: "result", subtype: "success", ...this.sessionIdField() });
      }
    } else {
      const stats = { ...this.stats, startedAt: prompt.acceptedAt ?? prompt.sentAt };
      this.emitRunResult(status, stats, errorText);
    }
    this.stats = emptyStats();
    this.refreshStatus();
  }

  private emitRunResult(
    status: "completed" | "aborted" | "error",
    stats: RunStats,
    errorText?: string,
  ): void {
    if (status === "aborted") {
      this.emitMessage({ type: "result", subtype: "interrupted", ...this.sessionIdField() });
      return;
    }
    if (status === "error") {
      this.emitMessage({
        type: "result",
        subtype: "error",
        error: errorText ?? stats.lastErrorMessage ?? "omp reported an error",
        ...(stats.lastStopReason ? { stopReason: stats.lastStopReason } : {}),
        ...this.sessionIdField(),
      });
      return;
    }
    this.emitMessage({
      type: "result",
      subtype: "success",
      ...this.sessionIdField(),
      ...(stats.lastText ? { result: stats.lastText } : {}),
      cost: stats.cost,
      duration: Math.max(0, Date.now() - stats.startedAt),
      ...(stats.lastStopReason ? { stopReason: stats.lastStopReason } : {}),
      inputTokens: stats.input,
      cachedInputTokens: stats.cacheRead,
      outputTokens: stats.output,
      toolCalls: stats.toolCalls,
      fileEdits: stats.fileEdits,
    });
  }

  private handleFrameError(frame: JsonRecord): void {
    const originalType = String(frame.originalType ?? "");
    if (originalType === "tool_execution_end") {
      // The oldest started, unended call; one whose approval is still open
      // cannot have ended (see unbindOpenApproval), so it comes after others.
      const unended = this.calls.filter((entry) => !entry.ended);
      const started = unended.filter((entry) => this.startedArgs.has(entry.toolCallId));
      const awaitsApproval = (entry: ToolCallRecord) =>
        entry.approvalDialogId !== null && this.dialogs.has(entry.approvalDialogId);
      const call = started.find((entry) => !awaitsApproval(entry)) ?? started[0] ?? unended[0];
      if (call) {
        call.ended = true;
        this.startedArgs.delete(call.toolCallId);
        this.unbindOpenApproval(call);
        this.emitMessage({
          type: "tool_result",
          toolUseId: call.toolCallId,
          toolName: canonicalToolName(call.name, call.args),
          content: "omp could not deliver this tool result (over 64 MiB)",
        });
      }
      this.refreshStatus();
      return;
    }
    if (originalType === "message_end") {
      const id = this.currentAssistantMessageId ?? "";
      const text = this.streamedText.get(id);
      this.streamedText.delete(id);
      this.currentAssistantMessageId = null;
      if (text) {
        this.stats.lastText = text;
        this.emitAssistant([{ type: "text", text }]);
      }
      return;
    }
    this.emitNotice(`omp dropped an oversized ${originalType || "unknown"} frame`);
  }

  private handleThinkingLevelChanged(frame: JsonRecord): void {
    const level = isOmpThinkingLevel(frame.thinkingLevel) ? frame.thinkingLevel : undefined;
    this._settings = {
      ...(this._settings.model ? { model: this._settings.model } : {}),
      ...(level ? { thinkingLevel: level } : {}),
    };
    if (this.thinkingEcho) {
      this.thinkingEcho.seen = true;
      this.thinkingEcho.level = level;
      return;
    }
    this.emitSettings();
  }

  private async refreshSettingsFromState(): Promise<void> {
    if (await this.readSettingsFromState("model_changed")) this.emitSettings();
  }

  /** Update model and thinking level from `get_state`; false when it failed. */
  private async readSettingsFromState(reason: string): Promise<boolean> {
    try {
      const state = await this.command({ type: "get_state" });
      if (isRecord(state) && isRecord(state.model)) this.applyModel(state.model);
      if (isRecord(state)) {
        this._settings = {
          ...(this._settings.model ? { model: this._settings.model } : {}),
          ...(isOmpThinkingLevel(state.thinkingLevel) ? { thinkingLevel: state.thinkingLevel } : {}),
        };
      }
      return true;
    } catch (err) {
      console.warn(`[omp-process] get_state after ${reason} failed: ${errorMessage(err)}`);
      return false;
    }
  }

  private handleAvailableCommands(frame: JsonRecord): void {
    const commands = Array.isArray(frame.commands)
      ? frame.commands.flatMap((command) =>
          isRecord(command) && typeof command.name === "string" && command.name
            ? [command.name.replace(/^\//, "")]
            : [],
        )
      : [];
    if (!this.initEmitted) {
      this.pendingCommands = commands;
      return;
    }
    this.emitSupportedCommands(commands);
  }

  private emitSupportedCommands(commands: string[]): void {
    this.emitMessage({
      type: "system",
      subtype: "supported_commands",
      provider: "omp",
      ...this.sessionIdField(),
      slashCommands: commands,
    });
  }

  // ---- model change (§7.2) ----

  private async applyPendingModelChange(): Promise<void> {
    const request = this.pendingModelChange;
    if (!request) return;
    this.pendingModelChange = null;
    this.modelChangeInFlight = true;
    let releaseBarrier!: () => void;
    this.modelChangeBarrier = new Promise((resolve) => {
      releaseBarrier = resolve;
    });
    try {
      await this.applyModelSettings(request.settings);
      request.resolve();
    } catch (err) {
      request.reject(
        ompErrorCode(err) === "omp_process_exited"
          ? (err as Error)
          : ompError("set_omp_model_failed", errorMessage(err)),
      );
    } finally {
      this.modelChangeInFlight = false;
      this.modelChangeBarrier = null;
      releaseBarrier();
    }
    if (this.pendingModelChange && this.isWaitingForInput) {
      void this.applyPendingModelChange();
      return;
    }
    this.continueIdleWork();
  }

  private async applyModelSettings(settings: OmpSettings): Promise<void> {
    const previousLevel = this._settings.thinkingLevel;
    const modelChanges = !!settings.model && settings.model !== this._settings.model;
    if (modelChanges && settings.model) {
      const slash = settings.model.indexOf("/");
      if (slash <= 0 || slash === settings.model.length - 1) {
        throw new Error(`Invalid omp model selector: ${settings.model}`);
      }
      let model: unknown;
      this.suppressModelChanged = true;
      try {
        model = await this.command({
          type: "set_model",
          provider: settings.model.slice(0, slash),
          modelId: settings.model.slice(slash + 1),
        });
      } finally {
        this.suppressModelChanged = false;
      }
      if (isRecord(model)) this.applyModel(model);
      else this._settings = { ...this._settings, model: settings.model };
      // The level disappears for a non-reasoning model and stays absent after
      // switching back, so it is always set again (OBSERVED P10/V5).
      const wanted = settings.thinkingLevel ?? previousLevel;
      const target =
        wanted && this._thinkingLevels.includes(wanted)
          ? wanted
          : this._thinkingLevels.filter((level) => level !== "off").at(-1) ?? "off";
      try {
        await this.setThinkingLevel(target);
      } catch (err) {
        // omp already runs the new model: report it before the rejection, so
        // the app does not roll back to a model omp no longer uses.
        await this.emitSettingsAfterPartialChange();
        throw err;
      }
    } else if (settings.thinkingLevel) {
      await this.setThinkingLevel(settings.thinkingLevel);
    }
    this.emitSettings();
  }

  /**
   * `set_model` succeeded but `set_thinking_level` failed, so the level omp
   * kept is unknown (it can drop the level on a model switch, OBSERVED P10).
   * Read it back once, then emit what omp reports.
   */
  private async emitSettingsAfterPartialChange(): Promise<void> {
    if (this.lifecycle === "ready") await this.readSettingsFromState("a failed set_thinking_level");
    this.emitSettings();
  }

  private async setThinkingLevel(level: OmpThinkingLevel): Promise<void> {
    const echo: { seen: boolean; level: OmpThinkingLevel | undefined } = {
      seen: false,
      level: undefined,
    };
    this.thinkingEcho = echo;
    try {
      await this.command({ type: "set_thinking_level", level });
      // omp maps unsupported levels silently; thinking_level_changed carries
      // the level actually applied (OBSERVED V1).
      const applied = echo.seen ? echo.level : level;
      this._settings = {
        ...(this._settings.model ? { model: this._settings.model } : {}),
        ...(applied ? { thinkingLevel: applied } : {}),
      };
    } finally {
      this.thinkingEcho = null;
    }
  }

  private rejectPendingModelChange(error: Error): void {
    const pending = this.pendingModelChange;
    this.pendingModelChange = null;
    pending?.reject(error);
  }

  // ---- user uuid backfill (§6.6) ----

  private async backfillUserEntries(): Promise<void> {
    if (this.backfillStopped || this.lifecycle !== "ready") return;
    if (this.backfillInFlight) {
      this.backfillAgain = true;
      return;
    }
    this.backfillInFlight = true;
    try {
      const data = await this.command({
        type: "get_entries",
        ...(this.entryCursor ? { since: this.entryCursor } : {}),
      });
      const entries = isRecord(data) && Array.isArray(data.entries) ? data.entries.filter(isRecord) : [];
      const leafId = isRecord(data) && typeof data.leafId === "string" ? data.leafId : null;
      const last = entries.at(-1);
      if (last && typeof last.id === "string") this.entryCursor = last.id;
      const userEntries = newUserEntriesOnPath(entries, leafId);
      if (userEntries.length > 0) this.emit("user_entries", userEntries);
    } catch (err) {
      if (ompErrorCode(err) === "unknown_since") {
        this.backfillStopped = true;
        console.warn(
          "[omp-process] the entry cursor vanished; live messages stay non-rewindable until the next resume",
        );
      } else if (ompErrorCode(err) !== "omp_process_exited") {
        console.warn(`[omp-process] get_entries failed: ${errorMessage(err)}`);
      }
    } finally {
      this.backfillInFlight = false;
    }
    if (this.backfillAgain) {
      this.backfillAgain = false;
      void this.backfillUserEntries();
    }
  }

  // ---- dialogs (§4) ----

  private handleUiRequest(frame: JsonRecord): void {
    const method = String(frame.method ?? "");
    const dialogId = typeof frame.id === "string" ? frame.id : "";
    switch (method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
        if (!dialogId) return;
        this.handleDialogFrame(method, dialogId, frame);
        return;
      case "cancel":
        this.handleDialogCancel(typeof frame.targetId === "string" ? frame.targetId : "");
        return;
      case "notify": {
        const message = String(frame.message ?? "");
        if (!message) return;
        const warning = frame.notifyType === "warning" || frame.notifyType === "error";
        this.emitMessage({ type: "error", errorCode: warning ? "omp_notice" : "omp_info", message });
        return;
      }
      case "open_url": {
        const url = typeof frame.launchUrl === "string" && frame.launchUrl ? frame.launchUrl : frame.url;
        const instructions =
          typeof frame.instructions === "string" && frame.instructions ? `\n${frame.instructions}` : "";
        this.emitMessage({
          type: "error",
          errorCode: "omp_info",
          message: `omp asks to open ${String(url ?? "")}${instructions}`,
        });
        return;
      }
      default:
        // setStatus, setWidget, setTitle, set_editor_text: TUI-only.
        return;
    }
  }

  private handleDialogFrame(
    method: "select" | "confirm" | "input" | "editor",
    dialogId: string,
    frame: JsonRecord,
  ): void {
    const title = typeof frame.title === "string" ? frame.title : "";
    const options = Array.isArray(frame.options)
      ? frame.options.filter((option): option is string => typeof option === "string")
      : [];
    if (
      method === "select" &&
      options.length === APPROVAL_OPTIONS.length &&
      options.every((option, index) => option === APPROVAL_OPTIONS[index]) &&
      title.split("\n")[0].startsWith(APPROVAL_TITLE_PREFIX)
    ) {
      this.handleApprovalFrame(dialogId, title);
      return;
    }
    if (method === "select" || method === "editor") {
      const match = this.matchAskFrame(title);
      if (match) {
        this.handleAskFrame(match.state, {
          dialogId,
          method,
          questionIndex: match.questionIndex,
          options,
        }, frame);
        return;
      }
    }
    this.handleGenericDialog(method, dialogId, title, options, frame);
  }

  private handleApprovalFrame(dialogId: string, title: string): void {
    const lines = title.split("\n");
    const name = lines[0].slice(APPROVAL_TITLE_PREFIX.length).trim();
    const details = lines.slice(1);
    const reasonLine = details.find((line) => line.startsWith("Reason: "))?.slice("Reason: ".length);
    const hasSafetyChecks = details.some((line) => line.startsWith("Provider safety checks:"));
    const call = this.bindApproval(name, details, dialogId);
    const eligibleForAlways = reasonLine === undefined && !hasSafetyChecks;

    if (eligibleForAlways && this.alwaysAllowedTools.has(name)) {
      this.notifyUi(dialogId, { value: "Approve" });
      return;
    }

    const approvalDetails = [...details];
    if (call && call.name === "edit" && !isOmpReplaceEdit(call.args)) {
      const patch = ompEditPatchText(call.args);
      if (patch) {
        const patchLines = patch.replace(/\n+$/, "").split("\n");
        approvalDetails.push("Patch:", ...patchLines.slice(0, APPROVAL_PATCH_LINES));
        if (patchLines.length > APPROVAL_PATCH_LINES) approvalDetails.push("…");
      }
    }
    const toolUseId = call ? call.toolCallId : unboundApprovalId(dialogId);
    const payload: PermissionPayload = {
      type: "permission_request",
      toolUseId,
      toolName: canonicalToolName(name, call ? call.args : {}),
      input: {
        ...(call ? canonicalToolInput(name, call.args, call.intent) : {}),
        ...(reasonLine ? { reason: reasonLine } : {}),
        approvalDetails,
      },
    };
    this.dialogs.set(dialogId, {
      kind: "approval",
      dialogId,
      toolUseId,
      name,
      details,
      ...(reasonLine ? { reason: reasonLine } : {}),
      eligibleForAlways,
      payload,
    });
    this.emitMessage(payload);
    this.refreshStatus();
  }

  /**
   * Bind an approval to a tool call of the preceding assistant message, only
   * on positive evidence: the call's string arguments must appear in omp's
   * approval text. Inner `eval` calls and subagents raise approvals without a
   * call of their own; those stay unbound (§4.1).
   */
  private bindApproval(name: string, details: string[], dialogId: string): ToolCallRecord | null {
    const text = details.join("\n");
    let best: { call: ToolCallRecord; score: number; length: number } | null = null;
    for (const call of this.calls) {
      if (call.name !== name || call.ended || call.approvalDialogId !== null) continue;
      const values = new Set<string>();
      for (const value of Object.values(call.args)) {
        if (typeof value !== "string") continue;
        const trimmed = value.trim();
        if (trimmed) values.add(trimmed);
      }
      if (call.name === "edit") {
        for (const path of ompEditTargetPaths(call.args)) {
          const trimmed = path.trim();
          if (trimmed) values.add(trimmed);
        }
      }
      let score = 0;
      let length = 0;
      for (const value of values) {
        if (approvalTextHasValue(text, value)) {
          score += 1;
          length += value.length;
        }
      }
      if (score === 0) continue;
      // Ties go to call order; a longer match is more specific.
      if (!best || score > best.score || (score === best.score && length > best.length)) {
        best = { call, score, length };
      }
    }
    if (!best) return null;
    best.call.approvalDialogId = dialogId;
    return best.call;
  }

  private findApproval(toolUseId?: string): ApprovalDialog | undefined {
    for (const dialog of this.dialogs.values()) {
      if (dialog.kind !== "approval") continue;
      if (!toolUseId || dialog.toolUseId === toolUseId) return dialog;
    }
    return undefined;
  }

  private findDialogByToolUseId(toolUseId: string): GenericDialog | undefined {
    for (const dialog of this.dialogs.values()) {
      if (dialog.kind === "dialog" && dialog.toolUseId === toolUseId) return dialog;
    }
    return undefined;
  }

  private answerApproval(dialog: ApprovalDialog, value: "Approve" | "Deny"): void {
    this.dialogs.delete(dialog.dialogId);
    this.notifyUi(dialog.dialogId, { value });
    this.emitMessage({ type: "permission_resolved", toolUseId: dialog.toolUseId });
  }

  /**
   * A call ended while the approval bound to it is still open. omp awaits an
   * approval select without a timeout, so a call cannot end before its own
   * approval is answered: the binding was wrong (for example an inner `eval`
   * call). The dialog stays open, now unbound, so answering, interrupt and
   * stop still reach it.
   */
  private unbindOpenApproval(call: ToolCallRecord): void {
    const dialogId = call.approvalDialogId;
    if (!dialogId) return;
    const dialog = this.dialogs.get(dialogId);
    if (!dialog || dialog.kind !== "approval" || dialog.toolUseId !== call.toolCallId) return;
    this.emitMessage({ type: "permission_resolved", toolUseId: dialog.toolUseId });
    dialog.toolUseId = unboundApprovalId(dialogId);
    dialog.payload = {
      type: "permission_request",
      toolUseId: dialog.toolUseId,
      toolName: canonicalToolName(dialog.name, {}),
      input: {
        ...(dialog.reason ? { reason: dialog.reason } : {}),
        approvalDetails: [...dialog.details],
      },
    };
    this.emitMessage(dialog.payload);
  }

  private handleGenericDialog(
    method: "select" | "confirm" | "input" | "editor",
    dialogId: string,
    title: string,
    options: string[],
    frame: JsonRecord,
  ): void {
    const question: JsonRecord = { id: dialogId, multiSelect: false };
    switch (method) {
      case "select": {
        const optionDetails = Array.isArray(frame.optionDetails) ? frame.optionDetails : [];
        question.question = title;
        question.options = options.map((label, index) => {
          const detail = optionDetails[index];
          return isRecord(detail) && typeof detail.description === "string" && detail.description
            ? { label, description: detail.description }
            : { label };
        });
        break;
      }
      case "confirm": {
        const message = typeof frame.message === "string" ? frame.message : "";
        question.question = message ? `${title}\n\n${message}` : title;
        question.options = [{ label: "Yes" }, { label: "No" }];
        break;
      }
      case "input":
        question.question = title;
        if (typeof frame.placeholder === "string" && frame.placeholder) {
          question.header = frame.placeholder;
        }
        question.options = [];
        break;
      case "editor": {
        const prefill = typeof frame.prefill === "string" ? frame.prefill : "";
        question.question = prefill ? `${title}\n\n${prefill}` : title;
        question.options = [];
        break;
      }
    }
    const payload: PermissionPayload = {
      type: "permission_request",
      toolUseId: `omp-dialog:${dialogId}`,
      toolName: "AskUserQuestion",
      input: { questions: [question] },
    };
    const dialog: GenericDialog = {
      kind: "dialog",
      dialogId,
      toolUseId: payload.toolUseId,
      method,
      options,
      payload,
    };
    const timeout = typeof frame.timeout === "number" && frame.timeout > 0 ? frame.timeout : 0;
    if (timeout) {
      dialog.timer = setTimeout(() => {
        if (this.dialogs.get(dialogId) !== dialog) return;
        this.dialogs.delete(dialogId);
        this.emitMessage({ type: "permission_resolved", toolUseId: dialog.toolUseId });
        this.emitNotice("omp answered the question after its timeout");
        this.refreshStatus();
      }, timeout);
    }
    this.dialogs.set(dialogId, dialog);
    this.emitMessage(payload);
    this.refreshStatus();
  }

  private respondToDialog(dialog: GenericDialog, response: JsonRecord): void {
    if (dialog.timer) clearTimeout(dialog.timer);
    this.dialogs.delete(dialog.dialogId);
    this.notifyUi(dialog.dialogId, response);
    this.emitMessage({ type: "permission_resolved", toolUseId: dialog.toolUseId });
  }

  private handleDialogCancel(targetId: string): void {
    const dialog = this.dialogs.get(targetId);
    if (dialog) {
      if (dialog.kind === "dialog" && dialog.timer) clearTimeout(dialog.timer);
      this.dialogs.delete(targetId);
      this.emitMessage({ type: "permission_resolved", toolUseId: dialog.toolUseId });
      this.refreshStatus();
      return;
    }
    for (const ask of this.askStates.values()) {
      if (ask.awaitingFrame?.dialogId !== targetId) continue;
      ask.awaitingFrame = undefined;
      this.clearAskTimer(ask);
      this.resolveAsk(ask);
      this.askStates.delete(ask.toolCallId);
      this.refreshStatus();
      return;
    }
  }

  /** Answer every open dialog with `{cancelled:true}` (interrupt, stop, respawn). */
  private cancelAllDialogs(transport: OmpRpcTransport | null): void {
    for (const dialog of [...this.dialogs.values()]) {
      if (dialog.kind === "dialog" && dialog.timer) clearTimeout(dialog.timer);
      this.dialogs.delete(dialog.dialogId);
      transport?.notify({ type: "extension_ui_response", id: dialog.dialogId, cancelled: true });
      this.emitMessage({ type: "permission_resolved", toolUseId: dialog.toolUseId });
    }
    for (const ask of this.askStates.values()) {
      if (ask.awaitingFrame) {
        transport?.notify({
          type: "extension_ui_response",
          id: ask.awaitingFrame.dialogId,
          cancelled: true,
        });
        ask.awaitingFrame = undefined;
      }
      this.clearAskTimer(ask);
      ask.rejected = true;
      this.resolveAsk(ask);
    }
  }

  // ---- ask (§4.3) ----

  private matchAskFrame(title: string): { state: AskState; questionIndex: number } | null {
    const normalized = normalizeAskTitle(title);
    for (const state of this.askStates.values()) {
      const indices = state.questions
        .map((question, index) => (question.question.trim() === normalized ? index : -1))
        .filter((index) => index >= 0);
      if (indices.length === 0) continue;
      const questionIndex = indices.find((index) => index >= state.cursor) ?? indices[0];
      return { state, questionIndex };
    }
    return null;
  }

  private handleAskFrame(state: AskState, frame: AskFrame, raw: JsonRecord): void {
    if (state.rejected) {
      // Declined before this frame arrived: cancelling aborts omp's turn (P2e).
      this.notifyUi(frame.dialogId, { cancelled: true });
      return;
    }
    state.cursor = frame.questionIndex;
    if (state.answers) {
      this.replayAskFrame(state, frame);
      return;
    }
    state.awaitingFrame = frame;
    const timeout = typeof raw.timeout === "number" && raw.timeout > 0 ? raw.timeout : 0;
    if (timeout) {
      this.clearAskTimer(state);
      state.timer = setTimeout(() => {
        if (state.awaitingFrame?.dialogId !== frame.dialogId) return;
        state.awaitingFrame = undefined;
        this.resolveAsk(state);
        this.emitNotice("omp answered the question after its timeout");
        this.refreshStatus();
      }, timeout);
    }
    if (!state.requestEmitted) {
      state.requestEmitted = true;
      this.emitMessage({
        type: "permission_request",
        toolUseId: state.toolCallId,
        toolName: "AskUserQuestion",
        input: askUserQuestionInput(state.questions),
      });
    }
    this.refreshStatus();
  }

  /** Answer one select/editor frame of an answered ask call (plan of §4.3 step 4). */
  private replayAskFrame(state: AskState, frame: AskFrame): void {
    const question = state.questions[frame.questionIndex];
    const values = state.answers?.[frame.questionIndex] ?? [];
    if (!question) {
      this.notifyUi(frame.dialogId, { cancelled: true });
      return;
    }
    const optionLabels = question.options.map((option) => option.label);
    const offered = optionLabels.filter((label) =>
      values.some((value) => stripRecommended(value) === stripRecommended(label)),
    );
    const free = values.filter(
      (value) => !optionLabels.some((label) => stripRecommended(label) === stripRecommended(value)),
    );

    if (frame.method === "editor") {
      const text = question.multiSelect
        ? [...offered, ...free].join(", ") || "(none)"
        : values[0] ?? "";
      this.notifyUi(frame.dialogId, { value: text });
      return;
    }

    const otherLabel = frame.options.find((option) => option === ASK_OTHER_LABEL);
    if (!question.multiSelect) {
      const wanted = values[0] ?? "";
      const label = frame.options.find(
        (option) => option !== ASK_OTHER_LABEL && stripRecommended(option) === stripRecommended(wanted),
      );
      this.notifyUi(frame.dialogId, { value: label ?? otherLabel ?? wanted });
      return;
    }

    let toggled = state.toggled.get(frame.questionIndex);
    if (!toggled) {
      toggled = new Set();
      state.toggled.set(frame.questionIndex, toggled);
    }
    const next = offered.find((label) => !toggled!.has(label));
    if (next) {
      toggled.add(next);
      const label = frame.options.find((option) => stripRecommended(option) === stripRecommended(next));
      this.notifyUi(frame.dialogId, { value: label ?? next });
      return;
    }
    const doneLabel = frame.options.find((option) => option.endsWith(ASK_DONE_SUFFIX));
    if (state.questions.length === 1 && offered.length > 0 && free.length === 0 && doneLabel) {
      this.notifyUi(frame.dialogId, { value: doneLabel });
      return;
    }
    // Several questions, free text or no selection: finish through the editor (V3).
    this.notifyUi(frame.dialogId, otherLabel ? { value: otherLabel } : { cancelled: true });
  }

  private rejectAsk(state: AskState): void {
    state.rejected = true;
    if (state.awaitingFrame) {
      this.notifyUi(state.awaitingFrame.dialogId, { cancelled: true });
      state.awaitingFrame = undefined;
    }
    this.clearAskTimer(state);
    this.resolveAsk(state);
  }

  private resolveAsk(state: AskState): void {
    if (state.requestEmitted && !state.resolved) {
      state.resolved = true;
      this.emitMessage({ type: "permission_resolved", toolUseId: state.toolCallId });
      return;
    }
    state.resolved = true;
  }

  private clearAskTimer(state: AskState): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
  }

  // ---- emit helpers ----

  private emitMessage(message: OmpProcessMessage): void {
    this.emit("message", message);
  }

  private emitAssistant(content: AssistantContent[], model?: string): void {
    this.emitMessage({
      type: "assistant",
      message: {
        id: `omp-msg-${randomUUID()}`,
        role: "assistant",
        content,
        model: model ?? this._settings.model ?? "",
      },
    });
  }

  private emitNotice(message: string): void {
    this.emitMessage({ type: "error", errorCode: "omp_notice", message });
  }

  private emitSettings(): void {
    const message: OmpSystemMessage = {
      type: "system",
      subtype: "omp_settings",
      provider: "omp",
      ...this.sessionIdField(),
      ...(this._settings.model ? { model: this._settings.model } : {}),
      ...(this._settings.thinkingLevel ? { thinkingLevel: this._settings.thinkingLevel } : {}),
      thinkingLevels: [...this._thinkingLevels],
    };
    this.emitMessage(message);
  }

  private sessionIdField(): { sessionId?: string } {
    return this._sessionId ? { sessionId: this._sessionId } : {};
  }
}

// ---- helpers ----

function emptyStats(): RunStats {
  return {
    startedAt: Date.now(),
    cost: 0,
    input: 0,
    cacheRead: 0,
    output: 0,
    toolCalls: 0,
    fileEdits: 0,
  };
}

function runStatusFromStopReason(stopReason: string | undefined): "completed" | "aborted" | "error" {
  if (stopReason === "error") return "error";
  if (stopReason === "aborted") return "aborted";
  return "completed";
}

function newAskState(toolCallId: string, questions: OmpAskQuestion[]): AskState {
  return {
    toolCallId,
    questions,
    toggled: new Map(),
    cursor: 0,
    requestEmitted: false,
    resolved: false,
    rejected: false,
  };
}

function isAskOpen(state: AskState): boolean {
  return state.requestEmitted && !state.resolved;
}

/**
 * First title line without the `(N selected) ` prefix and the ` (i/n)`
 * suffix (OBSERVED V3: the editor title carries both, then glyph rows).
 */
export function normalizeAskTitle(title: string): string {
  return title
    .split("\n")[0]
    .replace(/^\(\d+ selected\) /, "")
    .replace(/ \(\d+\/\d+\)$/, "")
    .trim();
}

function stripRecommended(label: string): string {
  return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
}

/**
 * Answer values per question from the app's `{answers: {<id or question>:
 * string | string[]}}` envelope, or a plain string for one question. Null
 * when nothing usable arrived or a single-choice question has no answer.
 */
export function parseAskAnswers(questions: OmpAskQuestion[], result: string): string[][] | null {
  let answerMap: JsonRecord | null = null;
  try {
    const parsed = JSON.parse(result) as unknown;
    if (isRecord(parsed) && isRecord(parsed.answers)) answerMap = parsed.answers;
  } catch {
    answerMap = null;
  }
  if (!answerMap) {
    const text = result.trim();
    if (questions.length !== 1 || !text) return null;
    return [[text]];
  }
  const answers = questions.map((question) =>
    normalizeAnswerValues(answerMap![question.id] ?? answerMap![question.question]),
  );
  if (answers.every((values) => values.length === 0)) return null;
  if (questions.some((question, index) => !question.multiSelect && answers[index].length === 0)) {
    return null;
  }
  return answers;
}

function normalizeAnswerValues(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  }
  if (isRecord(value) && Array.isArray(value.answers)) return normalizeAnswerValues(value.answers);
  return [];
}

function firstAnswerValue(result: string): string {
  try {
    const parsed = JSON.parse(result) as unknown;
    if (isRecord(parsed) && isRecord(parsed.answers)) {
      for (const value of Object.values(parsed.answers)) {
        const values = normalizeAnswerValues(value);
        if (values.length > 0) return values.join(", ");
      }
      return "";
    }
  } catch {
    // plain text answer
  }
  return result.trim();
}

/**
 * User entries on the active path among the entries returned by
 * `get_entries {since}`: walk `parentId` from `leafId` through the returned
 * entries only; keep non-synthetic user messages in file order.
 */
export function newUserEntriesOnPath(
  entries: JsonRecord[],
  leafId: string | null,
): Array<{ entryId: string; text: string }> {
  const byId = new Map<string, JsonRecord>();
  for (const entry of entries) {
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }
  const onPath = new Set<string>();
  let current = leafId ? byId.get(leafId) : undefined;
  while (current && typeof current.id === "string" && !onPath.has(current.id)) {
    onPath.add(current.id);
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }
  const result: Array<{ entryId: string; text: string }> = [];
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !onPath.has(entry.id)) continue;
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "user" || message.synthetic === true) continue;
    if (message.attribution !== undefined && message.attribution !== "user") continue;
    result.push({ entryId: entry.id, text: ompMessageText(message.content) });
  }
  return result;
}

function imagesField(images: OmpImageInput[] | undefined): JsonRecord {
  if (!images || images.length === 0) return {};
  return {
    images: images.map((image) => ({ type: "image", data: image.base64, mimeType: image.mimeType })),
  };
}

function modelSelector(model: JsonRecord): string | undefined {
  if (typeof model.provider !== "string" || typeof model.id !== "string") return undefined;
  return `${model.provider}/${model.id}`;
}

function messageModel(message: JsonRecord): string | undefined {
  if (typeof message.provider === "string" && typeof message.model === "string") {
    return `${message.provider}/${message.model}`;
  }
  return undefined;
}

function unboundApprovalId(dialogId: string): string {
  return `omp-approval:${dialogId}`;
}

/** omp's marker for a value cut at its prompt limit (`tools/approval.ts` truncateForPrompt). */
const APPROVAL_ELISION_MARKER = "[…";

/**
 * Whether `value` (trimmed, non-empty) is a whole detail value of an approval
 * text: it starts right after a `Label:` (same line or a following line) and
 * ends at a line end, as omp writes `Command: <command>` or
 * `Content:\n<content>`. A value that only occurs inside a longer one
 * (`ls` in `Command: ls -la`) does not count. omp elides long values, so a
 * value whose first APPROVAL_SCORE_PREFIX_CHARS characters match also counts
 * where the text continues with the elision marker instead of the value's rest.
 */
function approvalTextHasValue(text: string, value: string): boolean {
  const prefix = value.slice(0, APPROVAL_SCORE_PREFIX_CHARS);
  for (let at = text.indexOf(prefix); at !== -1; at = text.indexOf(prefix, at + 1)) {
    if (!startsDetailValue(text, at)) continue;
    let matched = 0;
    while (
      matched < value.length &&
      at + matched < text.length &&
      text[at + matched] === value[matched]
    ) {
      matched += 1;
    }
    const end = at + matched;
    if (matched === value.length) {
      if (endsDetailValue(text, end)) return true;
    } else if (matched >= prefix.length && text.startsWith(APPROVAL_ELISION_MARKER, end)) {
      return true;
    }
  }
  return false;
}

/** `at` follows `Label:` plus whitespace, and the label line has no other colon. */
function startsDetailValue(text: string, at: number): boolean {
  let colon = at - 1;
  while (colon >= 0 && " \t\r\n".includes(text[colon])) colon -= 1;
  if (colon === at - 1 || colon < 0 || text[colon] !== ":") return false;
  const lineStart = text.lastIndexOf("\n", colon) + 1;
  return text.indexOf(":", lineStart) === colon;
}

/** Only spaces or tabs follow `end` before the next line or the end of the text. */
function endsDetailValue(text: string, end: number): boolean {
  let index = end;
  while (index < text.length && (text[index] === " " || text[index] === "\t" || text[index] === "\r")) {
    index += 1;
  }
  return index === text.length || text[index] === "\n";
}

function clonePayload(payload: PermissionPayload): {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
} {
  return { toolUseId: payload.toolUseId, toolName: payload.toolName, input: { ...payload.input } };
}

function numberOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberText(value: unknown): string {
  return typeof value === "number" ? String(value) : "?";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
