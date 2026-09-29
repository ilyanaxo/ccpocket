#!/usr/bin/env node
/**
 * Live end-to-end check of the omp provider against the real omp CLI
 * (docs/omp-integration.md §11.3).
 *
 *   node packages/bridge/test-omp-e2e.mjs --url ws://127.0.0.1:8766 \
 *     --project "$E2E_DIR/project" [--model <selector>] [--cleanup]
 *
 * Options:
 *   --url <ws-url>        test Bridge URL; port 8765 (production) is refused
 *   --project <dir>       project directory; its parent (the E2E root) becomes
 *                         BRIDGE_ALLOWED_DIRS
 *   --model <selector>    omp model for the session (default: omp's default)
 *   --no-start-bridge     use a Bridge that is already running on --url (the
 *                         checks that need the Bridge's child processes are
 *                         skipped: step 15's helper check, step 16's wait
 *                         check, step 19)
 *   --omp-bin <path>      omp binary for the Bridge this script starts
 *                         (default: BRIDGE_OMP_BIN, else omp on PATH)
 *   --session-dir <dir>   PI_CODING_AGENT_SESSION_DIR for the omp processes of
 *                         the Bridge this script starts (omp then stores the
 *                         sessions there instead of the user's store)
 *   --steps <list>        run only these step numbers (comma separated; steps
 *                         1, 2, 1b and 19 always run)
 *   --cleanup             delete the created session files (and their artifact
 *                         directories) whose header cwd is inside the E2E root
 *
 * Isolation of the Bridge this script starts: it runs with HOME set to
 * <E2E root>/bridge-home, so its state (~/.ccpocket: project history,
 * archive markers, prompt history, Firebase identity, the omp overlay) stays
 * inside the E2E root. Being a fresh Bridge, it signs in to the push relay
 * with a new anonymous identity, so its pushes never reach the user's devices.
 * The omp processes it spawns go through a wrapper that restores the user's
 * HOME and omp profile variables: omp runs with the user's own configuration
 * and credentials, and the Bridge reads the same session store.
 *
 * Session files: without --session-dir omp writes the sessions into the
 * user's store (the bucket of the project directory). The script finds the
 * files it created with the Bridge's own store lookup, prints their paths at
 * the end and deletes them only with --cleanup.
 *
 * Output is one line per step: PASS/FAIL, the step name and a short reason.
 * Frames are never printed. The script stops only the sessions and the Bridge
 * it started.
 */
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, openSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// The Bridge's own store rules, so the script finds what the Bridge finds.
const { resolveOmpStore } = await tsImport("./src/omp-env.ts", import.meta.url);
const { findOmpSessionFile } = await tsImport("./src/omp-sessions.ts", import.meta.url);

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { startBridge: true, cleanup: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case "--url": args.url = value(); break;
      case "--project": args.project = resolve(value()); break;
      case "--model": args.model = value(); break;
      case "--omp-bin": args.ompBin = resolve(value()); break;
      case "--session-dir": args.sessionDir = resolve(value()); break;
      case "--steps": args.steps = new Set(value().split(",").map((s) => s.trim())); break;
      case "--no-start-bridge": args.startBridge = false; break;
      case "--cleanup": args.cleanup = true; break;
      case "-h":
      case "--help":
        console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!args.url || !args.project) throw new Error("--url and --project are required");
  const url = new URL(args.url);
  if (url.port === "8765") {
    throw new Error("refusing to use port 8765 (the production Bridge); use 8766");
  }
  args.port = url.port || "80";
  return args;
}

const args = parseArgs(process.argv.slice(2));
const e2eRoot = dirname(args.project);
mkdirSync(args.project, { recursive: true });

// The environment omp runs with: the user's own, plus --session-dir.
const ompEnv = {
  ...process.env,
  ...(args.sessionDir ? { PI_CODING_AGENT_SESSION_DIR: args.sessionDir } : {}),
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results = [];

function report(step, name, ok, reason = "") {
  results.push({ step, name, ok });
  const line = `${ok ? "PASS" : "FAIL"} ${String(step).padEnd(3)} ${name}${reason ? ` - ${reason}` : ""}`;
  console.log(line);
}

function shortReason(err) {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, " ").slice(0, 160);
}

// ---------------------------------------------------------------------------
// Bridge process
// ---------------------------------------------------------------------------

let bridgeChild = null;

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `http://127.0.0.1:${args.port}/health`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(300);
  }
  throw new Error("the test Bridge did not start");
}

/** Variables the omp wrapper gives back to omp exactly as the user has them. */
const OMP_USER_ENV_VARS = ["HOME", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR"];

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * The omp binary the test Bridge spawns: a wrapper that restores the user's
 * HOME and omp profile variables, then runs the real omp.
 */
function writeOmpWrapper(dir) {
  const bin = args.ompBin ?? (process.env.BRIDGE_OMP_BIN || "omp");
  const lines = [
    "#!/bin/sh",
    "# Written by test-omp-e2e.mjs: omp runs with the user's HOME and profile.",
    ...OMP_USER_ENV_VARS.map((name) =>
      process.env[name] === undefined
        ? `unset ${name}`
        : `export ${name}=${shellQuote(process.env[name])}`,
    ),
    `exec ${shellQuote(bin)} "$@"`,
    "",
  ];
  const path = join(dir, "omp-e2e-wrapper.sh");
  writeFileSync(path, lines.join("\n"));
  chmodSync(path, 0o700);
  return path;
}

async function startBridge() {
  try {
    const response = await fetch(`http://127.0.0.1:${args.port}/health`);
    if (response.ok) throw new Error(`port ${args.port} is already in use; pass --no-start-bridge to use that Bridge`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("already in use")) throw err;
  }
  const tsxCli = require.resolve("tsx/cli", { paths: [here] });
  const logFile = join(e2eRoot, "bridge.log");
  const log = openSync(logFile, "a");
  const bridgeHome = join(e2eRoot, "bridge-home");
  mkdirSync(bridgeHome, { recursive: true });
  if (args.sessionDir) mkdirSync(args.sessionDir, { recursive: true });
  const env = {
    ...ompEnv,
    HOME: bridgeHome,
    // The Bridge resolves the user's store through PI_CODING_AGENT_DIR, since
    // its own HOME is not the user's (the wrapper restores the rest for omp).
    PI_CODING_AGENT_DIR: resolveOmpStore(ompEnv).agentDir,
    BRIDGE_OMP_BIN: writeOmpWrapper(e2eRoot),
    BRIDGE_PORT: args.port,
    BRIDGE_HOST: "127.0.0.1",
    BRIDGE_DISABLE_MDNS: "1",
    BRIDGE_ALLOWED_DIRS: e2eRoot,
  };
  delete env.OMP_PROFILE;
  delete env.PI_PROFILE;
  delete env.PI_CONFIG_DIR;
  delete env.CLAUDECODE;
  bridgeChild = spawn(process.execPath, [tsxCli, "src/index.ts"], {
    cwd: here,
    env,
    stdio: ["ignore", log, log],
    detached: true,
  });
  await waitForHealth(60_000);
}

function descendantsOf(pid) {
  let table;
  try {
    table = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const rows = table
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
  const found = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const row of rows) {
      if (row.ppid === parent) {
        found.push(row);
        queue.push(row.pid);
      }
    }
  }
  return found;
}

function ompChildren(mode) {
  if (!bridgeChild?.pid) return [];
  return descendantsOf(bridgeChild.pid).filter((row) =>
    mode === "rpc"
      ? /--mode rpc(\s|$)/.test(row.args)
      : /--mode rpc/.test(row.args),
  );
}

/** The test Bridge's process has not been reaped yet, so its pid is still ours. */
function bridgeRunning() {
  return !!bridgeChild?.pid && bridgeChild.exitCode === null && bridgeChild.signalCode === null;
}

async function stopBridge() {
  if (!bridgeChild?.pid) return;
  const pid = bridgeChild.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // already gone
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(200);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

class Client {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.waiters = new Set();
  }

  async open(declaresOmp) {
    this.ws = new WebSocket(args.url);
    this.ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.messages.push(message);
      for (const waiter of [...this.waiters]) waiter();
    });
    await new Promise((resolveOpen, rejectOpen) => {
      this.ws.once("open", resolveOpen);
      this.ws.once("error", rejectOpen);
    });
    this.send({
      type: "client_capabilities",
      protocolVersion: 1,
      minimumProtocolVersion: 1,
      supportedServerMessages: ["conversation_queue", "session_context"],
      ...(declaresOmp ? { supportedProviders: ["claude", "codex", "omp"] } : {}),
    });
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  get mark() {
    return this.messages.length;
  }

  /** Resolve with the first message after `from` that matches. */
  waitFor(predicate, { from = 0, timeoutMs = 120_000, what = "message" } = {}) {
    return new Promise((resolveWait, rejectWait) => {
      const check = () => {
        for (let i = from; i < this.messages.length; i++) {
          if (predicate(this.messages[i])) {
            cleanup();
            resolveWait(this.messages[i]);
            return true;
          }
        }
        return false;
      };
      const timer = setTimeout(() => {
        cleanup();
        rejectWait(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      if (check()) return;
      this.waiters.add(check);
    });
  }

  since(from, predicate = () => true) {
    return this.messages.slice(from).filter(predicate);
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers for session steps
// ---------------------------------------------------------------------------

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";

const state = {
  sessionId: null,
  ompSessionId: null,
  model: null,
  thinkingLevel: null,
  models: [],
  createdOmpSessionIds: new Set(),
  bridgeSessionIds: new Set(),
};

const forSession = (sessionId) => (m) => m.sessionId === sessionId;

function assistantText(messages) {
  return messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function sendInput(client, text, extra = {}) {
  const from = client.mark;
  client.send({ type: "input", sessionId: state.sessionId, text, ...extra });
  return from;
}

async function waitResult(client, from, timeoutMs = 180_000) {
  return client.waitFor(
    (m) => m.type === "result" && m.sessionId === state.sessionId,
    { from, timeoutMs, what: "result" },
  );
}

async function waitIdle(client, from, timeoutMs = 60_000) {
  return client.waitFor(
    (m) => m.type === "status" && m.status === "idle" && m.sessionId === state.sessionId,
    { from, timeoutMs, what: "status idle" },
  );
}

function sessionSummary(client, bridgeId = state.sessionId) {
  const lists = client.messages.filter((m) => m.type === "session_list");
  for (let i = lists.length - 1; i >= 0; i--) {
    const found = (lists[i].sessions ?? []).find((s) => s.id === bridgeId);
    if (found) return found;
  }
  return undefined;
}

async function refreshSummary(client) {
  const from = client.mark;
  client.send({ type: "list_sessions" });
  await client.waitFor((m) => m.type === "session_list", { from, timeoutMs: 10_000, what: "session_list" });
  return sessionSummary(client);
}

async function recentOmpSessions(client) {
  const requestId = `recent-${Date.now()}-${Math.random()}`;
  const from = client.mark;
  client.send({ type: "list_recent_sessions", provider: "omp", limit: 50, requestId });
  const response = await client.waitFor(
    (m) => m.type === "recent_sessions" && m.requestId === requestId,
    { from, timeoutMs: 30_000, what: "recent_sessions" },
  );
  return response.sessions ?? [];
}

/** The session file of an omp session this run created, found as the Bridge finds it. */
function sessionFileOf(ompSessionId) {
  return findOmpSessionFile(ompSessionId, { env: ompEnv });
}

function insideE2eRoot(path) {
  const resolved = path ? resolve(path) : "";
  return resolved === e2eRoot || resolved.startsWith(`${e2eRoot}${sep}`);
}

function readHeader(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (const line of lines.slice(0, 3)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "session") return parsed;
    } catch {
      // title slot or partial line
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function run() {
  const main = new Client("main");
  const legacy = new Client("legacy");
  const want = (step) => !args.steps || args.steps.has(String(step));

  await main.open(true);
  await legacy.open(false);

  // 1: capability and catalogue for a declaring client
  try {
    const list = await main.waitFor(
      (m) =>
        m.type === "session_list" &&
        (m.protocolCapabilities ?? []).includes("provider_omp_v1") &&
        m.ompAvailability !== undefined,
      { timeoutMs: 60_000, what: "session_list with omp fields" },
    );
    state.models = list.ompModels ?? [];
    const ok = list.ompAvailability === "available" && state.models.length > 0;
    report(1, "capabilities and model catalogue", ok,
      ok ? `${state.models.length} models` : `ompAvailability=${list.ompAvailability}`);
    if (!ok) return;
  } catch (err) {
    report(1, "capabilities and model catalogue", false, shortReason(err));
    return;
  }

  // 2: start
  try {
    const from = main.mark;
    main.send({
      type: "start",
      provider: "omp",
      projectPath: args.project,
      executionMode: "default",
      ...(args.model ? { model: args.model } : {}),
      requestId: "e2e-start",
    });
    const created = await main.waitFor(
      (m) => m.type === "system" && m.subtype === "session_created" && m.requestId === "e2e-start",
      { from, timeoutMs: 60_000, what: "session_created" },
    );
    state.sessionId = created.sessionId;
    state.bridgeSessionIds.add(created.sessionId);
    const init = await main.waitFor(
      (m) => m.type === "system" && m.subtype === "init" && m.sessionId === state.sessionId,
      { from, timeoutMs: 90_000, what: "system/init" },
    );
    state.model = init.model ?? null;
    state.thinkingLevel = init.thinkingLevel ?? null;
    const summary = await refreshSummary(main);
    state.ompSessionId = summary?.claudeSessionId ?? null;
    if (state.ompSessionId) state.createdOmpSessionIds.add(state.ompSessionId);
    const ok = created.provider === "omp" && init.provider === "omp" && !!state.ompSessionId;
    report(2, "start omp session", ok, ok ? "" : "missing provider or omp session id");
    if (!ok) return;
  } catch (err) {
    report(2, "start omp session", false, shortReason(err));
    return;
  }

  // 2b: rename before the session file exists (§6.3). omp writes the file
  // with the first assistant message; the name must land in it.
  const EARLY_NAME = "E2E omp early name";
  let earlyRename = null;
  if (want("2b")) {
    try {
      const fileBefore = await sessionFileOf(state.ompSessionId);
      const from = main.mark;
      main.send({ type: "rename_session", sessionId: state.sessionId, name: EARLY_NAME });
      const renamed = await main.waitFor(
        (m) => m.type === "rename_result" && m.sessionId === state.sessionId,
        { from, timeoutMs: 30_000, what: "rename_result" },
      );
      earlyRename = { fileBefore: fileBefore !== null, success: renamed.success === true };
    } catch (err) {
      report("2b", "rename before the session file exists", false, shortReason(err));
    }
  }

  // 3: plain answer
  if (want(3)) {
    try {
      const from = await sendInput(main, "Reply with exactly: OK");
      const result = await waitResult(main, from);
      await waitIdle(main, from);
      const messages = main.since(from, forSession(state.sessionId));
      const deltas = messages.filter((m) => m.type === "stream_delta").length;
      const text = assistantText(messages);
      const ok =
        deltas > 0 &&
        /\bOK\b/.test(text) &&
        result.subtype === "success" &&
        typeof result.cost === "number" &&
        typeof result.inputTokens === "number";
      report(3, "text prompt streams and reports usage", ok,
        ok ? "" : `deltas=${deltas} result=${result.subtype}`);
    } catch (err) {
      report(3, "text prompt streams and reports usage", false, shortReason(err));
    }
  }

  // 2b (continued): the first answer created the file with the early name.
  if (earlyRename) {
    try {
      if (!want(3)) {
        const from = await sendInput(main, "Reply with exactly: OK");
        await waitResult(main, from);
      }
      const file = await sessionFileOf(state.ompSessionId);
      const listed = (await recentOmpSessions(main)).find((s) => s.sessionId === state.ompSessionId);
      const ok =
        !earlyRename.fileBefore && earlyRename.success && file !== null && listed?.name === EARLY_NAME;
      report("2b", "rename before the session file exists", ok,
        ok ? "" : `fileBefore=${earlyRename.fileBefore} renamed=${earlyRename.success} file=${file !== null} listedName=${listed ? JSON.stringify(listed.name ?? null) : "-"}`);
    } catch (err) {
      report("2b", "rename before the session file exists", false, shortReason(err));
    }
  }

  // 4: approval approved
  if (want(4)) {
    try {
      const from = await sendInput(main, "Use the bash tool to run exactly this command: echo hi");
      const request = await main.waitFor(
        (m) => m.type === "permission_request" && m.sessionId === state.sessionId,
        { from, what: "permission_request" },
      );
      const okRequest =
        request.toolName === "Bash" &&
        String(request.input?.command ?? "").includes("echo hi") &&
        Array.isArray(request.input?.approvalDetails);
      main.send({ type: "approve", sessionId: state.sessionId, id: request.toolUseId });
      const toolResult = await main.waitFor(
        (m) => m.type === "tool_result" && m.sessionId === state.sessionId && m.toolUseId === request.toolUseId,
        { from, what: "tool_result" },
      );
      await waitResult(main, from);
      const ok = okRequest && String(toolResult.content).includes("hi");
      report(4, "approval request and approve", ok, ok ? "" : `toolName=${request.toolName}`);
    } catch (err) {
      report(4, "approval request and approve", false, shortReason(err));
    }
  }

  // 5: approval denied with a note
  if (want(5)) {
    try {
      const from = await sendInput(main, "Use the bash tool to run exactly this command: echo bye");
      const request = await main.waitFor(
        (m) => m.type === "permission_request" && m.sessionId === state.sessionId,
        { from, what: "permission_request" },
      );
      main.send({ type: "reject", sessionId: state.sessionId, id: request.toolUseId, message: "not now" });
      const toolResult = await main.waitFor(
        (m) => m.type === "tool_result" && m.sessionId === state.sessionId && m.toolUseId === request.toolUseId,
        { from, what: "denied tool_result" },
      );
      await waitResult(main, from);
      await waitIdle(main, from);
      const notes = main.since(from, (m) => m.type === "user_input" && m.sessionId === state.sessionId && m.text === "not now" && !m.userMessageUuid);
      const ok = /denied/i.test(String(toolResult.content)) && notes.length === 1;
      report(5, "deny with a note", ok, ok ? "" : `notes=${notes.length}`);
    } catch (err) {
      report(5, "deny with a note", false, shortReason(err));
    }
  }

  // 6: ask single choice
  if (want(6)) {
    try {
      const from = await sendInput(
        main,
        "Use the ask tool to ask me which color I prefer: red or blue. Then tell me my answer in one short sentence.",
      );
      const request = await main.waitFor(
        (m) => m.type === "permission_request" && m.sessionId === state.sessionId && m.toolName === "AskUserQuestion",
        { from, what: "AskUserQuestion" },
      );
      const question = request.input?.questions?.[0];
      const options = (question?.options ?? []).map((o) => o.label);
      const blue = options.find((label) => /blue/i.test(label)) ?? "blue";
      main.send({
        type: "answer",
        sessionId: state.sessionId,
        toolUseId: request.toolUseId,
        result: JSON.stringify({ answers: { [question.question]: blue } }),
      });
      const toolResult = await main.waitFor(
        (m) => m.type === "tool_result" && m.sessionId === state.sessionId && m.toolUseId === request.toolUseId,
        { from, what: "ask tool_result" },
      );
      const result = await waitResult(main, from);
      const ok = options.length >= 2 && /blue/i.test(String(toolResult.content)) && result.subtype === "success";
      report(6, "ask single choice", ok, ok ? "" : `options=${options.length} result=${result.subtype}`);
    } catch (err) {
      report(6, "ask single choice", false, shortReason(err));
    }
  }

  // 7: ask two questions with a multi-select
  if (want(7)) {
    try {
      const from = await sendInput(
        main,
        "Use the ask tool once with two questions: which fruits I like (multiple choice, options apple, banana, cherry) and which size I prefer (options small or large). Then repeat my answers in one short sentence.",
      );
      const request = await main.waitFor(
        (m) => m.type === "permission_request" && m.sessionId === state.sessionId && m.toolName === "AskUserQuestion",
        { from, what: "AskUserQuestion" },
      );
      const questions = request.input?.questions ?? [];
      const answers = {};
      for (const question of questions) {
        const labels = (question.options ?? []).map((o) => o.label);
        if (question.multiSelect) {
          answers[question.question] = labels.filter((l) => /apple|cherry/i.test(l));
        } else {
          answers[question.question] = labels.find((l) => /small/i.test(l)) ?? labels[0];
        }
      }
      main.send({
        type: "answer",
        sessionId: state.sessionId,
        toolUseId: request.toolUseId,
        result: JSON.stringify({ answers }),
      });
      const toolResult = await main.waitFor(
        (m) => m.type === "tool_result" && m.sessionId === state.sessionId && m.toolUseId === request.toolUseId,
        { from, what: "ask tool_result" },
      );
      const result = await waitResult(main, from);
      const content = String(toolResult.content);
      const ok =
        questions.length === 2 &&
        questions.some((q) => q.multiSelect) &&
        /apple/i.test(content) &&
        /cherry/i.test(content) &&
        /small/i.test(content) &&
        result.subtype === "success";
      report(7, "ask two questions with multi-select", ok,
        ok ? "" : `questions=${questions.length} result=${result.subtype}`);
    } catch (err) {
      report(7, "ask two questions with multi-select", false, shortReason(err));
    }
  }

  // 8: interrupt while an approval is pending
  if (want(8)) {
    try {
      const from = await sendInput(main, "Use the bash tool to run exactly this command: echo hi");
      await main.waitFor(
        (m) => m.type === "permission_request" && m.sessionId === state.sessionId,
        { from, what: "permission_request" },
      );
      const interruptedAt = Date.now();
      main.send({ type: "interrupt", sessionId: state.sessionId });
      const result = await main.waitFor(
        (m) => m.type === "result" && m.sessionId === state.sessionId,
        { from, timeoutMs: 10_000, what: "interrupted result" },
      );
      await waitIdle(main, from, 10_000);
      const ok = result.subtype === "interrupted";
      report(8, "interrupt a pending approval", ok,
        ok ? `${Date.now() - interruptedAt} ms` : `result=${result.subtype}`);
    } catch (err) {
      report(8, "interrupt a pending approval", false, shortReason(err));
    }
  }

  // 9: approval mode change (respawn)
  if (want(9)) {
    try {
      const from = main.mark;
      main.send({
        type: "set_permission_mode",
        sessionId: state.sessionId,
        mode: "bypassPermissions",
        executionMode: "fullAccess",
      });
      const applied = await main.waitFor(
        (m) => m.type === "system" && m.subtype === "set_permission_mode" && m.sessionId === state.sessionId,
        { from, timeoutMs: 90_000, what: "system/set_permission_mode" },
      );
      const summary = await refreshSummary(main);
      const ok = applied.executionMode === "fullAccess" && summary?.id === state.sessionId;
      report(9, "approval mode respawn keeps the Bridge session", ok);
    } catch (err) {
      report(9, "approval mode respawn keeps the Bridge session", false, shortReason(err));
    }
  }

  // 10: background job does not hold the idle state
  if (want(10)) {
    try {
      const startedAt = Date.now();
      const from = await sendInput(
        main,
        "Use the bash tool with async set to true to run this command in the background: sleep 20 && echo done. Do not wait for it; reply only with STARTED.",
      );
      const result = await waitResult(main, from, 60_000);
      await waitIdle(main, from, 15_000);
      const idleAfter = Date.now() - startedAt;
      const second = await sendInput(main, "Reply with exactly: READY");
      const ack = await main.waitFor(
        (m) => m.type === "input_ack" && m.sessionId === state.sessionId,
        { from: second, timeoutMs: 10_000, what: "input_ack" },
      );
      await waitResult(main, second);
      const early = result.subtype === "success" && idleAfter < 20_000 && ack.queued === false;
      // omp wakes itself when the job finishes: an agent-initiated run.
      const wake = main.mark;
      const running = await main.waitFor(
        (m) => m.type === "status" && m.status === "running" && m.sessionId === state.sessionId,
        { from: wake, timeoutMs: 90_000, what: "agent-initiated run" },
      ).catch(() => null);
      const wakeResult = running
        ? await main.waitFor(
            (m) => m.type === "result" && m.sessionId === state.sessionId,
            { from: wake, timeoutMs: 120_000, what: "agent-initiated result" },
          ).catch(() => null)
        : null;
      await waitIdle(main, wake, 60_000).catch(() => null);
      const ok = early && !!running && !!wakeResult;
      report(10, "background job: idle before the job ends, then an agent-initiated run", ok,
        ok ? `idle after ${Math.round(idleAfter / 1000)} s`
          : `early=${early} wake=${!!running} wakeResult=${!!wakeResult}`);
    } catch (err) {
      report(10, "background job: idle before the job ends, then an agent-initiated run", false, shortReason(err));
    }
  }

  // 11: queue while running
  if (want(11)) {
    try {
      const from = await sendInput(main, "Use the bash tool to run exactly this command: sleep 5 && echo done");
      await main.waitFor(
        (m) => m.type === "status" && m.status === "running" && m.sessionId === state.sessionId,
        { from, timeoutMs: 30_000, what: "running" },
      );
      const queuedFrom = main.mark;
      main.send({ type: "input", sessionId: state.sessionId, text: "Reply with exactly: QUEUED", clientMessageId: "e2e-q1" });
      const ack = await main.waitFor(
        (m) => m.type === "input_ack" && m.sessionId === state.sessionId && m.clientMessageId === "e2e-q1",
        { from: queuedFrom, timeoutMs: 10_000, what: "input_ack" },
      );
      const queue = await main.waitFor(
        (m) => m.type === "conversation_queue" && m.sessionId === state.sessionId && (m.items ?? []).length === 1,
        { from: queuedFrom, timeoutMs: 10_000, what: "conversation_queue" },
      );
      const firstResult = await waitResult(main, from);
      const drained = await main.waitFor(
        (m) => m.type === "user_input" && m.sessionId === state.sessionId && m.text === "Reply with exactly: QUEUED",
        { from: main.messages.indexOf(firstResult), timeoutMs: 30_000, what: "drained user_input" },
      );
      await main.waitFor(
        (m) => m.type === "result" && m.sessionId === state.sessionId,
        { from: main.messages.indexOf(drained), what: "queued result" },
      );
      await waitIdle(main, main.messages.indexOf(drained));
      // The queue payload never carries a uuid; a wrongly assigned Codex uuid
      // would show on the drained user_input (omp ids are backfilled later).
      const item = queue.items[0];
      const drainedUuid = String(drained.userMessageUuid ?? "");
      const ok =
        ack.queued === true &&
        !("userMessageUuid" in item) &&
        !drainedUuid.startsWith("codex:") &&
        drained.clientMessageId === "e2e-q1";
      report(11, "queue while running and drain after the result", ok,
        ok ? "" : `queued=${ack.queued} itemUuid=${"userMessageUuid" in item} drainedUuid=${drainedUuid || "none"} clientMessageId=${drained.clientMessageId ?? "none"}`);
    } catch (err) {
      report(11, "queue while running and drain after the result", false, shortReason(err));
    }
  }

  // 12: steer a queued item
  if (want(12)) {
    try {
      const from = await sendInput(
        main,
        "Use the bash tool to run exactly this command: sleep 8 && echo finished. Then summarize the output in one short sentence.",
      );
      await main.waitFor(
        (m) => m.type === "status" && m.status === "running" && m.sessionId === state.sessionId,
        { from, timeoutMs: 30_000, what: "running" },
      );
      await main.waitFor(
        (m) => m.type === "assistant" && m.sessionId === state.sessionId &&
          (m.message?.content ?? []).some((b) => b.type === "tool_use"),
        { from, timeoutMs: 60_000, what: "tool call" },
      );
      const queuedFrom = main.mark;
      const steerText = "Also add the word PINEAPPLE to your final reply.";
      main.send({ type: "input", sessionId: state.sessionId, text: steerText });
      const queue = await main.waitFor(
        (m) => m.type === "conversation_queue" && m.sessionId === state.sessionId && (m.items ?? []).length === 1,
        { from: queuedFrom, timeoutMs: 10_000, what: "conversation_queue" },
      );
      main.send({ type: "steer_queued_input", sessionId: state.sessionId, itemId: queue.items[0].itemId });
      await waitResult(main, from);
      await waitIdle(main, from).catch(() => null);
      // A steer that lands as the run yields starts its own run.
      await sleep(1500);
      const text = assistantText(main.since(from, forSession(state.sessionId)));
      const historyFrom = main.mark;
      main.send({ type: "get_history", sessionId: state.sessionId });
      const history = await main.waitFor(
        (m) => m.type === "history" && m.sessionId === state.sessionId,
        { from: historyFrom, timeoutMs: 10_000, what: "history" },
      );
      const occurrences = (history.messages ?? []).filter((m) => m.type === "user_input" && m.text === steerText).length;
      const ok = /PINEAPPLE/.test(text) && occurrences === 1;
      report(12, "steer a queued item into the running turn", ok,
        ok ? "" : `pineapple=${/PINEAPPLE/.test(text)} occurrences=${occurrences}`);
    } catch (err) {
      report(12, "steer a queued item into the running turn", false, shortReason(err));
    }
  }

  // 13: model and thinking level in place
  if (want(13)) {
    try {
      const current = state.models.find((m) => m.selector === state.model);
      const other =
        state.models.find((m) => m.selector !== state.model && m.provider === current?.provider && m.thinkingLevels.includes("off")) ??
        state.models.find((m) => m.selector !== state.model && m.thinkingLevels.includes("off"));
      if (!other) throw new Error("no second model in the catalogue");
      const from = main.mark;
      main.send({ type: "set_omp_model", sessionId: state.sessionId, model: other.selector, thinkingLevel: "off" });
      const settings = await main.waitFor(
        (m) => m.type === "system" && m.subtype === "omp_settings" && m.sessionId === state.sessionId && m.model === other.selector,
        { from, timeoutMs: 60_000, what: "omp_settings" },
      );
      const ok = settings.thinkingLevel === "off" || settings.thinkingLevel === undefined;
      report(13, "set_omp_model applies model and thinking level", ok);
      // Restore the original model for the remaining steps.
      if (state.model) {
        const restoreFrom = main.mark;
        main.send({
          type: "set_omp_model",
          sessionId: state.sessionId,
          model: state.model,
          ...(state.thinkingLevel ? { thinkingLevel: state.thinkingLevel } : {}),
        });
        await main.waitFor(
          (m) => m.type === "system" && m.subtype === "omp_settings" && m.sessionId === state.sessionId && m.model === state.model,
          { from: restoreFrom, timeoutMs: 60_000, what: "restored omp_settings" },
        ).catch(() => null);
      }
    } catch (err) {
      report(13, "set_omp_model applies model and thinking level", false, shortReason(err));
    }
  }

  // 14: image prompt
  if (want(14)) {
    try {
      const from = await sendInput(main, "What is the main color of this image? Answer in one word.", {
        images: [{ base64: TINY_PNG, mimeType: "image/png" }],
      });
      const result = await waitResult(main, from);
      const ok = result.subtype === "success" || (result.subtype === "error" && !!result.error);
      report(14, "image prompt", ok, result.subtype);
    } catch (err) {
      report(14, "image prompt", false, shortReason(err));
    }
  }

  // 15: rename running, list, rename from the recent path
  if (want(15)) {
    try {
      let from = main.mark;
      main.send({ type: "rename_session", sessionId: state.sessionId, name: "E2E omp" });
      const first = await main.waitFor((m) => m.type === "rename_result", { from, timeoutMs: 30_000, what: "rename_result" });
      const listed = (await recentOmpSessions(main)).find((s) => s.sessionId === state.ompSessionId);
      const helpersBefore = ompChildren("rpc").length;
      from = main.mark;
      main.send({
        type: "rename_session",
        sessionId: state.ompSessionId,
        provider: "omp",
        providerSessionId: state.ompSessionId,
        projectPath: args.project,
        name: "E2E omp renamed",
      });
      let helperSeen = false;
      const watcher = setInterval(() => {
        if (ompChildren("rpc").length > helpersBefore) helperSeen = true;
      }, 50);
      const second = await main.waitFor((m) => m.type === "rename_result", { from, timeoutMs: 30_000, what: "rename_result" });
      clearInterval(watcher);
      const summary = await refreshSummary(main);
      const ok =
        first.success === true &&
        listed?.name === "E2E omp" &&
        second.success === true &&
        !helperSeen &&
        summary?.name === "E2E omp renamed";
      report(15, "rename running and from the recent list", ok,
        ok ? "" : `first=${first.success} listed=${listed?.name ?? "-"} second=${second.success} helper=${helperSeen}`);
    } catch (err) {
      report(15, "rename running and from the recent list", false, shortReason(err));
    }
  }

  // 16: stop, resume at once, history, attach
  if (want(16)) {
    try {
      // The resume must wait until the stopped child has exited (§6.7): no
      // sample may show the old child next to the new `--resume` child.
      const oldPids = ompChildren("any").map((row) => row.pid);
      const startedAt = Date.now();
      const wait = { overlap: false, oldGoneMs: null, newSeenMs: null };
      const sampleChildren = () => {
        const rows = ompChildren("any");
        const oldAlive = rows.some((row) => oldPids.includes(row.pid));
        const newResume = rows.some((row) => !oldPids.includes(row.pid) && /\s--resume\s/.test(row.args));
        if (!oldAlive && wait.oldGoneMs === null) wait.oldGoneMs = Date.now() - startedAt;
        if (newResume && wait.newSeenMs === null) wait.newSeenMs = Date.now() - startedAt;
        if (oldAlive && newResume) wait.overlap = true;
      };
      const sampler = bridgeChild ? setInterval(sampleChildren, 25) : null;
      let created;
      try {
        main.send({ type: "stop_session", sessionId: state.sessionId });
        const from = main.mark;
        main.send({
          type: "resume_session",
          sessionId: state.ompSessionId,
          projectPath: args.project,
          provider: "omp",
          executionMode: "default",
          resumeRequestId: "e2e-resume-1",
        });
        created = await main.waitFor(
          (m) => m.type === "system" && m.subtype === "session_created" && m.resumeRequestId === "e2e-resume-1",
          { from, timeoutMs: 90_000, what: "resume session_created" },
        );
      } finally {
        if (sampler) clearInterval(sampler);
      }
      if (sampler) sampleChildren();
      // Without the Bridge's process tree (--no-start-bridge) the wait is not checked.
      const waited = !bridgeChild ||
        (oldPids.length > 0 && !wait.overlap && wait.oldGoneMs !== null);
      state.sessionId = created.sessionId;
      state.bridgeSessionIds.add(created.sessionId);
      const historyFrom = main.mark;
      main.send({ type: "get_history", sessionId: state.sessionId });
      const past = await main.waitFor(
        (m) => m.type === "past_history" && m.sessionId === state.sessionId,
        { from: historyFrom, timeoutMs: 30_000, what: "past_history" },
      );
      const users = (past.messages ?? []).filter((m) => m.role === "user");
      const withUuid = users.filter((m) => String(m.uuid ?? "").startsWith("omp:entry:"));
      const hasFirst = users.some((m) => String(m.content ?? "").includes("Reply with exactly: OK") ||
        (Array.isArray(m.content) && m.content.some((b) => String(b.text ?? "").includes("Reply with exactly: OK"))));
      const attachFrom = main.mark;
      main.send({
        type: "resume_session",
        sessionId: state.ompSessionId,
        projectPath: args.project,
        provider: "omp",
        executionMode: "default",
        resumeRequestId: "e2e-resume-2",
      });
      const attached = await main.waitFor(
        (m) => m.type === "system" && m.subtype === "session_created" && m.resumeRequestId === "e2e-resume-2",
        { from: attachFrom, timeoutMs: 30_000, what: "attach session_created" },
      );
      const ok = waited && users.length >= 2 && withUuid.length === users.length && hasFirst &&
        attached.sessionId === state.sessionId;
      const waitNote = bridgeChild
        ? `old child gone after ${wait.oldGoneMs ?? "-"} ms, new child after ${wait.newSeenMs ?? "-"} ms`
        : "wait not checked";
      report(16, "stop, resume (after the old child exited), history and attach", ok,
        ok ? `${users.length} user messages; ${waitNote}`
          : `waited=${waited} oldPids=${oldPids.length} overlap=${wait.overlap} users=${users.length} uuids=${withUuid.length} attach=${attached.sessionId === state.sessionId}`);
    } catch (err) {
      report(16, "stop, resume (after the old child exited), history and attach", false, shortReason(err));
    }
  }

  // 17: conversation rewind
  if (want(17)) {
    try {
      const historyFrom = main.mark;
      main.send({ type: "get_history", sessionId: state.sessionId });
      const past = await main.waitFor(
        (m) => m.type === "past_history" && m.sessionId === state.sessionId,
        { from: historyFrom, timeoutMs: 30_000, what: "past_history" },
      );
      const users = (past.messages ?? []).filter((m) => m.role === "user" && String(m.uuid ?? "").startsWith("omp:entry:"));
      if (users.length < 2) throw new Error("fewer than two rewindable user messages");
      const target = users[1].uuid;
      const oldSessionId = state.sessionId;
      const from = main.mark;
      main.send({ type: "rewind", sessionId: oldSessionId, targetUuid: target, mode: "conversation" });
      const result = await main.waitFor((m) => m.type === "rewind_result", { from, timeoutMs: 90_000, what: "rewind_result" });
      if (!result.success) throw new Error(`rewind failed: ${String(result.error).slice(0, 80)}`);
      const created = await main.waitFor(
        (m) => m.type === "system" && m.subtype === "session_created" && m.sourceSessionId === oldSessionId,
        { from, timeoutMs: 30_000, what: "session_created after rewind" },
      );
      state.sessionId = created.sessionId;
      state.bridgeSessionIds.add(created.sessionId);
      const branchedId = created.claudeSessionId;
      if (branchedId) state.createdOmpSessionIds.add(branchedId);
      const file = branchedId ? await sessionFileOf(branchedId) : null;
      const header = file ? readHeader(file) : null;
      const promptFrom = await sendInput(main, "Reply with exactly: BRANCHED");
      await waitResult(main, promptFrom);
      await sleep(500);
      const landed = file ? readFileSync(file, "utf8").includes("Reply with exactly: BRANCHED") : false;
      const ok = !!header?.parentSession && landed;
      report(17, "conversation rewind to the second user message", ok,
        ok ? "" : `file=${!!file} parent=${!!header?.parentSession} landed=${landed}`);
      state.ompSessionId = branchedId ?? state.ompSessionId;
    } catch (err) {
      report(17, "conversation rewind to the second user message", false, shortReason(err));
    }
  }

  // 18: archive
  if (want(18)) {
    try {
      const from = main.mark;
      main.send({ type: "archive_session", sessionId: state.ompSessionId, provider: "omp", projectPath: args.project });
      const archived = await main.waitFor((m) => m.type === "archive_result", { from, timeoutMs: 30_000, what: "archive_result" });
      const listed = (await recentOmpSessions(main)).some((s) => s.sessionId === state.ompSessionId);
      const ok = archived.success === true && !listed;
      report(18, "archive removes the entry from the recent list", ok);
    } catch (err) {
      report(18, "archive removes the entry from the recent list", false, shortReason(err));
    }
  }

  // 1b: the undeclared client saw nothing of omp
  {
    const leaked = legacy.messages.filter(
      (m) =>
        state.bridgeSessionIds.has(m.sessionId) ||
        m.ompModels !== undefined ||
        m.ompAvailability !== undefined ||
        (Array.isArray(m.sessions) && m.sessions.some((s) => s.provider === "omp")),
    );
    report("1b", "client without omp support sees no omp data", leaked.length === 0,
      leaked.length ? `${leaked.length} messages` : "");
  }

  // 19: teardown
  for (const sessionId of state.bridgeSessionIds) {
    main.send({ type: "stop_session", sessionId });
  }
  await sleep(1500);
  main.close();
  legacy.close();
}

/** Print the session files this run created; delete them with --cleanup. */
async function reportSessionFiles() {
  let removed = 0;
  for (const id of state.createdOmpSessionIds) {
    const file = await sessionFileOf(id);
    if (!file) {
      console.log(`session file: none for ${id}`);
      continue;
    }
    console.log(`session file: ${file}`);
    if (!args.cleanup) continue;
    // Only files of this run's project: their header cwd is inside the E2E root.
    if (insideE2eRoot(readHeader(file)?.cwd)) {
      rmSync(file, { force: true });
      // The session's artifact directory sits next to it (<stem>/).
      if (file.endsWith(".jsonl")) {
        rmSync(file.slice(0, -".jsonl".length), { recursive: true, force: true });
      }
      removed += 1;
      // Drop the per-cwd bucket too once it holds nothing else.
      try {
        rmdirSync(dirname(file));
      } catch {
        // not empty or already gone
      }
    }
  }
  if (args.cleanup) console.log(`cleanup: removed ${removed} session files`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let teardownDone = null;

/**
 * Stops the test Bridge and its omp children, reports the session files and
 * prints the summary; runs once (normal end or a signal). Returns the number
 * of failed steps.
 */
function teardown() {
  teardownDone ??= (async () => {
    // PIDs of the omp children this run's Bridge still has (should be none
    // after the sessions were stopped); none may survive the Bridge.
    const children = ompChildren("any").map((row) => row.pid);
    if (args.startBridge) await stopBridge();
    await sleep(1000);
    const alive = children.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (args.startBridge) {
      report(19, "teardown stops the Bridge and its omp children", alive.length === 0,
        `${children.length} omp children at teardown, ${alive.length} left`);
    }
    await reportSessionFiles().catch((err) => console.log(`session files: ${shortReason(err)}`));
    const failed = results.filter((r) => !r.ok).length;
    console.log(`${results.length - failed} passed, ${failed} failed`);
    return failed;
  })();
  return teardownDone;
}

// The Bridge runs in its own process group, so Ctrl+C in the terminal does
// not reach it, and Node's default signal exit would skip `finally`: stop it
// here. A repeated signal while the teardown runs is ignored.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => {
    if (teardownDone) return;
    console.log(`${signal}: stopping the test Bridge`);
    teardown().finally(() => process.exit(code));
  });
}
// Last resort for any other exit path: never leave the Bridge group behind.
process.on("exit", () => {
  if (!bridgeRunning()) return;
  try {
    process.kill(-bridgeChild.pid, "SIGKILL");
  } catch {
    // already gone
  }
});

let exitCode = 0;
try {
  if (args.startBridge) await startBridge();
  await run();
} catch (err) {
  report("-", "run", false, shortReason(err));
} finally {
  exitCode = (await teardown()) > 0 ? 1 : 0;
}
process.exit(exitCode);
