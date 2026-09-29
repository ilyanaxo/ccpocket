import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { readJsonlLines, type OversizedJsonlLine } from "./jsonl-partial.js";
import { resolveOmpStore } from "./omp-env.js";
import { findOmpSessionFile } from "./omp-sessions.js";
import {
  canonicalToolInput,
  canonicalToolName,
  isRecord,
  ompCallIntent,
  ompInternalToolName,
  ompMessageText,
  ompResultText,
  ompToolResultContent,
  ompTodoPhases,
  ompTodoWriteInput,
  stripOmpIntent,
  type OmpTodoPhase,
} from "./omp-tool-mapping.js";
import {
  ompEntryIdFromUuid,
  ompEntryUuid,
  ompError,
  type OmpImageRef,
  type OmpSessionHistoryMessage,
} from "./omp-types.js";

type JsonRecord = Record<string, unknown>;
type HistoryContent = Exclude<OmpSessionHistoryMessage["content"], string>;

/** `untilEntryId` is not a user message on the active path. */
export class OmpHistoryTargetNotFoundError extends Error {
  constructor(entryId: string) {
    super(`omp entry ${entryId} is not a user message on the active branch`);
    this.name = "OmpHistoryTargetNotFoundError";
  }
}

export interface OmpHistoryLimits {
  /** A tool item above this many code units is compacted. */
  maxToolItemChars: number;
  /** Strings of a compacted item keep this many code units. */
  truncatedStringChars: number;
  /** Nesting below this depth is replaced by a note. */
  maxDepth: number;
  /** Retained display data above this fails with `omp_history_too_large`. */
  maxTotalChars: number;
  /** A physical line above this becomes an "[omitted line]" marker. */
  maxLineChars: number;
}

/** The Codex history bounds (`codex-history.ts`, docs/codex-large-history.md). */
export const DEFAULT_OMP_HISTORY_LIMITS: OmpHistoryLimits = {
  maxToolItemChars: 256 * 1024,
  truncatedStringChars: 16 * 1024,
  maxDepth: 20,
  maxTotalChars: 64 * 1024 * 1024,
  maxLineChars: 64 * 1024 * 1024,
};

const TRUNCATED = "\n[Truncated in Bridge history]";
const OMITTED_DETAIL = "[Large tool detail omitted from Bridge history]";
const OMITTED_LINE = "[omitted line]";
const BLOB_REF_RE = /^blob:sha256:([0-9a-f]{64})$/;
const BLOB_HASH_RE = /^[0-9a-f]{64}$/;
const MAX_IMAGE_REFS_PER_MESSAGE = 4;
const MAX_HISTORY_IMAGE_BYTES = 8 * 1024 * 1024;
/** The image store's limit (`image-store.ts`). */
const MAX_BLOB_BYTES = 10 * 1024 * 1024;

export interface OmpHistoryOptions {
  /** Return the active path only up to (excluding) this user entry. */
  untilEntryId?: string;
  limits?: Partial<OmpHistoryLimits>;
  /** Blob store for image references; default: the resolved omp store. */
  blobsDir?: string;
}

// ---- compact per-entry records kept while the file is read ----

interface ImageInfo {
  count: number;
  refs: OmpImageRef[];
}

type DisplayEntry =
  | { kind: "user"; timestamp?: string; text: string; images: ImageInfo; synthetic: boolean }
  | {
      kind: "assistant";
      timestamp?: string;
      blocks: AssistantBlock[];
      stopReason?: string;
      errorMessage?: string;
    }
  | {
      kind: "toolResult";
      timestamp?: string;
      toolCallId: string;
      toolName: string;
      text: string;
      isError: boolean;
      details?: JsonRecord;
      images: ImageInfo;
    }
  | { kind: "exec"; timestamp?: string; tool: "Bash" | "eval"; input: JsonRecord; output: string }
  | { kind: "custom"; timestamp?: string; text: string; asUser: boolean }
  | { kind: "omitted"; timestamp?: string; role: "user" | "assistant" | "toolResult" };

type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; args: JsonRecord; intent?: string };

interface TreeNode {
  id: string;
  parentId: string | null;
  display?: DisplayEntry;
}

/**
 * Convert the active branch of an omp session file into history messages.
 *
 * The file is streamed; each entry is reduced to its display data as it is
 * read, so memory follows the retained display data, not the file size.
 */
export async function getOmpSessionHistory(
  file: string,
  options: OmpHistoryOptions = {},
): Promise<{ messages: OmpSessionHistoryMessage[]; lastEntryId: string | null }> {
  const limits = { ...DEFAULT_OMP_HISTORY_LIMITS, ...options.limits };
  const nodes = new Map<string, TreeNode>();
  let lastEntryId: string | null = null;
  let retainedChars = 0;
  let tooLarge = false;

  await readJsonlLines(file, {
    maxLineChars: limits.maxLineChars,
    onLine: (line) => {
      const node = typeof line === "string" ? parseTreeLine(line, limits) : parseOversizedLine(line);
      if (!node) return;
      nodes.set(node.id, node);
      lastEntryId = node.id;
      if (node.display) {
        retainedChars += displaySize(node.display);
        if (retainedChars > limits.maxTotalChars) {
          tooLarge = true;
          return false;
        }
      }
    },
  });
  if (tooLarge) {
    throw ompError(
      "omp_history_too_large",
      `The omp session history exceeds the Bridge limit of ${limits.maxTotalChars} characters.`,
    );
  }

  let path = activePath(nodes, lastEntryId);
  if (options.untilEntryId !== undefined) {
    const index = path.findIndex((node) => node.id === options.untilEntryId);
    const target = index >= 0 ? path[index].display : undefined;
    if (!target || target.kind !== "user" || target.synthetic) {
      throw new OmpHistoryTargetNotFoundError(options.untilEntryId);
    }
    path = path.slice(0, index);
  }

  const blobsDir = options.blobsDir ?? resolveOmpStore().blobsDir;
  const messages = await convertPath(path, blobsDir);
  return { messages, lastEntryId };
}

function activePath(nodes: Map<string, TreeNode>, leafId: string | null): TreeNode[] {
  const path: TreeNode[] = [];
  const visited = new Set<string>();
  let current = leafId ? nodes.get(leafId) : undefined;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.push(current);
    current = current.parentId ? nodes.get(current.parentId) : undefined;
  }
  return path.reverse();
}

function parseTreeLine(line: string, limits: OmpHistoryLimits): TreeNode | null {
  if (!line.trim()) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(entry) || typeof entry.id !== "string") return null;
  if (entry.type === "title" || entry.type === "session") return null;
  return {
    id: entry.id,
    parentId: typeof entry.parentId === "string" ? entry.parentId : null,
    display: toDisplayEntry(entry, limits),
  };
}

const RE_PREFIX_TYPE = /"type"\s*:\s*"([^"]+)"/;
const RE_PREFIX_ID = /"id"\s*:\s*"([^"]+)"/;
const RE_PREFIX_PARENT = /"parentId"\s*:\s*(?:"([^"]+)"|null)/;
const RE_PREFIX_ROLE = /"role"\s*:\s*"([^"]+)"/;

/** Keep the tree intact for a line above the limit: its keys come first. */
function parseOversizedLine(line: OversizedJsonlLine): TreeNode | null {
  const type = line.prefix.match(RE_PREFIX_TYPE)?.[1];
  const id = line.prefix.match(RE_PREFIX_ID)?.[1];
  if (!id || type === "title" || type === "session") return null;
  const parentId = line.prefix.match(RE_PREFIX_PARENT)?.[1] ?? null;
  let display: DisplayEntry | undefined;
  if (type === "message" || type === "custom_message") {
    const role = line.prefix.match(RE_PREFIX_ROLE)?.[1];
    display = {
      kind: "omitted",
      role: role === "user" ? "user" : role === "toolResult" ? "toolResult" : "assistant",
    };
  }
  return { id, parentId, display };
}

function toDisplayEntry(entry: JsonRecord, limits: OmpHistoryLimits): DisplayEntry | undefined {
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
  if (entry.type === "custom_message") {
    if (entry.display !== true) return undefined;
    const text = ompMessageText(entry.content);
    if (!text) return undefined;
    return { kind: "custom", timestamp, text, asUser: entry.attribution === "user" };
  }
  if (entry.type !== "message" || !isRecord(entry.message)) return undefined;
  const message = entry.message;
  switch (message.role) {
    case "user":
      return {
        kind: "user",
        timestamp,
        text: ompMessageText(message.content),
        images: imageInfo(message.content),
        synthetic: message.synthetic === true,
      };
    case "assistant":
      return {
        kind: "assistant",
        timestamp,
        blocks: assistantBlocks(message.content, limits),
        ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
        ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}),
      };
    case "toolResult": {
      const name = ompInternalToolName(String(message.toolName ?? ""));
      const details = retainedDetails(name, message.details, limits);
      return {
        kind: "toolResult",
        timestamp,
        toolCallId: String(message.toolCallId ?? ""),
        toolName: name,
        text: boundString(ompResultText(message), limits),
        isError: message.isError === true,
        ...(details ? { details } : {}),
        images: imageInfo(message.content),
      };
    }
    case "bashExecution":
      return {
        kind: "exec",
        timestamp,
        tool: "Bash",
        input: { command: String(message.command ?? "") },
        output: boundString(execOutput(message), limits),
      };
    case "pythonExecution":
      return {
        kind: "exec",
        timestamp,
        tool: "eval",
        input: { code: boundString(String(message.code ?? ""), limits) },
        output: boundString(execOutput(message), limits),
      };
    default:
      // developer and other injected roles are not shown
      return undefined;
  }
}

function execOutput(message: JsonRecord): string {
  const output = typeof message.output === "string" ? message.output : "";
  const notes: string[] = [];
  if (message.cancelled === true) notes.push("[cancelled]");
  if (typeof message.exitCode === "number" && message.exitCode !== 0) {
    notes.push(`[exit code ${message.exitCode}]`);
  }
  return [output.replace(/\n+$/, ""), ...notes].filter(Boolean).join("\n");
}

function assistantBlocks(content: unknown, limits: OmpHistoryLimits): AssistantBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: AssistantBlock[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      blocks.push({ type: "text", text: block.text });
    } else if (
      block.type === "thinking" &&
      typeof block.thinking === "string" &&
      block.thinking.trim()
    ) {
      blocks.push({ type: "thinking", thinking: block.thinking });
    } else if (block.type === "toolCall" && typeof block.id === "string") {
      const intent = ompCallIntent(block.intent, block.arguments);
      blocks.push({
        type: "toolCall",
        id: block.id,
        name: ompInternalToolName(String(block.name ?? "")),
        args: boundToolItem(stripOmpIntent(block.arguments), limits) as JsonRecord,
        ...(intent ? { intent } : {}),
      });
    }
  }
  return blocks;
}

/** Only the details the history rendering needs: edit diffs and todo phases. */
function retainedDetails(
  name: string,
  details: unknown,
  limits: OmpHistoryLimits,
): JsonRecord | undefined {
  if (!isRecord(details)) return undefined;
  if (name === "edit") {
    const kept: JsonRecord = {};
    if (typeof details.diff === "string") kept.diff = details.diff;
    if (typeof details.path === "string") kept.path = details.path;
    if (Array.isArray(details.perFileResults)) {
      kept.perFileResults = details.perFileResults.flatMap((file) =>
        isRecord(file) ? [{ path: file.path, diff: file.diff }] : [],
      );
    }
    return boundToolItem(kept, limits) as JsonRecord;
  }
  if (name === "todo" && Array.isArray(details.phases)) {
    return boundToolItem({ phases: details.phases }, limits) as JsonRecord;
  }
  return undefined;
}

function imageInfo(content: unknown): ImageInfo {
  const info: ImageInfo = { count: 0, refs: [] };
  if (!Array.isArray(content)) return info;
  for (const block of content) {
    if (!isRecord(block) || block.type !== "image") continue;
    info.count += 1;
    const hash =
      typeof block.data === "string" ? block.data.match(BLOB_REF_RE)?.[1] : undefined;
    if (hash && info.refs.length < MAX_IMAGE_REFS_PER_MESSAGE) {
      info.refs.push({
        blob: hash,
        mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png",
      });
    }
  }
  return info;
}

function boundString(value: string, limits: OmpHistoryLimits): string {
  if (value.length <= limits.maxToolItemChars) return value;
  return value.slice(0, limits.truncatedStringChars) + TRUNCATED;
}

/** Bound an unusually large tool item, as `compactCodexHistoryItem` does. */
function boundToolItem(value: unknown, limits: OmpHistoryLimits): unknown {
  let size: number;
  try {
    size = JSON.stringify(value)?.length ?? 0;
  } catch {
    return OMITTED_DETAIL;
  }
  if (size <= limits.maxToolItemChars) return value;
  return compactValue(value, 0, limits);
}

function compactValue(value: unknown, depth: number, limits: OmpHistoryLimits): unknown {
  if (typeof value === "string") {
    if (value.length <= limits.truncatedStringChars) return value;
    return value.slice(0, limits.truncatedStringChars) + TRUNCATED;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= limits.maxDepth) return OMITTED_DETAIL;
  if (Array.isArray(value)) return value.map((entry) => compactValue(entry, depth + 1, limits));
  return Object.fromEntries(
    Object.entries(value as JsonRecord).map(([key, entry]) => [
      key,
      compactValue(entry, depth + 1, limits),
    ]),
  );
}

function displaySize(display: DisplayEntry): number {
  switch (display.kind) {
    case "user":
      return display.text.length;
    case "assistant":
      return JSON.stringify(display.blocks).length;
    case "toolResult":
      return display.text.length + (display.details ? JSON.stringify(display.details).length : 0);
    case "exec":
      return display.output.length + JSON.stringify(display.input).length;
    case "custom":
      return display.text.length;
    default:
      return OMITTED_LINE.length;
  }
}

// ---- path → history messages ----

async function convertPath(
  path: TreeNode[],
  blobsDir: string,
): Promise<OmpSessionHistoryMessage[]> {
  const results = new Map<string, Extract<DisplayEntry, { kind: "toolResult" }>>();
  for (const node of path) {
    if (node.display?.kind === "toolResult") results.set(node.display.toolCallId, node.display);
  }
  const callArgs = new Map<string, { name: string; args: JsonRecord }>();
  const messages: OmpSessionHistoryMessage[] = [];

  for (const node of path) {
    const display = node.display;
    if (!display) continue;
    switch (display.kind) {
      case "user": {
        if (display.synthetic) break;
        const refs = await usableImageRefs(display.images.refs, blobsDir);
        messages.push({
          role: "user",
          uuid: ompEntryUuid(node.id),
          ...(display.timestamp ? { timestamp: display.timestamp } : {}),
          content: display.text,
          ...(display.images.count > 0 ? { imageCount: display.images.count } : {}),
          ...(refs.length > 0 ? { ompImages: refs } : {}),
        });
        break;
      }
      case "assistant": {
        const content: HistoryContent = [];
        for (const block of display.blocks) {
          if (block.type === "text") content.push({ type: "text", text: block.text });
          else if (block.type === "thinking") content.push({ type: "thinking", thinking: block.thinking });
          else {
            callArgs.set(block.id, { name: block.name, args: block.args });
            content.push(toolUseItem(block, results.get(block.id)));
          }
        }
        if (content.length === 0 && display.stopReason === "error") {
          content.push({ type: "text", text: `Error: ${display.errorMessage ?? "omp reported an error"}` });
        }
        if (content.length === 0) break;
        messages.push({
          role: "assistant",
          ...(display.timestamp ? { timestamp: display.timestamp } : {}),
          content,
        });
        break;
      }
      case "toolResult": {
        const call = callArgs.get(display.toolCallId);
        const args = call?.args ?? {};
        const phases = display.toolName === "todo" ? todoPhasesOf(display) : null;
        const refs = await usableImageRefs(display.images.refs, blobsDir);
        messages.push({
          role: "tool_result",
          ...(display.timestamp ? { timestamp: display.timestamp } : {}),
          toolUseId: display.toolCallId,
          toolName:
            display.toolName === "todo" && !phases
              ? "todo"
              : canonicalToolName(display.toolName, args),
          content: ompToolResultContent(display.toolName, args, {
            content: [{ type: "text", text: display.text }],
            details: display.details,
          }),
          ...(refs.length > 0 ? { ompImages: refs } : {}),
        });
        break;
      }
      case "exec": {
        const toolUseId = ompEntryUuid(node.id);
        messages.push({
          role: "assistant",
          ...(display.timestamp ? { timestamp: display.timestamp } : {}),
          content: [{ type: "tool_use", id: toolUseId, name: display.tool, input: display.input }],
        });
        messages.push({
          role: "tool_result",
          ...(display.timestamp ? { timestamp: display.timestamp } : {}),
          toolUseId,
          toolName: display.tool,
          content: display.output,
        });
        break;
      }
      case "custom":
        messages.push(
          display.asUser
            ? {
                role: "user",
                ...(display.timestamp ? { timestamp: display.timestamp } : {}),
                content: display.text,
              }
            : {
                role: "assistant",
                ...(display.timestamp ? { timestamp: display.timestamp } : {}),
                content: [{ type: "text", text: display.text }],
              },
        );
        break;
      case "omitted":
        if (display.role === "user") {
          messages.push({ role: "user", content: OMITTED_LINE });
        } else if (display.role === "toolResult") {
          messages.push({ role: "tool_result", content: OMITTED_LINE });
        } else {
          messages.push({ role: "assistant", content: [{ type: "text", text: OMITTED_LINE }] });
        }
        break;
    }
  }
  return messages;
}

function toolUseItem(
  block: Extract<AssistantBlock, { type: "toolCall" }>,
  result: Extract<DisplayEntry, { kind: "toolResult" }> | undefined,
): HistoryContent[number] {
  if (block.name === "todo") {
    const phases = result ? todoPhasesOf(result) : null;
    if (phases) {
      return { type: "tool_use", id: block.id, name: "TodoWrite", input: ompTodoWriteInput(phases) };
    }
    return {
      type: "tool_use",
      id: block.id,
      name: "todo",
      input: canonicalToolInput("todo", block.args, block.intent),
    };
  }
  return {
    type: "tool_use",
    id: block.id,
    name: canonicalToolName(block.name, block.args),
    input: canonicalToolInput(block.name, block.args, block.intent),
  };
}

function todoPhasesOf(result: Extract<DisplayEntry, { kind: "toolResult" }>): OmpTodoPhase[] | null {
  return result.isError ? null : ompTodoPhases(result.details);
}

async function usableImageRefs(refs: OmpImageRef[], blobsDir: string): Promise<OmpImageRef[]> {
  const usable: OmpImageRef[] = [];
  for (const ref of refs) {
    try {
      const info = await stat(join(blobsDir, ref.blob));
      if (info.isFile() && info.size <= MAX_HISTORY_IMAGE_BYTES) usable.push(ref);
    } catch {
      // missing blob: the image only counts
    }
  }
  return usable;
}

// ---- blobs and lazy image extraction ----

/** Read a blob (decoded bytes) as base64. The hash is validated; ≤ 10 MB. */
export async function readOmpBlob(
  hash: string,
  options: { blobsDir?: string } = {},
): Promise<{ base64: string } | null> {
  if (!BLOB_HASH_RE.test(hash)) return null;
  const file = join(options.blobsDir ?? resolveOmpStore().blobsDir, hash);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_BLOB_BYTES) return null;
    const data = await readFile(file);
    return { base64: data.toString("base64") };
  } catch {
    return null;
  }
}

/**
 * Images of one user message (`omp:entry:<id>`), for `get_message_images`.
 * Stream-scans the session file for that entry.
 */
export async function extractOmpMessageImages(
  sessionId: string,
  messageUuid: string,
  options: { env?: NodeJS.ProcessEnv; blobsDir?: string } = {},
): Promise<Array<{ base64: string; mimeType: string }>> {
  const entryId = ompEntryIdFromUuid(messageUuid);
  if (!entryId) return [];
  const file = await findOmpSessionFile(sessionId, { env: options.env });
  if (!file) return [];
  const blobsDir = options.blobsDir ?? resolveOmpStore(options.env).blobsDir;
  const needle = new RegExp(`"id"\\s*:\\s*"${escapeRegExp(entryId)}"`);
  let content: unknown;
  await readJsonlLines(file, {
    maxLineChars: DEFAULT_OMP_HISTORY_LIMITS.maxLineChars,
    onLine: (line) => {
      if (typeof line !== "string" || !needle.test(line)) return;
      try {
        const entry = JSON.parse(line) as JsonRecord;
        if (entry.id === entryId && isRecord(entry.message)) {
          content = entry.message.content;
          return false;
        }
      } catch {
        // not this entry
      }
    },
  });
  if (!Array.isArray(content)) return [];
  const images: Array<{ base64: string; mimeType: string }> = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "image" || typeof block.data !== "string") continue;
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image/png";
    const hash = block.data.match(BLOB_REF_RE)?.[1];
    if (hash) {
      const blob = await readOmpBlob(hash, { blobsDir });
      if (blob) images.push({ base64: blob.base64, mimeType });
    } else if (!block.data.startsWith("blob:")) {
      images.push({ base64: block.data, mimeType });
    }
  }
  return images;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
