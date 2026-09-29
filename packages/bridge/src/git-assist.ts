import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Provider } from "./parser.js";
import { getStagedDiff } from "./git-operations.js";
import { runOmpPrint } from "./omp-print.js";
import {
  getCodexAssistModel,
  getCodexAssistReasoningConfig,
} from "./codex-assist.js";

const COMMIT_MESSAGE_PROMPT =
  "Write a single Conventional Commits message in English for the staged changes below. Output only the commit message, with no quotes or explanation.";
export interface GitAssistOptions {
  provider: Provider;
  projectPath: string;
  model?: string;
}

/**
 * Generate a commit message for the staged diff with the session's provider.
 *
 * omp runs through the non-blocking `runOmpPrint` with the diff on stdin.
 * Claude and Codex keep their synchronous CLI calls.
 */
export async function generateCommitMessage(
  options: GitAssistOptions,
): Promise<string> {
  const diff = getStagedDiff(options.projectPath).trim();
  if (!diff) {
    throw new Error("Nothing to commit: no files are staged");
  }

  const cwd = resolve(options.projectPath);
  let output: string;
  switch (options.provider) {
    case "omp":
      output = await runOmpPrint({
        cwd,
        prompt: COMMIT_MESSAGE_PROMPT,
        stdin: diff,
        model: options.model,
      });
      break;
    case "codex":
      output = runCodexCommitAssist(cwd, diff, options.model);
      break;
    case "claude":
      output = execFileSync(
        "claude",
        [
          "-p",
          ...(options.model ? ["--model", options.model] : []),
          COMMIT_MESSAGE_PROMPT,
        ],
        {
          cwd,
          encoding: "utf-8",
          input: diff,
          maxBuffer: 1024 * 1024,
        },
      );
      break;
  }

  const message = output
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!message) {
    throw new Error("Commit message generation returned empty output");
  }
  return message;
}

function runCodexCommitAssist(
  cwd: string,
  diff: string,
  _model?: string,
): string {
  const outputDir = mkdtempSync(join(tmpdir(), "ccpocket-git-assist-"));
  const outputPath = join(outputDir, "last-message.txt");

  try {
    execFileSync(
      "codex",
      [
        "exec",
        "-m",
        getCodexAssistModel(),
        "-c",
        getCodexAssistReasoningConfig(),
        "-o",
        outputPath,
        "-",
      ],
      {
        cwd,
        encoding: "utf-8",
        input: `${COMMIT_MESSAGE_PROMPT}\n\n${diff}`,
        maxBuffer: 1024 * 1024,
      },
    );
    return readFileSync(outputPath, "utf-8");
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}
