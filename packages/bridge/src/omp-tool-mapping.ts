/**
 * omp tool calls and results → the tool names and inputs the app renders.
 *
 * Shared by the live event mapping (`omp-process.ts`) and the history
 * conversion (`omp-history.ts`), so a tool looks the same live and after a
 * resume. See docs/omp-integration.md §3.3.
 */

type JsonRecord = Record<string, unknown>;

/**
 * omp tools with a custom wire name. `toolCall.name` and
 * `tool_execution_*.toolName` carry the wire name, approval titles carry the
 * internal name (omp v18.3.2 `edit/index.ts` `customWireName`).
 */
export const OMP_TOOL_WIRE_ALIASES: Readonly<Record<string, string>> = {
  apply_patch: "edit",
};

/** Normalize a wire tool name to omp's internal tool name. */
export function ompInternalToolName(name: string): string {
  return OMP_TOOL_WIRE_ALIASES[name] ?? name;
}

/** Arguments without the intent `i` omp injects into every call. */
export function stripOmpIntent(args: unknown): JsonRecord {
  if (!isRecord(args)) return {};
  const { i: _intent, ...rest } = args;
  return rest;
}

/** The intent of a call: the block's `intent`, else the `i` argument. */
export function ompCallIntent(
  intent: unknown,
  args: unknown,
): string | undefined {
  if (typeof intent === "string" && intent.trim()) return intent;
  if (isRecord(args) && typeof args.i === "string" && args.i.trim()) {
    return args.i;
  }
  return undefined;
}

/** `edit` in replace mode carries `old_string` / `new_string`. */
export function isOmpReplaceEdit(args: JsonRecord): boolean {
  return (
    typeof args.old_string === "string" && typeof args.new_string === "string"
  );
}

/** App tool name for an omp tool (`name` is the internal name). */
export function canonicalToolName(name: string, args: JsonRecord): string {
  switch (name) {
    case "bash":
      return "Bash";
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "edit":
      return isOmpReplaceEdit(args) ? "Edit" : "FileChange";
    case "grep":
      return "Grep";
    case "glob":
      return "Glob";
    case "web_search":
      return "WebSearch";
    case "todo":
      return "TodoWrite";
    case "task":
      return "Task";
    case "ask":
      return "AskUserQuestion";
    default:
      return name;
  }
}

/**
 * App tool input for an omp call. `args` must already be without `i`.
 * `todo` has no input mapping here: its card is built from the result
 * (`ompTodoWriteInput`).
 */
export function canonicalToolInput(
  name: string,
  args: JsonRecord,
  intent?: string,
): JsonRecord {
  switch (name) {
    case "bash":
      return pickDefined({
        command: args.command,
        cwd: args.cwd,
        timeout: args.timeout,
      });
    case "read":
      return pickDefined({ file_path: args.path });
    case "write":
      return pickDefined({ file_path: args.path, content: args.content });
    case "edit":
      if (isOmpReplaceEdit(args)) {
        return pickDefined({
          file_path: args.path,
          old_string: args.old_string,
          new_string: args.new_string,
          replace_all: args.replace_all,
        });
      }
      return { changes: ompEditChanges(args) };
    case "grep":
      return pickDefined({ pattern: args.pattern, path: args.path });
    case "glob":
      // omp's glob pattern lives in `path` (docs/tools/glob.md).
      return pickDefined({ pattern: args.path ?? args.pattern });
    case "web_search":
      return pickDefined({ query: args.query });
    case "task":
      return taskInput(args, intent);
    case "ask":
      // The same question shape as the permission_request (§3.3).
      return askUserQuestionInput(ompAskQuestions(args));
    default:
      // MCP tools keep their arguments as they are (generic MCP tile).
      if (intent && args.description === undefined && !name.startsWith("mcp__")) {
        return { ...args, description: intent };
      }
      return { ...args };
  }
}

function taskInput(args: JsonRecord, intent?: string): JsonRecord {
  const tasks = Array.isArray(args.tasks) ? args.tasks : undefined;
  const firstTask =
    tasks && isRecord(tasks[0]) && typeof tasks[0].task === "string"
      ? tasks[0].task
      : undefined;
  const singleTask = typeof args.task === "string" ? args.task : undefined;
  return pickDefined({
    description: intent ?? firstTask ?? singleTask,
    prompt: typeof args.context === "string" ? args.context : singleTask,
    subagent_type: typeof args.agent === "string" ? args.agent : undefined,
    tasks,
  });
}

export interface OmpAskQuestion {
  id: string;
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

/** `ask` arguments as AskUserQuestion questions. */
export function ompAskQuestions(args: JsonRecord): OmpAskQuestion[] {
  if (!Array.isArray(args.questions)) return [];
  const questions: OmpAskQuestion[] = [];
  args.questions.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.question !== "string") return;
    const options = Array.isArray(raw.options)
      ? raw.options.flatMap((option) => {
          if (typeof option === "string") return [{ label: option }];
          if (!isRecord(option) || typeof option.label !== "string") return [];
          return [
            typeof option.description === "string" && option.description
              ? { label: option.label, description: option.description }
              : { label: option.label },
          ];
        })
      : [];
    questions.push({
      id: typeof raw.id === "string" && raw.id ? raw.id : `q${index + 1}`,
      question: raw.question,
      ...(typeof raw.header === "string" && raw.header
        ? { header: raw.header }
        : {}),
      options,
      multiSelect: raw.multi === true,
    });
  });
  return questions;
}

/**
 * AskUserQuestion input, the same shape for the tool_use block, the
 * permission_request and history (§3.3). omp's `recommended` index is not
 * part of it; omp appends ` (Recommended)` to that label in its select frames,
 * which the answer replay matches without the suffix.
 */
export function askUserQuestionInput(questions: OmpAskQuestion[]): JsonRecord {
  return {
    questions: questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    })),
  };
}

// ---- edit ----

export interface OmpFileChange {
  path: string;
  kind: "add" | "delete" | "update";
  diff: string;
}

const HASHLINE_HEADER_RE = /^\[(.+)#([0-9A-Za-z]{1,16})\]\s*$/;
const APPLY_PATCH_FILE_RE = /^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/;
const APPLY_PATCH_MOVE_RE = /^\*\*\* Move to: (.+?)\s*$/;
const PATCH_ENVELOPE_RE = /^\*\*\* (Begin|End) Patch\s*$/;

/**
 * Per-file changes of a non-replace `edit` call: `[PATH#TAG]` sections of a
 * hashline payload, `*** … File:` sections of an `apply_patch` payload, or the
 * `edits` of patch mode.
 */
export function ompEditChanges(args: JsonRecord): OmpFileChange[] {
  if (typeof args.input === "string") return parsePatchSections(args.input);
  if (typeof args.path === "string" && Array.isArray(args.edits)) {
    const diffs: string[] = [];
    let kind: OmpFileChange["kind"] = "update";
    for (const edit of args.edits) {
      if (!isRecord(edit)) continue;
      if (edit.op === "create") kind = "add";
      else if (edit.op === "delete") kind = "delete";
      if (typeof edit.diff === "string" && edit.diff) diffs.push(edit.diff);
    }
    return [{ path: args.path, kind, diff: diffs.join("\n") }];
  }
  if (typeof args.path === "string") {
    return [{ path: args.path, kind: "update", diff: "" }];
  }
  return [];
}

/** Every path an `edit` call targets (used to bind its approval). */
export function ompEditTargetPaths(args: JsonRecord): string[] {
  if (isOmpReplaceEdit(args) || typeof args.input !== "string") {
    return typeof args.path === "string" ? [args.path] : [];
  }
  return [...new Set(ompEditChanges(args).map((change) => change.path))];
}

/** The raw patch text of a non-replace `edit` call, if it has one. */
export function ompEditPatchText(args: JsonRecord): string | undefined {
  if (typeof args.input === "string") return args.input;
  if (Array.isArray(args.edits)) {
    const diffs = args.edits.flatMap((edit) =>
      isRecord(edit) && typeof edit.diff === "string" ? [edit.diff] : [],
    );
    return diffs.length > 0 ? diffs.join("\n") : undefined;
  }
  return undefined;
}

function parsePatchSections(input: string): OmpFileChange[] {
  const changes: OmpFileChange[] = [];
  let current: { change: OmpFileChange; lines: string[] } | null = null;
  const finish = () => {
    if (!current) return;
    current.change.diff = current.lines.join("\n").replace(/\n+$/, "");
    const existing = changes.find(
      (change) => change.path === current!.change.path,
    );
    if (existing) {
      existing.diff = [existing.diff, current.change.diff]
        .filter(Boolean)
        .join("\n");
      if (current.change.kind !== "update") existing.kind = current.change.kind;
    } else {
      changes.push(current.change);
    }
    current = null;
  };
  for (const line of input.split("\n")) {
    if (PATCH_ENVELOPE_RE.test(line)) {
      finish();
      continue;
    }
    const hashline = line.match(HASHLINE_HEADER_RE);
    if (hashline) {
      finish();
      current = { change: { path: hashline[1], kind: "update", diff: "" }, lines: [] };
      continue;
    }
    const applyPatch = line.match(APPLY_PATCH_FILE_RE);
    if (applyPatch) {
      finish();
      const kind =
        applyPatch[1] === "Add" ? "add" : applyPatch[1] === "Delete" ? "delete" : "update";
      current = { change: { path: applyPatch[2], kind, diff: "" }, lines: [] };
      continue;
    }
    if (!current) continue;
    const move = line.match(APPLY_PATCH_MOVE_RE);
    if (move) {
      current.lines.push(line);
      continue;
    }
    if (/^REM\s*$/.test(line)) current.change.kind = "delete";
    current.lines.push(line);
  }
  finish();
  return changes;
}

const NUMBERED_DIFF_ROW_RE = /^([ +-])\s*(\d+)\|(.*)$/;

/**
 * Convert omp's numbered diff rows (` 1|text`, `-2|text`, `+2|text`) into a
 * unified diff for `path`. A real unified diff is passed through (with file
 * headers added when missing). Returns null when no row matches.
 */
export function convertOmpDiff(diff: string, path: string): string | null {
  const trimmed = diff.replace(/\n+$/, "");
  if (!trimmed.trim()) return null;
  if (/^@@ /m.test(trimmed)) {
    return trimmed.startsWith("--- ")
      ? trimmed
      : `--- a/${path}\n+++ b/${path}\n${trimmed}`;
  }

  interface Hunk {
    rows: string[];
    firstOld?: number;
    firstNew?: number;
    oldCount: number;
    newCount: number;
  }
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  for (const line of trimmed.split("\n")) {
    const match = line.match(NUMBERED_DIFF_ROW_RE);
    if (!match) {
      hunk = null;
      continue;
    }
    if (!hunk) {
      hunk = { rows: [], oldCount: 0, newCount: 0 };
      hunks.push(hunk);
    }
    const [, sign, number, text] = match;
    const lineNumber = Number(number);
    if (sign !== "+") {
      hunk.oldCount += 1;
      hunk.firstOld ??= lineNumber;
    }
    if (sign !== "-") {
      hunk.newCount += 1;
      hunk.firstNew ??= lineNumber;
    }
    hunk.rows.push(`${sign}${text}`);
  }
  if (hunks.length === 0) return null;

  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of hunks) {
    // A zero-length range starts at the line before the change, as in diff -u.
    const oldStart = h.firstOld ?? Math.max(0, (h.firstNew ?? 1) - 1);
    const newStart = h.firstNew ?? Math.max(0, (h.firstOld ?? 1) - 1);
    out.push(`@@ -${oldStart},${h.oldCount} +${newStart},${h.newCount} @@`);
    out.push(...h.rows);
  }
  return out.join("\n");
}

/**
 * Unified diff for an `edit` result from `details.diff` (single file) or
 * `details.perFileResults[].diff` (several files). Null when none converts.
 */
export function ompEditResultDiff(
  args: JsonRecord,
  details: unknown,
): string | null {
  if (!isRecord(details)) return null;
  if (Array.isArray(details.perFileResults) && details.perFileResults.length > 0) {
    const parts = details.perFileResults.flatMap((file) => {
      if (!isRecord(file) || typeof file.diff !== "string") return [];
      const path =
        typeof file.path === "string" ? file.path : fallbackEditPath(args);
      const converted = convertOmpDiff(file.diff, path);
      return converted ? [converted] : [];
    });
    return parts.length > 0 ? parts.join("\n\n") : null;
  }
  if (typeof details.diff !== "string") return null;
  const path =
    typeof details.path === "string" ? details.path : fallbackEditPath(args);
  return convertOmpDiff(details.diff, path);
}

function fallbackEditPath(args: JsonRecord): string {
  return ompEditTargetPaths(args)[0] ?? "file";
}

// ---- results ----

/** Text of a message `content`: a string, or its text blocks joined. */
export function ompMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
}

/** Text blocks of a tool result (`{content:[…]}` or a plain string). */
export function ompResultText(result: unknown): string {
  return ompMessageText(isRecord(result) ? result.content : result);
}

/** Image blocks of a tool result in the Claude shape `SessionManager` registers. */
export function ompResultImageBlocks(result: unknown): JsonRecord[] {
  const content = isRecord(result) ? result.content : undefined;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (
      !isRecord(block) ||
      block.type !== "image" ||
      typeof block.data !== "string" ||
      typeof block.mimeType !== "string" ||
      block.data.startsWith("blob:")
    ) {
      return [];
    }
    return [
      {
        type: "image",
        source: { type: "base64", data: block.data, media_type: block.mimeType },
      },
    ];
  });
}

/**
 * Text shown as the app's tool result: the unified diff for `edit` when omp
 * reported one, otherwise the result text.
 */
export function ompToolResultContent(
  name: string,
  args: JsonRecord,
  result: unknown,
): string {
  if (name === "edit") {
    const diff = ompEditResultDiff(args, isRecord(result) ? result.details : undefined);
    if (diff) return diff;
  }
  return ompResultText(result);
}

// ---- todo ----

export interface OmpTodoPhase {
  name: string;
  tasks: Array<{ content: string; status: string; blocker?: string }>;
}

/** `details.phases` of a `todo` result, when it is well-formed. */
export function ompTodoPhases(details: unknown): OmpTodoPhase[] | null {
  if (!isRecord(details) || !Array.isArray(details.phases)) return null;
  const phases: OmpTodoPhase[] = [];
  for (const phase of details.phases) {
    if (!isRecord(phase) || !Array.isArray(phase.tasks)) return null;
    const tasks: OmpTodoPhase["tasks"] = [];
    for (const task of phase.tasks) {
      if (!isRecord(task) || typeof task.content !== "string") return null;
      tasks.push({
        content: task.content,
        status: typeof task.status === "string" ? task.status : "pending",
        ...(typeof task.blocker === "string" && task.blocker
          ? { blocker: task.blocker }
          : {}),
      });
    }
    phases.push({ name: typeof phase.name === "string" ? phase.name : "", tasks });
  }
  return phases;
}

/** TodoWrite input `{title, todos}` for the full todo state of a result. */
export function ompTodoWriteInput(phases: OmpTodoPhase[]): JsonRecord {
  const prefixPhase = phases.length > 1;
  const todos = phases.flatMap((phase) =>
    phase.tasks.map((task) => {
      const prefix = prefixPhase && phase.name ? `${phase.name}: ` : "";
      let status = task.status;
      let suffix = "";
      if (status === "abandoned") {
        status = "completed";
        suffix = " (dropped)";
      } else if (status === "blocked") {
        status = "pending";
        suffix = task.blocker ? ` (blocked: ${task.blocker})` : " (blocked)";
      } else if (
        status !== "pending" &&
        status !== "in_progress" &&
        status !== "completed"
      ) {
        status = "pending";
      }
      return { content: `${prefix}${task.content}${suffix}`, status, activeForm: "" };
    }),
  );
  return { title: "Todo", todos };
}

// ---- helpers ----

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pickDefined(record: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}
