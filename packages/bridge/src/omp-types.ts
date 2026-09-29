import type { ServerMessage } from "./parser.js";
import type { SessionHistoryMessage, SessionIndexEntry } from "./sessions-index.js";

/** Thinking levels omp accepts over RPC and on the CLI (`--thinking`). */
export type OmpThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const OMP_THINKING_LEVELS: readonly OmpThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function isOmpThinkingLevel(value: unknown): value is OmpThinkingLevel {
  return (
    typeof value === "string" &&
    (OMP_THINKING_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Selectable levels: `off` plus the model's efforts, limited to what the
 * Bridge parser accepts (omp's effort list can grow). Accepts the CLI shape
 * (`string[] | null`) and the RPC shape (`{efforts: string[]}`).
 */
export function ompThinkingLevelsFor(thinking: unknown): OmpThinkingLevel[] {
  const rpcEfforts =
    thinking !== null && typeof thinking === "object"
      ? (thinking as { efforts?: unknown }).efforts
      : undefined;
  const efforts: unknown[] = Array.isArray(thinking)
    ? thinking
    : Array.isArray(rpcEfforts)
      ? rpcEfforts
      : [];
  const levels = new Set<OmpThinkingLevel>(["off"]);
  for (const effort of efforts) {
    if (isOmpThinkingLevel(effort)) levels.add(effort);
  }
  return OMP_THINKING_LEVELS.filter((level) => levels.has(level));
}

/** ccpocket execution modes offered for omp (no plan / auto). */
export type OmpExecutionMode = "default" | "acceptEdits" | "fullAccess";
/** omp `--approval-mode` values. */
export type OmpApprovalMode = "always-ask" | "write" | "yolo";
/** Legacy `permissionMode` values reported for omp sessions. */
export type OmpLegacyPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions";
export type OmpAvailability = "available" | "not_installed" | "no_models";

export function approvalModeFor(mode: OmpExecutionMode): OmpApprovalMode {
  switch (mode) {
    case "acceptEdits":
      return "write";
    case "fullAccess":
      return "yolo";
    default:
      return "always-ask";
  }
}

export function legacyPermissionModeFor(
  mode: OmpExecutionMode,
): OmpLegacyPermissionMode {
  switch (mode) {
    case "acceptEdits":
      return "acceptEdits";
    case "fullAccess":
      return "bypassPermissions";
    default:
      return "default";
  }
}

/** One entry of the omp model catalogue as sent to the app. */
export interface OmpModelInfo {
  /** `<provider>/<id>`, the exact value `--model` and `set_omp_model` take. */
  selector: string;
  provider: string;
  name: string;
  thinkingLevels: OmpThinkingLevel[];
  input: string[];
}

export interface OmpSettings {
  /** Model selector `<provider>/<id>`. */
  model?: string;
  thinkingLevel?: OmpThinkingLevel;
}

export interface OmpStartOptions {
  /** Owner id for the writer registry. */
  bridgeSessionId: string;
  /** omp's `--cwd`. Defaults to the cwd passed to `start()`. */
  cwd?: string;
  executionMode: OmpExecutionMode;
  /** Exact selector, already validated by the caller. */
  model?: string;
  /** Already validated by the caller. */
  thinkingLevel?: OmpThinkingLevel;
  additionalDirectories?: string[];
  /** Absolute path of an existing session `.jsonl`. */
  resumeSessionFile?: string;
  /** omp session id of that file. */
  resumeSessionId?: string;
  /** Last entry id read from that file; seeds the user-uuid backfill cursor. */
  entryCursor?: string | null;
}

/**
 * `system` messages carrying omp-only fields. `ServerMessage` cannot express
 * `provider: "omp"` and the thinking fields until the parser is widened.
 */
export interface OmpSystemMessage {
  type: "system";
  subtype: "init" | "omp_settings" | "supported_commands" | "set_permission_mode";
  sessionId?: string;
  provider: "omp";
  model?: string;
  thinkingLevel?: OmpThinkingLevel;
  thinkingLevels?: OmpThinkingLevel[];
  executionMode?: OmpExecutionMode;
  permissionMode?: OmpLegacyPermissionMode;
  slashCommands?: string[];
}

export type OmpProcessMessage = ServerMessage | OmpSystemMessage;

export interface OmpRecentSession
  extends Omit<SessionIndexEntry, "provider" | "codexSettings" | "permissionMode"> {
  provider: "omp";
  ompSettings?: OmpSettings;
}

/** Reference to an image in omp's blob store (`<agentDir>/blobs/<blob>`). */
export interface OmpImageRef {
  blob: string;
  mimeType: string;
}

/** A history message; `ompImages` is resolved and removed before it is sent. */
export interface OmpSessionHistoryMessage extends SessionHistoryMessage {
  ompImages?: OmpImageRef[];
}

/** Prefix of the uuid of an omp user message: `omp:entry:<entryId>`. */
export const OMP_ENTRY_UUID_PREFIX = "omp:entry:";

export function ompEntryUuid(entryId: string): string {
  return `${OMP_ENTRY_UUID_PREFIX}${entryId}`;
}

export function ompEntryIdFromUuid(uuid: string | undefined): string | null {
  if (!uuid || !uuid.startsWith(OMP_ENTRY_UUID_PREFIX)) return null;
  const entryId = uuid.slice(OMP_ENTRY_UUID_PREFIX.length);
  return entryId.length > 0 ? entryId : null;
}

/** Error with a machine-readable `code` (an `errorCode` value of §9.3). */
export type OmpCodedError = Error & { code: string };

export function ompError(code: string, message: string): OmpCodedError {
  const error = new Error(message) as OmpCodedError;
  error.code = code;
  return error;
}

export function ompErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
