/**
 * Helpers for large JSONL files.
 *
 * Session listers read only the head and tail of large JSONL files, so the
 * line at a window boundary is often incomplete; `decodeJsonStringPrefix`
 * recovers the readable prefix of a JSON string value from such a line.
 * `readJsonlLines` streams a whole file line by line without holding it in
 * memory.
 */

import { createReadStream } from "node:fs";

/** A physical line longer than the limit: only its start is kept. */
export interface OversizedJsonlLine {
  oversized: true;
  /** The first characters of the line (enough for `type`, `id`, `parentId`). */
  prefix: string;
  length: number;
}

export interface ReadJsonlLinesOptions {
  /** Longer lines are reported as `OversizedJsonlLine`. */
  maxLineChars: number;
  /** Characters kept of an oversized line. Default 4096. */
  oversizedPrefixChars?: number;
  /** Stop after this many bytes were read (the last line may be cut). */
  maxBytes?: number;
  /** Return `false` to stop reading. */
  onLine: (line: string | OversizedJsonlLine, index: number) => boolean | void;
}

/**
 * Stream `file` and call `onLine` for every LF-terminated line (and a final
 * unterminated one). Splits on `\n` only: `readline` would also split on
 * U+2028/U+2029, which `JSON.stringify` does not escape.
 */
export async function readJsonlLines(
  file: string,
  options: ReadJsonlLinesOptions,
): Promise<void> {
  const prefixChars = options.oversizedPrefixChars ?? 4096;
  const stream = createReadStream(file, {
    encoding: "utf8",
    highWaterMark: 1024 * 1024,
    ...(options.maxBytes !== undefined ? { end: Math.max(0, options.maxBytes - 1) } : {}),
  });
  let parts: string[] = [];
  let partChars = 0;
  let oversizedPrefix: string | null = null;
  let index = 0;
  let stopped = false;

  const emit = (): boolean => {
    let line: string | OversizedJsonlLine;
    if (oversizedPrefix !== null) {
      line = { oversized: true, prefix: oversizedPrefix, length: partChars };
    } else {
      line = parts.join("");
    }
    parts = [];
    partChars = 0;
    oversizedPrefix = null;
    const keepGoing = options.onLine(line, index++);
    return keepGoing !== false;
  };

  const append = (fragment: string) => {
    partChars += fragment.length;
    if (oversizedPrefix !== null) return;
    if (partChars > options.maxLineChars) {
      oversizedPrefix = `${parts.join("")}${fragment}`.slice(0, prefixChars);
      parts = [];
      return;
    }
    parts.push(fragment);
  };

  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      let start = 0;
      while (start <= chunk.length) {
        const newline = chunk.indexOf("\n", start);
        if (newline < 0) {
          if (start < chunk.length) append(chunk.slice(start));
          break;
        }
        append(chunk.slice(start, newline));
        start = newline + 1;
        if (!emit()) {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
    }
    if (!stopped && (partChars > 0 || parts.length > 0)) emit();
  } finally {
    stream.destroy();
  }
}

/**
 * An incomplete escape is at most `\uXXXX` (6 characters) and a raw surrogate
 * pair is 2 characters, so a valid prefix is always found within this many
 * trailing characters. A fragment that still fails after that is not a JSON
 * string prefix.
 */
const MAX_TRAILING_TRIM = 16;

/**
 * Decode the body of a JSON string literal that may be cut anywhere.
 *
 * `fragment` is the text after the opening quote, without the closing quote,
 * as captured from a partial line (for example `hello \"wor` or `caf\u00`).
 * Incomplete escapes at the end are dropped, and a trailing lone high
 * surrogate (half of a cut surrogate pair, raw or escaped) is removed, so the
 * result is always well-formed text.
 */
export function decodeJsonStringPrefix(fragment: string): string {
  const minLength = Math.max(0, fragment.length - MAX_TRAILING_TRIM);
  for (let end = fragment.length; end >= minLength; end--) {
    const candidate = fragment.slice(0, end);
    let decoded: string;
    try {
      decoded = JSON.parse(`"${candidate}"`) as string;
    } catch {
      continue;
    }
    return stripTrailingHighSurrogate(decoded);
  }
  return "";
}

function stripTrailingHighSurrogate(text: string): string {
  if (text.length === 0) return text;
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}
