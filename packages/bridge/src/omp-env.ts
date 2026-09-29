import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Terminal ids omp derives its terminal breadcrumb from. A Bridge child that
 * inherits them would overwrite the breadcrumb the user's own `omp -c` reads.
 * The list matches the omp v18.3.2 binary's `ttyid`.
 */
export const OMP_BREADCRUMB_ENV_VARS = [
  "TMUX_PANE",
  "ZELLIJ_PANE_ID",
  "CMUX_SURFACE_ID",
  "KITTY_WINDOW_ID",
  "WEZTERM_PANE",
  "TERM_SESSION_ID",
  "WT_SESSION",
] as const;

const DEFAULT_OMP_BIN = "omp";
const DEFAULT_CONFIG_DIR_NAME = ".omp";
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/** `BRIDGE_OMP_BIN` when set and non-empty, otherwise `omp` on PATH. */
export function resolveOmpBin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BRIDGE_OMP_BIN?.trim();
  return configured ? configured : DEFAULT_OMP_BIN;
}

/**
 * The model for `omp -p` assist runs (titles, commit messages):
 * `BRIDGE_OMP_ASSIST_MODEL` when set and non-empty, else the session's current
 * model selector, else omp's default (mirrors `BRIDGE_CODEX_ASSIST_MODEL`).
 */
export function resolveOmpAssistModel(
  sessionModel: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env.BRIDGE_OMP_ASSIST_MODEL?.trim();
  if (configured) return configured;
  const model = sessionModel?.trim();
  return model ? model : undefined;
}

/**
 * Node reports `ENOENT` both for a missing binary and for a missing spawn
 * `cwd`. Returns the directory when the failure is the missing `cwd`.
 */
export function missingSpawnCwd(err: unknown, cwd: string): string | null {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  if (code !== "ENOENT") return null;
  return existsSync(cwd) ? null : cwd;
}

/**
 * Variables `setup` persists into the service definition so the service
 * resolves the same omp binary, assist model and session store as the shell
 * that ran `setup` (docs/omp-integration.md §8.6).
 */
export const OMP_SERVICE_ENV_VARS = [
  "BRIDGE_OMP_BIN",
  "BRIDGE_OMP_ASSIST_MODEL",
  "OMP_PROFILE",
  "PI_PROFILE",
  "PI_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
] as const;

/**
 * The omp variables to persist, in `OMP_SERVICE_ENV_VARS` order. A set,
 * non-empty value is kept; `OMP_PROFILE` is kept even when empty, because a
 * defined `OMP_PROFILE` wins over `PI_PROFILE`.
 */
export function ompServiceEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const name of OMP_SERVICE_ENV_VARS) {
    const value = env[name];
    if (value === undefined) continue;
    if (value.trim() === "" && name !== "OMP_PROFILE") continue;
    entries.push([name, value]);
  }
  return entries;
}

/** A copy of `env` without the terminal breadcrumb variables. */
export function sanitizedOmpEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of OMP_BREADCRUMB_ENV_VARS) delete copy[key];
  return copy;
}

export interface OmpStore {
  /** Profile-independent config root, `~/<PI_CONFIG_DIR ?? ".omp">`. */
  root: string;
  /** Active profile name; undefined for the default profile. */
  profile?: string;
  /**
   * The profile value omp rejects ("Invalid OMP profile"): every omp command
   * fails with this environment, so the Bridge lists no sessions. The paths
   * below are then those of the default profile, for reports only.
   */
  invalidProfile?: string;
  agentDir: string;
  /** Root of the per-cwd session buckets. */
  sessionsDir: string;
  /** `PI_CODING_AGENT_SESSION_DIR`: one flat directory used for every cwd. */
  flatSessionDir?: string;
  blobsDir: string;
}

/**
 * Resolve omp's session store the way omp v18.3.2 does
 * (`packages/utils/src/dirs.ts`):
 *
 * - root: `~/<PI_CONFIG_DIR || ".omp">`;
 * - profile: `OMP_PROFILE` when defined (even empty), else `PI_PROFILE`;
 *   empty, whitespace and `default` select the default profile; a name omp
 *   rejects is reported as `invalidProfile` (omp exits with "Invalid OMP
 *   profile", `normalizeProfileName`, `cli.ts` `runCli`);
 * - named profile: `<root>/profiles/<name>/agent`;
 * - default profile: `PI_CODING_AGENT_DIR` (resolved) or `<root>/agent`. A
 *   `PI_CODING_AGENT_DIR` that equals the agent dir of `PI_PROFILE` was
 *   inherited from a parent's profile switch and is ignored, as omp does
 *   (`resolvePreProfileAgentDir`);
 * - `PI_CODING_AGENT_SESSION_DIR` replaces the bucketed session layout.
 *
 * XDG relocation (`$XDG_DATA_HOME/omp`) is not supported.
 */
export function resolveOmpStore(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): OmpStore {
  const root = join(home, env.PI_CONFIG_DIR || DEFAULT_CONFIG_DIR_NAME);
  const rawProfile = env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE;
  const profile = normalizeOmpProfile(rawProfile);
  let agentDir: string;
  if (profile.name) {
    agentDir = profileAgentDir(root, profile.name);
  } else {
    const override = env.PI_CODING_AGENT_DIR;
    const piProfile = normalizeOmpProfile(env.PI_PROFILE).name;
    const inherited =
      piProfile !== undefined && override === profileAgentDir(root, piProfile);
    agentDir = override && !inherited ? resolve(override) : join(root, "agent");
  }
  const flat = env.PI_CODING_AGENT_SESSION_DIR;
  return {
    root,
    ...(profile.name ? { profile: profile.name } : {}),
    ...(profile.invalid ? { invalidProfile: rawProfile } : {}),
    agentDir,
    sessionsDir: join(agentDir, "sessions"),
    ...(flat ? { flatSessionDir: resolve(flat) } : {}),
    blobsDir: join(agentDir, "blobs"),
  };
}

function profileAgentDir(root: string, profile: string): string {
  return join(root, "profiles", profile, "agent");
}

/** omp's `normalizeProfileName`, without throwing. */
function normalizeOmpProfile(raw: string | undefined): { name?: string; invalid?: true } {
  const name = raw?.trim();
  if (!name || name === "default") return {};
  if (
    name === "." ||
    name === ".." ||
    name.endsWith(".") ||
    !PROFILE_NAME_RE.test(name) ||
    WINDOWS_RESERVED_BASENAME_RE.test(name)
  ) {
    return { invalid: true };
  }
  return { name };
}

/** The overlay makes omp's `ask` tool wait for the phone instead of auto-answering. */
export const OMP_RPC_OVERLAY_CONTENT = [
  "# Written by ccpocket Bridge. Applies only to omp processes started by the Bridge.",
  "ask:",
  "  timeout: 0",
  "",
].join("\n");

export function defaultOmpRpcOverlayPath(home: string = homedir()): string {
  return join(home, ".ccpocket", "omp-rpc-overlay.yml");
}

/**
 * Write the `--config` overlay (mode 0600) when its content differs, and
 * return its path. omp fails hard on a missing overlay file, so this runs
 * before every spawn.
 */
export async function writeOmpRpcOverlay(
  path: string = defaultOmpRpcOverlayPath(),
): Promise<string> {
  let current: string | null = null;
  try {
    current = await readFile(path, "utf8");
  } catch {
    current = null;
  }
  if (current !== OMP_RPC_OVERLAY_CONTENT) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, OMP_RPC_OVERLAY_CONTENT, { encoding: "utf8", mode: 0o600 });
  }
  // writeFile's mode applies only on creation; an existing file keeps its mode.
  await chmod(path, 0o600);
  return path;
}
