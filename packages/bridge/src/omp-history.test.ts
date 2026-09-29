import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractOmpMessageImages,
  getOmpSessionHistory,
  OmpHistoryTargetNotFoundError,
  readOmpBlob,
} from "./omp-history.js";
import { clearOmpSessionCaches } from "./omp-sessions.js";

const FIXTURES = fileURLToPath(new URL("./omp-fixtures/", import.meta.url));
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

type Entry = Record<string, unknown>;

let dir: string;
let blobsDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omp-history-"));
  blobsDir = join(dir, "agent", "blobs");
  await mkdir(blobsDir, { recursive: true });
  clearOmpSessionCaches();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function titleSlot(title = ""): string {
  const base = JSON.stringify({ type: "title", v: 1, title, updatedAt: "2026-09-28T20:00:00.000Z", pad: "" });
  return base.replace('"pad":""', `"pad":"${" ".repeat(Math.max(0, 255 - base.length))}"`);
}

async function writeSession(entries: Entry[], name = "2026-09-28T20-00-00-000Z_s1.jsonl"): Promise<string> {
  const file = join(dir, name);
  const lines = [
    titleSlot(),
    JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-09-28T20:00:00.000Z", cwd: "/proj" }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ];
  await writeFile(file, `${lines.join("\n")}\n`);
  return file;
}

function chain(entries: Array<Omit<Entry, "id" | "parentId"> & { id?: string }>): Entry[] {
  let parentId: string | null = null;
  return entries.map((entry, index) => {
    const id = entry.id ?? `e${index + 1}`;
    const full = { ...entry, id, parentId, timestamp: `2026-09-28T20:00:${String(index).padStart(2, "0")}.000Z` };
    parentId = id;
    return full;
  });
}

const user = (content: unknown, extra: Entry = {}) => ({ type: "message", message: { role: "user", content, ...extra } });
const assistant = (content: unknown, extra: Entry = {}) => ({ type: "message", message: { role: "assistant", content, ...extra } });
const toolResult = (toolCallId: string, toolName: string, content: unknown, extra: Entry = {}) => ({
  type: "message",
  message: { role: "toolResult", toolCallId, toolName, content, isError: false, ...extra },
});

async function copyFixture(name: string): Promise<string> {
  const target = join(dir, name);
  await copyFile(join(FIXTURES, name), target);
  return target;
}

describe("getOmpSessionHistory (§6.2)", () => {
  it("follows the active branch from the last entry of a branched file", async () => {
    // OBSERVED V4: ONE → TWO, then SIDE BRANCH PROMPT branched off after ONE.
    const file = await copyFixture("session-v4-renamed-side-branch.jsonl");
    const { messages, lastEntryId } = await getOmpSessionHistory(file, { blobsDir });
    expect(lastEntryId).toBe("72da089b");
    expect(messages.map((message) => [message.role, message.uuid, message.content])).toEqual([
      ["user", "omp:entry:4e2f6292", "Reply with exactly: ONE"],
      ["assistant", undefined, [{ type: "text", text: "ONE" }]],
      ["user", "omp:entry:5eed0001", "SIDE BRANCH PROMPT"],
    ]);
    expect(messages[0].timestamp).toBe("2026-09-28T20:14:31.479Z");
  });

  it("cuts the path before untilEntryId", async () => {
    const file = await copyFixture("session-v4-renamed-side-branch.jsonl");
    const { messages } = await getOmpSessionHistory(file, { untilEntryId: "5eed0001", blobsDir });
    expect(messages.map((message) => message.content)).toEqual([
      "Reply with exactly: ONE",
      [{ type: "text", text: "ONE" }],
    ]);
  });

  it("rejects a rewind target that is not a user entry on the active path", async () => {
    const file = await copyFixture("session-v4-renamed-side-branch.jsonl");
    // TWO lives on the abandoned in-file branch; 0adec650 is an assistant entry.
    await expect(getOmpSessionHistory(file, { untilEntryId: "87d55edf", blobsDir })).rejects.toBeInstanceOf(
      OmpHistoryTargetNotFoundError,
    );
    await expect(getOmpSessionHistory(file, { untilEntryId: "0adec650", blobsDir })).rejects.toBeInstanceOf(
      OmpHistoryTargetNotFoundError,
    );
    await expect(getOmpSessionHistory(file, { untilEntryId: "missing", blobsDir })).rejects.toBeInstanceOf(
      OmpHistoryTargetNotFoundError,
    );
  });

  it("stops at a parent cycle", async () => {
    const file = await writeSession([
      { type: "message", id: "a", parentId: "b", message: { role: "user", content: "A" } },
      { type: "message", id: "b", parentId: "a", message: { role: "user", content: "B" } },
    ]);
    const { messages } = await getOmpSessionHistory(file, { blobsDir });
    expect(messages.map((message) => message.content)).toEqual(["A", "B"]);
  });

  it("maps user content given as a string or as blocks and skips injected context", async () => {
    const file = await writeSession(
      chain([
        user("plain text"),
        user([{ type: "text", text: "block one" }, { type: "text", text: "block two" }]),
        user("injected", { synthetic: true }),
        { type: "message", message: { role: "developer", content: "system note" } },
        { type: "model_usage", model: "x" },
        { type: "model_change", model: "baseten/x" },
        { type: "compaction", summary: "…" },
        { type: "custom", customType: "session_exit", data: {} },
      ]),
    );
    const { messages } = await getOmpSessionHistory(file, { blobsDir });
    expect(messages.map((message) => message.content)).toEqual(["plain text", "block one\nblock two"]);
  });

  it("maps assistant blocks, tool calls and results like the live path", async () => {
    // OBSERVED P6 session: thinking + glob, then read of an image.
    const file = await copyFixture("session-p6-image-tools.jsonl");
    const { messages } = await getOmpSessionHistory(file, { blobsDir });
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool_result",
      "assistant",
      "tool_result",
      "assistant",
    ]);
    const [prompt, globCall, globResult, readCall, readResult, answer] = messages;
    expect(prompt).toMatchObject({ imageCount: 1 });
    expect(prompt.ompImages).toBeUndefined(); // inline base64 only counts
    expect(globCall.content).toEqual([
      { type: "thinking", thinking: expect.stringContaining("single pixel") },
      {
        type: "tool_use",
        id: "chatcmpl-tool-7c1a972969a84acbb3e3b7b53e1a1aa7",
        name: "Glob",
        input: { pattern: "/tmp/omp-design/probe-06" },
      },
    ]);
    expect(globResult).toMatchObject({
      toolUseId: "chatcmpl-tool-7c1a972969a84acbb3e3b7b53e1a1aa7",
      toolName: "Glob",
      content: expect.stringContaining("red.png"),
    });
    expect(readCall.content).toEqual([
      {
        type: "tool_use",
        id: "chatcmpl-tool-2d73a66889c84d8db03ce87594426613",
        name: "Read",
        input: { file_path: "/tmp/omp-design/probe-06/red.png" },
      },
    ]);
    expect(readResult).toMatchObject({ toolName: "Read", content: expect.stringContaining("Read image file") });
    expect(JSON.stringify(readResult)).not.toContain("UklGR");
    expect(answer.content).toEqual([{ type: "text", text: "Red." }]);
  });

  it("maps bash executions run by the user to a Bash call and result", async () => {
    // OBSERVED P8: RPC bash persists a bashExecution message.
    const file = await copyFixture("session-p8-bash-execution.jsonl");
    const { messages } = await getOmpSessionHistory(file, { blobsDir });
    expect(messages.slice(2, 4)).toEqual([
      {
        role: "assistant",
        timestamp: "2026-09-28T18:59:44.125Z",
        content: [{ type: "tool_use", id: "omp:entry:74891ae9", name: "Bash", input: { command: "pwd" } }],
      },
      {
        role: "tool_result",
        timestamp: "2026-09-28T18:59:44.125Z",
        toolUseId: "omp:entry:74891ae9",
        toolName: "Bash",
        content: "/tmp/omp-design/probe-08/a",
      },
    ]);
  });

  it("maps python executions, exit codes and custom messages", async () => {
    const file = await writeSession(
      chain([
        { type: "message", message: { role: "pythonExecution", code: "print(1/0)", output: "ZeroDivisionError", exitCode: 1 } },
        { type: "custom_message", customType: "skill", display: true, attribution: "user", content: "/skill:review" },
        { type: "custom_message", customType: "notice", display: true, content: [{ type: "text", text: "Job finished" }] },
        { type: "custom_message", customType: "hidden", display: false, content: "internal" },
      ]),
    );
    const { messages } = await getOmpSessionHistory(file, { blobsDir });
    expect(messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "tool_use", id: "omp:entry:e1", name: "eval", input: { code: "print(1/0)" } }],
      }),
      expect.objectContaining({ role: "tool_result", toolName: "eval", content: "ZeroDivisionError\n[exit code 1]" }),
      expect.objectContaining({ role: "user", content: "/skill:review" }),
      expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "Job finished" }] }),
    ]);
    expect(messages[2].uuid).toBeUndefined();
  });

  it("builds TodoWrite from the paired result's phases", async () => {
    const phases = [{ name: "Work", tasks: [{ content: "A", status: "completed" }, { content: "B", status: "in_progress" }] }];
    const file = await writeSession(
      chain([
        assistant([{ type: "toolCall", id: "t1", name: "todo", arguments: { i: "Planning", op: "init" } }]),
        toolResult("t1", "todo", [{ type: "text", text: "Todo list updated" }], { details: { op: "init", phases } }),
        assistant([{ type: "toolCall", id: "t2", name: "todo", arguments: { op: "view" } }]),
        toolResult("t2", "todo", [{ type: "text", text: "bad op" }], { isError: true }),
      ]),
    );
    const { messages } = await getOmpSessionHistory(file, { blobsDir });
    expect(messages[0].content).toEqual([
      {
        type: "tool_use",
        id: "t1",
        name: "TodoWrite",
        input: {
          title: "Todo",
          todos: [
            { content: "A", status: "completed", activeForm: "" },
            { content: "B", status: "in_progress", activeForm: "" },
          ],
        },
      },
    ]);
    expect(messages[1]).toMatchObject({ toolUseId: "t1", toolName: "TodoWrite", content: "Todo list updated" });
    expect(messages[2].content).toEqual([{ type: "tool_use", id: "t2", name: "todo", input: { op: "view" } }]);
    expect(messages[3]).toMatchObject({ toolName: "todo", content: "bad op" });
  });

  it("renders edit results as unified diffs", async () => {
    const file = await writeSession(
      chain([
        assistant([{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "a.ts", old_string: "1", new_string: "2" } }]),
        toolResult("c1", "edit", [{ type: "text", text: "[a.ts#1234]" }], { details: { diff: "-1|x = 1\n+1|x = 2", path: "a.ts" } }),
        assistant([{ type: "toolCall", id: "c2", name: "apply_patch", arguments: { input: "*** Begin Patch\n*** Add File: b.txt\n+hi\n*** End Patch" } }]),
        toolResult("c2", "apply_patch", [{ type: "text", text: "Added b.txt" }]),
      ]),
    );
    const { messages } = await getOmpSessionHistory(file, { blobsDir });
    expect(messages[0].content).toEqual([
      { type: "tool_use", id: "c1", name: "Edit", input: { file_path: "a.ts", old_string: "1", new_string: "2" } },
    ]);
    expect(messages[1]).toMatchObject({
      toolName: "Edit",
      content: "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-x = 1\n+x = 2",
    });
    expect(messages[2].content).toEqual([
      { type: "tool_use", id: "c2", name: "FileChange", input: { changes: [{ path: "b.txt", kind: "add", diff: "+hi" }] } },
    ]);
    expect(messages[3]).toMatchObject({ toolName: "FileChange", content: "Added b.txt" });
  });

  it("shows a provider error of an empty assistant message", async () => {
    // OBSERVED P12b: content [], stopReason error, errorMessage
    const file = await writeSession(
      chain([
        user("Reply with exactly: OK"),
        assistant([], { stopReason: "error", errorMessage: "403 please check the api-key you provided" }),
        assistant([], { stopReason: "aborted", errorMessage: "Interrupted by user" }),
      ]),
    );
    const { messages } = await getOmpSessionHistory(file, { blobsDir });
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toEqual([{ type: "text", text: "Error: 403 please check the api-key you provided" }]);
  });

  it("references blob images and only counts the rest", async () => {
    await writeFile(join(blobsDir, HASH_A), Buffer.from([1, 2, 3]));
    await writeFile(join(blobsDir, HASH_B), Buffer.alloc(8 * 1024 * 1024 + 1));
    const images = [
      { type: "image", data: `blob:sha256:${HASH_A}`, mimeType: "image/webp" },
      { type: "image", data: "blob:sha256:../../etc/passwd", mimeType: "image/png" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      { type: "image", data: `blob:sha256:${HASH_B}`, mimeType: "image/png" },
      { type: "image", data: `blob:sha256:${"c".repeat(64)}`, mimeType: "image/png" },
    ];
    const budget = Array.from({ length: 6 }, () => ({ type: "image", data: `blob:sha256:${HASH_A}`, mimeType: "image/png" }));
    const file = await writeSession(
      chain([
        user([{ type: "text", text: "look" }, ...images]),
        user([{ type: "text", text: "many" }, ...budget]),
        toolResult("r1", "read", [{ type: "image", data: `blob:sha256:${HASH_A}`, mimeType: "image/webp" }]),
      ]),
    );
    const { messages } = await getOmpSessionHistory(file, { blobsDir });
    // A: valid; traversal attempt: not a hash; inline: counted; B: above 8 MiB; c…: missing.
    expect(messages[0]).toMatchObject({
      imageCount: 5,
      ompImages: [{ blob: HASH_A, mimeType: "image/webp" }],
    });
    expect(messages[1].imageCount).toBe(6);
    expect(messages[1].ompImages).toHaveLength(4);
    expect(messages[2].ompImages).toEqual([{ blob: HASH_A, mimeType: "image/webp" }]);
    expect(JSON.stringify(messages)).not.toContain("iVBORw0KGgo");
  });

  it("compacts large tool items and keeps short ones", async () => {
    const big = "x".repeat(5000);
    const file = await writeSession(
      chain([
        assistant([{ type: "toolCall", id: "c1", name: "write", arguments: { path: "a.txt", content: big } }]),
        toolResult("c1", "write", [{ type: "text", text: big }]),
        assistant([{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } }]),
      ]),
    );
    const { messages } = await getOmpSessionHistory(file, {
      blobsDir,
      limits: { maxToolItemChars: 1000, truncatedStringChars: 100 },
    });
    const call = (messages[0].content as Array<{ input?: Record<string, unknown> }>)[0];
    expect(call.input?.content).toBe(`${"x".repeat(100)}\n[Truncated in Bridge history]`);
    expect(messages[1].content).toBe(`${"x".repeat(100)}\n[Truncated in Bridge history]`);
    expect((messages[2].content as Array<{ input?: unknown }>)[0].input).toEqual({ command: "ls" });
  });

  it("fails with omp_history_too_large above the total cap", async () => {
    const file = await writeSession(chain(Array.from({ length: 20 }, (_, index) => user(`message ${index} ${"y".repeat(100)}`))));
    await expect(getOmpSessionHistory(file, { blobsDir, limits: { maxTotalChars: 1000 } })).rejects.toMatchObject({
      code: "omp_history_too_large",
    });
  });

  it("replaces a line above the line limit with a marker and keeps the tree", async () => {
    const entries = chain([
      user("before"),
      assistant([{ type: "text", text: "z".repeat(3000) }]),
      user("after"),
    ]);
    const file = await writeSession(entries);
    const { messages } = await getOmpSessionHistory(file, { blobsDir, limits: { maxLineChars: 1000 } });
    expect(messages.map((message) => message.content)).toEqual([
      "before",
      [{ type: "text", text: "[omitted line]" }],
      "after",
    ]);
  });

  it("returns no messages and no cursor for a file without entries", async () => {
    const file = await writeSession([]);
    await expect(getOmpSessionHistory(file, { blobsDir })).resolves.toEqual({ messages: [], lastEntryId: null });
  });
});

describe("omp blobs and lazy images", () => {
  it("reads a blob by a validated hash", async () => {
    await writeFile(join(blobsDir, HASH_A), Buffer.from("png-bytes"));
    await expect(readOmpBlob(HASH_A, { blobsDir })).resolves.toEqual({ base64: Buffer.from("png-bytes").toString("base64") });
    await expect(readOmpBlob("../x", { blobsDir })).resolves.toBeNull();
    await expect(readOmpBlob(HASH_B, { blobsDir })).resolves.toBeNull();
  });

  it("extracts the images of one user message from the session file", async () => {
    const agentDir = join(dir, "agent");
    const bucket = join(agentDir, "sessions", "-proj");
    await mkdir(bucket, { recursive: true });
    await writeFile(join(blobsDir, HASH_A), Buffer.from("blob-image"));
    const entries = chain([
      user([{ type: "text", text: "one" }, { type: "image", data: "aW5saW5l", mimeType: "image/png" }], {}),
      user([{ type: "text", text: "two" }, { type: "image", data: `blob:sha256:${HASH_A}`, mimeType: "image/webp" }]),
    ]);
    const lines = [
      titleSlot(),
      JSON.stringify({ type: "session", version: 3, id: "img-session", timestamp: "2026-09-28T20:00:00.000Z", cwd: "/proj" }),
      ...entries.map((entry) => JSON.stringify(entry)),
    ];
    await writeFile(join(bucket, "2026-09-28T20-00-00-000Z_img-session.jsonl"), `${lines.join("\n")}\n`);
    const env = { PI_CODING_AGENT_DIR: agentDir };
    await expect(extractOmpMessageImages("img-session", "omp:entry:e1", { env })).resolves.toEqual([
      { base64: "aW5saW5l", mimeType: "image/png" },
    ]);
    await expect(extractOmpMessageImages("img-session", "omp:entry:e2", { env })).resolves.toEqual([
      { base64: Buffer.from("blob-image").toString("base64"), mimeType: "image/webp" },
    ]);
    await expect(extractOmpMessageImages("img-session", "codex:user-turn:1", { env })).resolves.toEqual([]);
    await expect(extractOmpMessageImages("missing", "omp:entry:e1", { env })).resolves.toEqual([]);
  });
});
