import { describe, expect, it } from "vitest";
import {
  canonicalToolInput,
  canonicalToolName,
  convertOmpDiff,
  ompAskQuestions,
  ompCallIntent,
  ompEditChanges,
  ompEditResultDiff,
  ompEditTargetPaths,
  ompInternalToolName,
  ompMessageText,
  ompResultImageBlocks,
  ompTodoPhases,
  ompTodoWriteInput,
  ompToolResultContent,
  stripOmpIntent,
} from "./omp-tool-mapping.js";

function mapped(name: string, rawArgs: Record<string, unknown>, intent?: string) {
  const internal = ompInternalToolName(name);
  const args = stripOmpIntent(rawArgs);
  return {
    name: canonicalToolName(internal, args),
    input: canonicalToolInput(internal, args, ompCallIntent(intent, rawArgs)),
  };
}

describe("omp tool names and inputs (§3.3)", () => {
  it("maps bash to Bash with command, cwd and timeout", () => {
    // OBSERVED P3a: {"i":"Running echo command","command":"echo hi"}
    expect(mapped("bash", { i: "Running echo command", command: "echo hi" })).toEqual({
      name: "Bash",
      input: { command: "echo hi" },
    });
    expect(
      mapped("bash", { command: "ls", cwd: "/tmp", timeout: 30, async: true }).input,
    ).toEqual({ command: "ls", cwd: "/tmp", timeout: 30 });
  });

  it("maps read to Read and keeps a selector suffix", () => {
    expect(mapped("read", { path: "src/a.ts:50-100" })).toEqual({
      name: "Read",
      input: { file_path: "src/a.ts:50-100" },
    });
  });

  it("maps write to Write", () => {
    // OBSERVED P3d
    expect(mapped("write", { i: "Creating note.txt", path: "note.txt", content: "hello" })).toEqual({
      name: "Write",
      input: { file_path: "note.txt", content: "hello" },
    });
  });

  it("maps a replace-mode edit to Edit", () => {
    expect(
      mapped("edit", { path: "a.ts", old_string: "one", new_string: "two", replace_all: true }),
    ).toEqual({
      name: "Edit",
      input: { file_path: "a.ts", old_string: "one", new_string: "two", replace_all: true },
    });
  });

  it("maps a hashline edit to FileChange with one patch section per path", () => {
    const input = [
      "*** Begin Patch",
      "[src/a.ts#1A2B]",
      "PUT 4.=4:",
      "+const value = 2;",
      "[lib/b.ts#3C4D]",
      "REM",
      "*** End Patch",
    ].join("\n");
    expect(mapped("edit", { input })).toEqual({
      name: "FileChange",
      input: {
        changes: [
          { path: "src/a.ts", kind: "update", diff: "PUT 4.=4:\n+const value = 2;" },
          { path: "lib/b.ts", kind: "delete", diff: "REM" },
        ],
      },
    });
  });

  it("merges same-path hashline sections", () => {
    const changes = ompEditChanges({
      input: "[a.ts#AAAA]\nPUT 1.=1:\n+x\n[a.ts#AAAA]\nPUT 5.=5:\n+y",
    });
    expect(changes).toEqual([{ path: "a.ts", kind: "update", diff: "PUT 1.=1:\n+x\nPUT 5.=5:\n+y" }]);
  });

  it("maps the apply_patch wire alias to edit and parses its file sections", () => {
    expect(ompInternalToolName("apply_patch")).toBe("edit");
    const input =
      '*** Begin Patch\n*** Add File: hello.txt\n+Hello world\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@ def greet():\n-print("Hi")\n+print("Hello, world!")\n*** Delete File: obsolete.txt\n*** End Patch\n';
    expect(mapped("apply_patch", { input })).toEqual({
      name: "FileChange",
      input: {
        changes: [
          { path: "hello.txt", kind: "add", diff: "+Hello world" },
          {
            path: "src/app.py",
            kind: "update",
            diff: '*** Move to: src/main.py\n@@ def greet():\n-print("Hi")\n+print("Hello, world!")',
          },
          { path: "obsolete.txt", kind: "delete", diff: "" },
        ],
      },
    });
  });

  it("maps a patch-mode edit to FileChange", () => {
    expect(
      mapped("edit", { path: "src/app.py", edits: [{ op: "update", diff: "@@\n-a\n+b\n" }] }),
    ).toEqual({
      name: "FileChange",
      input: { changes: [{ path: "src/app.py", kind: "update", diff: "@@\n-a\n+b\n" }] },
    });
  });

  it("lists every target path of an edit", () => {
    expect(ompEditTargetPaths({ path: "a.ts", old_string: "x", new_string: "y" })).toEqual(["a.ts"]);
    expect(ompEditTargetPaths({ input: "[a.ts#AAAA]\n+x\n[b.ts#BBBB]\n+y" })).toEqual(["a.ts", "b.ts"]);
  });

  it("maps grep, glob and web_search", () => {
    expect(mapped("grep", { pattern: "TODO", path: "src" })).toEqual({
      name: "Grep",
      input: { pattern: "TODO", path: "src" },
    });
    // omp's glob pattern lives in `path` (OBSERVED P6 disk entry)
    expect(mapped("glob", { i: "Locating attached image file", path: "/tmp/omp-design/probe-06" })).toEqual({
      name: "Glob",
      input: { pattern: "/tmp/omp-design/probe-06" },
    });
    expect(mapped("web_search", { query: "omp rpc" })).toEqual({
      name: "WebSearch",
      input: { query: "omp rpc" },
    });
  });

  it("maps task to Task with description, prompt and tasks", () => {
    const tasks = [{ agent: "task", task: "Summarize the repo" }];
    expect(mapped("task", { context: "Shared context", tasks }, "Exploring the repo")).toEqual({
      name: "Task",
      input: { description: "Exploring the repo", prompt: "Shared context", tasks },
    });
    expect(mapped("task", { context: "ctx", tasks }).input.description).toBe("Summarize the repo");
    expect(mapped("task", { agent: "explore", task: "Find the bug" }).input).toEqual({
      description: "Find the bug",
      prompt: "Find the bug",
      subagent_type: "explore",
    });
  });

  it("maps ask to AskUserQuestion questions without omp's recommended index", () => {
    // OBSERVED P2b tool_execution_start args
    const args = {
      questions: [
        {
          id: "fruits",
          question: "Which fruits do you like?",
          options: [{ label: "apple" }, { label: "banana" }, { label: "cherry" }],
          multi: true,
          recommended: 0,
        },
      ],
    };
    expect(mapped("ask", args)).toEqual({
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            id: "fruits",
            question: "Which fruits do you like?",
            options: [{ label: "apple" }, { label: "banana" }, { label: "cherry" }],
            multiSelect: true,
          },
        ],
      },
    });
    expect(ompAskQuestions({ questions: [{ question: "Q?", options: ["a"], header: "H" }] })).toEqual([
      { id: "q1", question: "Q?", header: "H", options: [{ label: "a" }], multiSelect: false },
    ]);
  });

  it("keeps MCP tools unchanged without the intent", () => {
    expect(mapped("mcp__example_lookup", { i: "Looking up", ip: "1.1.1.1" })).toEqual({
      name: "mcp__example_lookup",
      input: { ip: "1.1.1.1" },
    });
  });

  it("adds description: intent only to unmapped tools without a description", () => {
    expect(mapped("eval", { i: "Computing", code: "1+1" })).toEqual({
      name: "eval",
      input: { code: "1+1", description: "Computing" },
    });
    expect(mapped("find", { description: "own", pattern: "*.ts" }, "block intent").input).toEqual({
      description: "own",
      pattern: "*.ts",
    });
    expect(mapped("wait", { seconds: 3 }).input).toEqual({ seconds: 3 });
  });

  it("prefers the block intent over the i argument", () => {
    expect(ompCallIntent("from block", { i: "from args" })).toBe("from block");
    expect(ompCallIntent(undefined, { i: "from args" })).toBe("from args");
    expect(ompCallIntent(undefined, {})).toBeUndefined();
  });

  it("strips the intent from every input", () => {
    expect(stripOmpIntent({ i: "x", a: 1 })).toEqual({ a: 1 });
    expect(stripOmpIntent(null)).toEqual({});
  });
});

describe("convertOmpDiff", () => {
  it("converts numbered rows into a unified diff", () => {
    const diff = " 1|const a = 1;\n-2|const b = 1;\n+2|const b = 2;\n 3|export {};";
    expect(convertOmpDiff(diff, "src/a.ts")).toBe(
      [
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@",
        " const a = 1;",
        "-const b = 1;",
        "+const b = 2;",
        " export {};",
      ].join("\n"),
    );
  });

  it("starts a new hunk at a row that is not numbered", () => {
    const diff = " 1|a\n-2|b\n+2|B\n ...\n 9|c\n+10|d";
    expect(convertOmpDiff(diff, "f.txt")).toBe(
      [
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1,2 +1,2 @@",
        " a",
        "-b",
        "+B",
        "@@ -9,1 +9,2 @@",
        " c",
        "+d",
      ].join("\n"),
    );
  });

  it("starts a pure insertion range at the line before", () => {
    expect(convertOmpDiff("+1|new", "f")).toBe("--- a/f\n+++ b/f\n@@ -0,0 +1,1 @@\n+new");
  });

  it("passes a real unified diff through, adding headers when missing", () => {
    const unified = "@@ -1 +1 @@\n-old\n+new";
    expect(convertOmpDiff(unified, "x.ts")).toBe(`--- a/x.ts\n+++ b/x.ts\n${unified}`);
    const withHeaders = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new";
    expect(convertOmpDiff(withHeaders, "x.ts")).toBe(withHeaders);
  });

  it("returns null when no row matches", () => {
    expect(convertOmpDiff("no diff rows here", "x")).toBeNull();
    expect(convertOmpDiff("", "x")).toBeNull();
  });
});

describe("edit results", () => {
  const replaceArgs = { path: "a.ts", old_string: "1", new_string: "2" };

  it("uses the converted diff as the result content", () => {
    const result = {
      content: [{ type: "text", text: "[a.ts#1234]\nUpdated a.ts" }],
      details: { diff: "-1|const value = 1;\n+1|const value = 2;", path: "a.ts" },
    };
    expect(ompToolResultContent("edit", replaceArgs, result)).toBe(
      "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-const value = 1;\n+const value = 2;",
    );
  });

  it("falls back to the text when details.diff is missing or unmatched", () => {
    expect(ompToolResultContent("edit", replaceArgs, { content: [{ type: "text", text: "done" }] })).toBe("done");
    expect(
      ompToolResultContent("edit", replaceArgs, {
        content: [{ type: "text", text: "done" }],
        details: { diff: "nothing numbered" },
      }),
    ).toBe("done");
  });

  it("converts each file of a multi-file result", () => {
    const details = {
      diff: "+1|new\n+1|moved",
      perFileResults: [
        { path: "a.txt", diff: "+1|new" },
        { path: "b.txt", diff: "+1|moved" },
      ],
    };
    expect(ompEditResultDiff({ input: "[a.txt#AAAA]\n+new" }, details)).toBe(
      "--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1,1 @@\n+new\n\n--- a/b.txt\n+++ b/b.txt\n@@ -0,0 +1,1 @@\n+moved",
    );
  });

  it("returns the text content for other tools", () => {
    // OBSERVED P3a bash result
    expect(
      ompToolResultContent("bash", { command: "echo hi" }, {
        content: [{ type: "text", text: "hi\n\n\nWall time: 0.04 seconds" }],
        details: { timeoutSeconds: 300 },
      }),
    ).toBe("hi\n\n\nWall time: 0.04 seconds");
  });
});

describe("result helpers", () => {
  it("joins text blocks and accepts plain strings", () => {
    expect(ompMessageText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(ompMessageText("plain")).toBe("plain");
    expect(ompMessageText(undefined)).toBe("");
  });

  it("converts image blocks to Claude-shaped raw content blocks", () => {
    // OBSERVED P6: read of a PNG returns an image/webp block
    const result = {
      content: [
        { type: "text", text: "Read image file [image/webp]" },
        { type: "image", data: "UklGRqAAAABXRUJQ", mimeType: "image/webp" },
        { type: "image", data: "blob:sha256:abc", mimeType: "image/png" },
      ],
    };
    expect(ompResultImageBlocks(result)).toEqual([
      { type: "image", source: { type: "base64", data: "UklGRqAAAABXRUJQ", media_type: "image/webp" } },
    ]);
  });
});

describe("todo mapping", () => {
  it("maps statuses and flattens several phases with a prefix", () => {
    const phases = ompTodoPhases({
      op: "update",
      phases: [
        {
          name: "Build",
          tasks: [
            { content: "Write code", status: "completed" },
            { content: "Run tests", status: "in_progress" },
          ],
        },
        {
          name: "Ship",
          tasks: [
            { content: "Tag", status: "pending" },
            { content: "Announce", status: "abandoned" },
            { content: "Deploy", status: "blocked", blocker: "waiting for CI" },
          ],
        },
      ],
    });
    expect(phases).not.toBeNull();
    expect(ompTodoWriteInput(phases!)).toEqual({
      title: "Todo",
      todos: [
        { content: "Build: Write code", status: "completed", activeForm: "" },
        { content: "Build: Run tests", status: "in_progress", activeForm: "" },
        { content: "Ship: Tag", status: "pending", activeForm: "" },
        { content: "Ship: Announce (dropped)", status: "completed", activeForm: "" },
        { content: "Ship: Deploy (blocked: waiting for CI)", status: "pending", activeForm: "" },
      ],
    });
  });

  it("does not prefix a single phase", () => {
    const phases = ompTodoPhases({ phases: [{ name: "Only", tasks: [{ content: "A", status: "pending" }] }] });
    expect(ompTodoWriteInput(phases!).todos).toEqual([{ content: "A", status: "pending", activeForm: "" }]);
  });

  it("rejects malformed phases", () => {
    expect(ompTodoPhases({ phases: [{ name: "x", tasks: [{ status: "pending" }] }] })).toBeNull();
    expect(ompTodoPhases(undefined)).toBeNull();
  });

  it("names todo calls TodoWrite", () => {
    expect(canonicalToolName("todo", {})).toBe("TodoWrite");
  });
});
