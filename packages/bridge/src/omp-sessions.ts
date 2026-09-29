import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { decodeJsonStringPrefix, readJsonlLines } from "./jsonl-partial.js";
import { onChildClosed, resolveOmpBin, resolveOmpStore, sanitizedOmpEnv } from "./omp-env.js";
import { OmpRpcTransport } from "./omp-rpc-transport.js";
import { isRecord, ompMessageText } from "./omp-tool-mapping.js";
import {
  isOmpThinkingLevel,
  ompError,
  ompThinkingLevelsFor,
  type OmpAvailability,
  type OmpModelInfo,
  type OmpRecentSession,
  type OmpSettings,
  type OmpThinkingLevel,
} from "./omp-types.js";
import { ompWriters, type OmpWriterRegistry } from "./omp-writers.js";
import { normalizeWorktreePath } from "./sessions-index.js";

type JsonRecord = Record<string, unknown>;

/** omp's own picker reads 4 KiB + 32 KiB; the Bridge reads more to find prompts. */
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const HEADER_READ_BYTES = 64 * 1024;
/** Bounded scan for a first user message that is not in the head window. */
const FIRST_PROMPT_SCAN_BYTES = 16 * 1024 * 1024;
const PARALLEL_FILE_READ_LIMIT = 32;
const SUMMARY_CHARS = 200;
/** `<ISO-ts>_<id>.jsonl`; ids are uuidv7 today, older files use other shapes. */
const SESSION_FILE_RE = /^.+_[0-9A-Za-z-]+\.jsonl$/;

export interface OmpSessionHeader {
  id: string;
  cwd: string;
  timestamp: string;
  title?: string;
  parentSession?: string;
}

interface OmpFileSummary {
  header: OmpSessionHeader;
  hasUserMessage: boolean;
  firstPrompt: string;
  lastPrompt?: string;
  summary?: string;
  name?: string;
  ompSettings?: OmpSettings;
}

interface EnvOption {
  env?: NodeJS.ProcessEnv;
}

// ---- caches ----

/** Headers never change after a file is created (a rename rewrites line 1 only). */
const headerCache = new Map<string, OmpSessionHeader>();
const summaryCache = new Map<string, { mtimeMs: number; size: number; summary: OmpFileSummary }>();
/** sessionId → session file, filled by scans. */
const sessionFileIndex = new Map<string, string>();

/** Test hook: forget every cached header, summary and file path. */
export function clearOmpSessionCaches(): void {
  headerCache.clear();
  summaryCache.clear();
  sessionFileIndex.clear();
}

// ---- header ----

/** Line 1 is a fixed 256-byte title slot, line 2 the `session` header (legacy files: line 1). */
export async function readOmpSessionHeader(file: string): Promise<OmpSessionHeader | null> {
  const key = resolve(file);
  const cached = headerCache.get(key);
  if (cached) return cached;
  let lines: string[];
  try {
    lines = await readLeadingLines(key, 2);
  } catch {
    return null;
  }
  for (const line of lines) {
    const entry = parseJson(line);
    if (!entry) continue;
    if (entry.type === "title") continue;
    const header = toHeader(entry);
    if (header) headerCache.set(key, header);
    return header;
  }
  return null;
}

function toHeader(entry: JsonRecord): OmpSessionHeader | null {
  if (entry.type !== "session" || typeof entry.id !== "string" || !entry.id) return null;
  return {
    id: entry.id,
    cwd: typeof entry.cwd === "string" ? entry.cwd : "",
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
    ...(typeof entry.title === "string" && entry.title ? { title: entry.title } : {}),
    ...(typeof entry.parentSession === "string" && entry.parentSession
      ? { parentSession: entry.parentSession }
      : {}),
  };
}

/** The first `count` complete lines, reading only as much as needed. */
async function readLeadingLines(file: string, count: number): Promise<string[]> {
  const head = await readWindow(file, 0, HEADER_READ_BYTES);
  const parts = head.split("\n");
  if (parts.length > count) return parts.slice(0, count);
  // A header above the window (many additional directories): stream it.
  const lines: string[] = [];
  await readJsonlLines(file, {
    maxLineChars: FIRST_PROMPT_SCAN_BYTES,
    onLine: (line) => {
      if (typeof line === "string") lines.push(line);
      return lines.length < count;
    },
  });
  return lines;
}

async function readWindow(file: string, start: number, length: number): Promise<string> {
  if (length <= 0) return "";
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

// ---- per-file summary ----

const RE_PARTIAL_MESSAGE = /"type"\s*:\s*"message"/;
const RE_PARTIAL_ROLE = /"role"\s*:\s*"(user|assistant)"/;
const RE_PARTIAL_TEXT = /"text"\s*:\s*"((?:\\.|[^"\\])*)/;

interface WindowFacts {
  slotTitle?: string;
  userTexts: string[];
  assistantTexts: string[];
  lastTitleChange?: string;
  lastModel?: string;
  lastThinkingLevel?: OmpThinkingLevel | null;
}

function scanLines(lines: string[], facts: WindowFacts, allowSlot: boolean): void {
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const entry = parseJson(line);
    if (!entry) {
      scanPartialLine(line, facts);
      return;
    }
    switch (entry.type) {
      case "title":
        if (allowSlot && index === 0 && typeof entry.title === "string") {
          facts.slotTitle = entry.title;
        }
        return;
      case "title_change":
        if (typeof entry.title === "string" && entry.title) facts.lastTitleChange = entry.title;
        return;
      case "model_change":
        if (typeof entry.model === "string" && entry.model) facts.lastModel = entry.model;
        return;
      case "thinking_level_change":
        facts.lastThinkingLevel = isOmpThinkingLevel(entry.thinkingLevel)
          ? entry.thinkingLevel
          : null;
        return;
      case "message": {
        const message = isRecord(entry.message) ? entry.message : undefined;
        if (!message) return;
        if (message.role === "user" && message.synthetic !== true) {
          facts.userTexts.push(ompMessageText(message.content));
        } else if (message.role === "assistant") {
          const text = ompMessageText(message.content).trim();
          if (text) facts.assistantTexts.push(text);
        }
        return;
      }
      default:
        return;
    }
  });
}

/** A `message` line cut by a window boundary: recover role and the first text. */
function scanPartialLine(line: string, facts: WindowFacts): void {
  if (!RE_PARTIAL_MESSAGE.test(line)) return;
  const role = line.match(RE_PARTIAL_ROLE)?.[1];
  const raw = line.match(RE_PARTIAL_TEXT)?.[1];
  if (!role || raw === undefined) return;
  const text = decodeJsonStringPrefix(raw);
  if (role === "user") facts.userTexts.push(text);
  else if (text.trim()) facts.assistantTexts.push(text.trim());
}

async function summarizeSessionFile(
  file: string,
  size: number,
  header: OmpSessionHeader,
): Promise<OmpFileSummary> {
  const head: WindowFacts = { userTexts: [], assistantTexts: [] };
  let tail: WindowFacts;
  if (size <= HEAD_BYTES + TAIL_BYTES) {
    scanLines((await readWindow(file, 0, size)).split("\n"), head, true);
    tail = head;
  } else {
    scanLines((await readWindow(file, 0, HEAD_BYTES)).split("\n"), head, true);
    tail = { userTexts: [], assistantTexts: [] };
    scanLines((await readWindow(file, size - TAIL_BYTES, TAIL_BYTES)).split("\n"), tail, false);
  }

  let firstPrompt: string | undefined = head.userTexts[0];
  if (firstPrompt === undefined && tail !== head) {
    firstPrompt = await scanForFirstUserText(file);
  }
  firstPrompt ??= tail.userTexts[0];
  const hasUserMessage = firstPrompt !== undefined;
  const lastUser = tail.userTexts.at(-1);
  const lastAssistant = tail.assistantTexts.at(-1);
  const model = tail.lastModel ?? head.lastModel;
  const thinking =
    tail.lastThinkingLevel !== undefined ? tail.lastThinkingLevel : head.lastThinkingLevel;
  const ompSettings: OmpSettings = {
    ...(model ? { model } : {}),
    ...(thinking ? { thinkingLevel: thinking } : {}),
  };
  const name = resolveSessionName(
    head.slotTitle,
    tail.lastTitleChange,
    head.lastTitleChange,
    header.title,
  );
  return {
    header,
    hasUserMessage,
    firstPrompt: firstPrompt ?? "",
    ...(lastUser !== undefined && lastUser !== firstPrompt ? { lastPrompt: lastUser } : {}),
    ...(lastAssistant ? { summary: lastAssistant.slice(0, SUMMARY_CHARS) } : {}),
    ...(name ? { name } : {}),
    ...(Object.keys(ompSettings).length > 0 ? { ompSettings } : {}),
  };
}

/**
 * Session name (§6.1): the last `title_change` in the tail window if it
 * extends the slot title (the slot keeps only 256 bytes), else the slot title,
 * else the header title, else the last `title_change` (legacy files without a
 * slot). A `title_change` from the head window never overrides the slot: a
 * later rename between the windows may have replaced it. A rename does not
 * rewrite the header.
 */
function resolveSessionName(
  slotTitle: string | undefined,
  tailTitleChange: string | undefined,
  headTitleChange: string | undefined,
  headerTitle: string | undefined,
): string | undefined {
  if (slotTitle !== undefined) {
    if (tailTitleChange && tailTitleChange.startsWith(slotTitle)) return tailTitleChange;
    return slotTitle || headerTitle || undefined;
  }
  return headerTitle || tailTitleChange || headTitleChange || undefined;
}

async function scanForFirstUserText(file: string): Promise<string | undefined> {
  let found: string | undefined;
  await readJsonlLines(file, {
    maxLineChars: FIRST_PROMPT_SCAN_BYTES,
    maxBytes: FIRST_PROMPT_SCAN_BYTES,
    onLine: (line) => {
      const facts: WindowFacts = { userTexts: [], assistantTexts: [] };
      if (typeof line === "string") scanLines([line], facts, false);
      else scanPartialLine(line.prefix, facts);
      if (facts.userTexts.length > 0) {
        found = facts.userTexts[0];
        return false;
      }
    },
  });
  return found;
}

async function cachedSummary(file: string): Promise<OmpFileSummary | null> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  const cached = summaryCache.get(file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.summary;
  }
  const header = await readOmpSessionHeader(file);
  if (!header) return null;
  let summary: OmpFileSummary;
  try {
    summary = await summarizeSessionFile(file, info.size, header);
  } catch (err) {
    // Unreadable, or removed after the stat (omp archives files): skip this
    // file only, as for a failed stat or header read.
    summaryCache.delete(file);
    console.warn(
      `[omp-sessions] Skipping unreadable session file ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  summaryCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, summary });
  return summary;
}

// ---- listing ----

/** Session buckets to scan: one per cwd, or the flat `PI_CODING_AGENT_SESSION_DIR`. */
async function listBuckets(env: NodeJS.ProcessEnv): Promise<string[]> {
  const store = resolveOmpStore(env);
  // omp refuses to run with an invalid profile, so none of its sessions can be
  // resumed from this environment.
  if (store.invalidProfile !== undefined) return [];
  if (store.flatSessionDir) return [store.flatSessionDir];
  let entries: Dirent[];
  try {
    entries = await readdir(store.sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(store.sessionsDir, entry.name));
}

async function listSessionFiles(bucket: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(bucket, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && SESSION_FILE_RE.test(entry.name))
    .map((entry) => join(bucket, entry.name));
}

/**
 * Recent omp sessions from omp's own session store (docs/omp-integration.md
 * §6.1). Every bucket is listed: `getAllRecentSessions` filters by project
 * after grouping worktree sessions under their git repository, which a bucket
 * name or header cwd alone cannot tell (§15.7).
 */
export async function listOmpRecentSessions(
  options: EnvOption = {},
): Promise<OmpRecentSession[]> {
  const env = options.env ?? process.env;
  const buckets = await listBuckets(env);
  const files: string[] = [];
  for (const bucket of buckets) {
    files.push(...(await listSessionFiles(bucket)));
  }

  const summaries = await parallelMap(files, PARALLEL_FILE_READ_LIMIT, async (file) => {
    const summary = await cachedSummary(file);
    if (!summary) return null;
    sessionFileIndex.set(summary.header.id, file);
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(file)).mtimeMs;
    } catch {
      return null;
    }
    return summary.hasUserMessage ? toRecentSession(summary, mtimeMs) : null;
  });
  return summaries
    .filter((entry): entry is OmpRecentSession => entry !== null)
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

function toRecentSession(summary: OmpFileSummary, mtimeMs: number): OmpRecentSession {
  const cwd = summary.header.cwd;
  const projectPath = cwd ? normalizeWorktreePath(cwd) : "";
  return {
    sessionId: summary.header.id,
    provider: "omp",
    ...(summary.name ? { name: summary.name } : {}),
    ...(summary.summary ? { summary: summary.summary } : {}),
    firstPrompt: summary.firstPrompt,
    ...(summary.lastPrompt ? { lastPrompt: summary.lastPrompt } : {}),
    created: summary.header.timestamp,
    modified: new Date(mtimeMs).toISOString(),
    gitBranch: "",
    projectPath,
    ...(cwd && cwd !== projectPath ? { resumeCwd: cwd } : {}),
    isSidechain: false,
    ...(summary.ompSettings ? { ompSettings: summary.ompSettings } : {}),
  };
}

/** The session file of an omp session id: from earlier scans, else a bucket scan. */
export async function findOmpSessionFile(
  sessionId: string,
  options: EnvOption = {},
): Promise<string | null> {
  if (!sessionId || sessionId.includes("/") || sessionId.includes("\\")) return null;
  const known = sessionFileIndex.get(sessionId);
  if (known && existsSync(known)) return known;
  const suffix = `_${sessionId}.jsonl`;
  for (const bucket of await listBuckets(options.env ?? process.env)) {
    for (const file of await listSessionFiles(bucket)) {
      if (!basename(file).endsWith(suffix)) continue;
      const header = await readOmpSessionHeader(file);
      if (header?.id !== sessionId) continue;
      sessionFileIndex.set(sessionId, file);
      return file;
    }
  }
  return null;
}

/** The listing's name of an omp session, also for sessions without a user message. */
export async function getOmpSessionName(
  sessionId: string,
  options: EnvOption = {},
): Promise<string | null> {
  const file = await findOmpSessionFile(sessionId, options);
  if (!file) return null;
  return (await cachedSummary(file))?.name ?? null;
}

/** Model and thinking level recorded in a session file. */
export async function getOmpSessionSettings(
  file: string,
): Promise<OmpSettings | undefined> {
  return (await cachedSummary(resolve(file)))?.ompSettings;
}

// ---- rename of a session that is not running ----

const RENAME_EXIT_TIMEOUT_MS = 20_000;
const KILL_GRACE_MS = 5_000;

/**
 * Rename a stopped omp session through a short-lived `omp --mode rpc
 * --resume <file>` process (omp owns the file format). Acquires the file in
 * the writer registry first and holds it until the helper has exited.
 * Resolves false when the session file does not exist.
 */
export async function renameOmpRecentSession(params: {
  sessionId: string;
  name: string;
  projectPath?: string;
  env?: NodeJS.ProcessEnv;
  writers?: OmpWriterRegistry;
}): Promise<boolean> {
  const env = params.env ?? process.env;
  const writers = params.writers ?? ompWriters;
  const file = await findOmpSessionFile(params.sessionId, { env });
  if (!file) return false;
  const header = await readOmpSessionHeader(file);
  const cwd = [header?.cwd, params.projectPath].find(
    (candidate): candidate is string => !!candidate && existsSync(candidate),
  ) ?? homedir();

  // Reserved from before the spawn until the helper exits (§6.7).
  const reservation = await writers.acquire(file, {
    owner: `omp-rename:${params.sessionId}`,
    sessionId: params.sessionId,
  });
  const transport = new OmpRpcTransport({ logPrefix: "[omp-rename]" });
  reservation.holdUntil(transport.exited);
  const renamed = new Promise<void>((resolveRename, rejectRename) => {
    transport.once("failed", rejectRename);
    transport.once("exit", () =>
      rejectRename(ompError("omp_process_exited", "omp exited before the rename finished")),
    );
    transport.once("negotiated", () => {
      transport.openOutbox();
      transport.request({ type: "set_session_name", name: params.name }).then(
        () => resolveRename(),
        (err: unknown) => rejectRename(err),
      );
    });
  });
  transport.start({
    command: resolveOmpBin(env),
    args: [
      "--mode",
      "rpc",
      "--cwd",
      cwd,
      "--allow-home",
      "--approval-mode",
      "always-ask",
      "--no-skills",
      "--no-extensions",
      "--no-rules",
      "--no-lsp",
      "--resume",
      file,
    ],
    options: { cwd, stdio: "pipe", env: sanitizedOmpEnv(env) },
  });
  try {
    await renamed;
  } finally {
    transport.endInput();
    await waitForExit(transport);
  }
  summaryCache.delete(file);
  return true;
}

async function waitForExit(transport: OmpRpcTransport): Promise<void> {
  if (await exitsWithin(transport, RENAME_EXIT_TIMEOUT_MS)) return;
  transport.kill("SIGTERM");
  if (await exitsWithin(transport, KILL_GRACE_MS)) return;
  transport.kill("SIGKILL");
}

async function exitsWithin(transport: OmpRpcTransport, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const exited = await Promise.race([
    transport.exited.then(() => true),
    new Promise<boolean>((resolveTimer) => {
      timer = setTimeout(() => resolveTimer(false), ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return exited;
}

// ---- model catalogue ----

const MODELS_TIMEOUT_MS = 15_000;
const MODELS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * The omp model catalogue from `omp models --json` (no session process).
 * `not_installed`: the binary is missing. `no_models`: an empty list (no
 * provider credentials) or a non-zero exit. A timeout, an oversized or
 * unparseable output rejects, so callers keep their previous list.
 */
export function listOmpModels(
  options: EnvOption = {},
): Promise<{ models: OmpModelInfo[]; availability: OmpAvailability }> {
  const env = options.env ?? process.env;
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let stdout = "";
    let bytes = 0;
    const finish = (
      error: Error | null,
      value?: { models: OmpModelInfo[]; availability: OmpAvailability },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(value!);
    };
    const child = spawn(resolveOmpBin(env), ["models", "--json"], {
      cwd: homedir(),
      env: sanitizedOmpEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(ompError("omp_models_failed", "omp models --json did not finish within 15 s"));
    }, MODELS_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MODELS_MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(ompError("omp_models_failed", "omp models --json output exceeded 8 MiB"));
        return;
      }
      stdout += chunk;
    });
    child.stderr?.on("data", () => {
      // omp models writes nothing useful to stderr; drain it.
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        finish(null, { models: [], availability: "not_installed" });
        return;
      }
      finish(ompError("omp_models_failed", `omp models could not be started: ${err.message}`));
    });
    onChildClosed(child, (code) => {
      if (code !== 0) {
        finish(null, { models: [], availability: "no_models" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        finish(ompError("omp_models_failed", "omp models --json printed invalid JSON"));
        return;
      }
      const models = parseOmpModels(parsed);
      finish(null, { models, availability: models.length > 0 ? "available" : "no_models" });
    });
  });
}

/** `{models:[{provider, id, selector, name, thinking, input, …}]}` → wire shape. */
export function parseOmpModels(value: unknown): OmpModelInfo[] {
  const list = isRecord(value) && Array.isArray(value.models) ? value.models : [];
  const models: OmpModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!isRecord(raw) || typeof raw.provider !== "string") continue;
    if (raw.kind !== undefined && raw.kind !== "chat") continue;
    const selector =
      typeof raw.selector === "string" && raw.selector
        ? raw.selector
        : typeof raw.id === "string"
          ? `${raw.provider}/${raw.id}`
          : undefined;
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    models.push({
      selector,
      provider: raw.provider,
      name: typeof raw.name === "string" && raw.name ? raw.name : selector,
      thinkingLevels: ompThinkingLevelsFor(raw.thinking),
      input: Array.isArray(raw.input)
        ? raw.input.filter((entry): entry is string => typeof entry === "string")
        : [],
    });
  }
  return models;
}

// ---- helpers ----

function parseJson(line: string): JsonRecord | null {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function parallelMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}
