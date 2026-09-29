import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeJsonStringPrefix,
  readJsonlLines,
  type OversizedJsonlLine,
} from "./jsonl-partial.js";

describe("decodeJsonStringPrefix", () => {
  it("decodes a complete string body", () => {
    expect(decodeJsonStringPrefix('hello \\"world\\"\\n')).toBe('hello "world"\n');
  });

  it("drops a cut simple escape", () => {
    expect(decodeJsonStringPrefix("line one\\")).toBe("line one");
  });

  it("drops a cut unicode escape", () => {
    expect(decodeJsonStringPrefix("caf\\u00")).toBe("caf");
    expect(decodeJsonStringPrefix("caf\\u00e9")).toBe("café");
  });

  it("keeps an escaped backslash at the end", () => {
    expect(decodeJsonStringPrefix("C:\\\\")).toBe("C:\\");
  });

  it("removes half of an escaped surrogate pair", () => {
    expect(decodeJsonStringPrefix("smile \\ud83d")).toBe("smile ");
    expect(decodeJsonStringPrefix("smile \\ud83d\\ude00")).toBe("smile 😀");
    expect(decodeJsonStringPrefix("smile \\ud83d\\ude")).toBe("smile ");
  });

  it("removes half of a raw surrogate pair cut by the window", () => {
    const cut = "smile 😀".slice(0, -1);
    expect(decodeJsonStringPrefix(cut)).toBe("smile ");
  });

  it("returns an empty string for an empty fragment", () => {
    expect(decodeJsonStringPrefix("")).toBe("");
  });
});

describe("readJsonlLines", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fileWith(content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "jsonl-partial-"));
    dirs.push(dir);
    const file = join(dir, "data.jsonl");
    await writeFile(file, content, "utf8");
    return file;
  }

  it("splits on LF only, keeping U+2028 inside a line", async () => {
    const file = await fileWith(`${JSON.stringify({ text: "a\u2028b\u2029c" })}\n{"n":2}\nlast`);
    const lines: string[] = [];
    await readJsonlLines(file, {
      maxLineChars: 1024,
      onLine: (line) => {
        lines.push(line as string);
      },
    });
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).text).toBe("a\u2028b\u2029c");
    expect(lines[2]).toBe("last");
  });

  it("reports lines above the limit with their prefix", async () => {
    const long = JSON.stringify({ type: "message", id: "abc", data: "x".repeat(5000) });
    const file = await fileWith(`${long}\n{"ok":true}\n`);
    const seen: Array<string | OversizedJsonlLine> = [];
    await readJsonlLines(file, {
      maxLineChars: 1000,
      oversizedPrefixChars: 64,
      onLine: (line) => {
        seen.push(line);
      },
    });
    const oversized = seen[0] as OversizedJsonlLine;
    expect(oversized.oversized).toBe(true);
    expect(oversized.length).toBe(long.length);
    expect(oversized.prefix).toBe(long.slice(0, 64));
    expect(seen[1]).toBe('{"ok":true}');
  });

  it("stops when the callback returns false", async () => {
    const file = await fileWith("1\n2\n3\n");
    const lines: string[] = [];
    await readJsonlLines(file, {
      maxLineChars: 100,
      onLine: (line) => {
        lines.push(line as string);
        return lines.length < 2;
      },
    });
    expect(lines).toEqual(["1", "2"]);
  });

  it("keeps multi-byte characters intact across stream chunks", async () => {
    const text = "é".repeat(700_000);
    const file = await fileWith(`${JSON.stringify({ text })}\n`);
    let parsed: { text: string } | undefined;
    await readJsonlLines(file, {
      maxLineChars: 10_000_000,
      onLine: (line) => {
        if (typeof line === "string" && line) parsed = JSON.parse(line);
      },
    });
    expect(parsed?.text).toBe(text);
  });
});
