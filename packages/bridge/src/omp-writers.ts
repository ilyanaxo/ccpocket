import { resolve } from "node:path";
import { ompError } from "./omp-types.js";

/**
 * Bridge-wide registry of omp processes that write a session file.
 *
 * omp writes session files without a cross-process lock, so the Bridge makes
 * sure it never runs two omp processes on the same file: every spawn with
 * `--resume <file>` first acquires the file, which waits until the previous
 * writer has exited and reserves the file in the same step.
 */
export interface OmpWriterOwner {
  /** Bridge session id, or a helper id such as `omp-rename:<sessionId>`. */
  owner: string;
  /** omp session id of the file. */
  sessionId: string;
  /** Settles when the writing process has exited. */
  exited: Promise<unknown>;
}

/** A file reserved by `acquire`, held until released or until its child exits. */
export interface OmpWriterReservation {
  /** Keep the reservation until `exited` (the writing child's exit) settles. */
  holdUntil(exited: Promise<unknown>): void;
  /** Drop the reservation now (the child was never spawned). */
  release(): void;
}

export interface OmpWriterRegistry {
  /** Record `owner` as the writer of `file` until `owner.exited` settles. */
  register(file: string, owner: OmpWriterOwner): void;
  /** Drop a registration early (after `branch` moved the process to a new file). */
  release(file: string, owner: string): void;
  /**
   * Wait until no process holds `file`, then reserve it for `owner` in the
   * same synchronous step, so two waiters released by one exit never both
   * proceed. Rejects with `omp_session_busy` on timeout.
   */
  acquire(
    file: string,
    owner: { owner: string; sessionId: string },
    timeoutMs?: number,
  ): Promise<OmpWriterReservation>;
  /**
   * Resolve once no process holds `file`; reject with `omp_session_busy` on
   * timeout. Reserves nothing: a caller that spawns a writer uses `acquire`.
   */
  waitForRelease(file: string, timeoutMs?: number): Promise<void>;
  /** The live or reserved writer of an omp session, if any. */
  ownerBySessionId(sessionId: string): { owner: string; file: string } | undefined;
  /** Every file currently held by a writer (doctor reports). */
  files(): Array<{ file: string; owner: string; sessionId: string }>;
}

const DEFAULT_RELEASE_TIMEOUT_MS = 15_000;

interface Registration {
  owner: string;
  sessionId: string;
  /** Resolves when this registration ends (exit, explicit release, takeover). */
  released: Promise<void>;
  /** Ends this registration (idempotent). */
  end: () => void;
}

class DefaultOmpWriterRegistry implements OmpWriterRegistry {
  private readonly entries = new Map<string, Registration>();

  register(file: string, owner: OmpWriterOwner): void {
    const end = this.add(resolve(file), owner);
    owner.exited.then(end, end);
  }

  release(file: string, owner: string): void {
    const registration = this.entries.get(resolve(file));
    if (registration?.owner === owner) registration.end();
  }

  async acquire(
    file: string,
    owner: { owner: string; sessionId: string },
    timeoutMs = DEFAULT_RELEASE_TIMEOUT_MS,
  ): Promise<OmpWriterReservation> {
    const key = resolve(file);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const registration = this.entries.get(key);
      if (!registration) {
        // Checked and reserved in the same synchronous step.
        const end = this.add(key, owner);
        let held = false;
        return {
          holdUntil: (exited) => {
            if (held) return;
            held = true;
            exited.then(end, end);
          },
          release: end,
        };
      }
      await waitForEnd(key, registration, deadline);
    }
  }

  async waitForRelease(
    file: string,
    timeoutMs = DEFAULT_RELEASE_TIMEOUT_MS,
  ): Promise<void> {
    const key = resolve(file);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const registration = this.entries.get(key);
      if (!registration) return;
      await waitForEnd(key, registration, deadline);
    }
  }

  ownerBySessionId(
    sessionId: string,
  ): { owner: string; file: string } | undefined {
    for (const [file, registration] of this.entries) {
      if (registration.sessionId === sessionId) {
        return { owner: registration.owner, file };
      }
    }
    return undefined;
  }

  files(): Array<{ file: string; owner: string; sessionId: string }> {
    return [...this.entries].map(([file, registration]) => ({
      file,
      owner: registration.owner,
      sessionId: registration.sessionId,
    }));
  }

  /** Add a registration for `key`; the returned function ends it (idempotent). */
  private add(key: string, owner: { owner: string; sessionId: string }): () => void {
    let resolveReleased!: () => void;
    const released = new Promise<void>((resolveEnd) => {
      resolveReleased = resolveEnd;
    });
    let ended = false;
    const registration: Registration = {
      owner: owner.owner,
      sessionId: owner.sessionId,
      released,
      end: () => {
        if (ended) return;
        ended = true;
        if (this.entries.get(key) === registration) this.entries.delete(key);
        resolveReleased();
      },
    };
    const previous = this.entries.get(key);
    this.entries.set(key, registration);
    // A takeover (the resumed process registering over its own reservation)
    // wakes the waiters of the previous entry; they loop and wait for this one.
    previous?.end();
    return registration.end;
  }
}

/**
 * Wait until `registration` ends; reject with `omp_session_busy` at `deadline`.
 * Callers loop: another writer may take the file in the meantime.
 */
async function waitForEnd(
  key: string,
  registration: Registration,
  deadline: number,
): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw busyError(key, registration);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    registration.released.then(() => false),
    new Promise<boolean>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(true), remaining);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (timedOut) throw busyError(key, registration);
}

function busyError(file: string, registration: Registration) {
  return ompError(
    "omp_session_busy",
    `The omp session file is still in use by another process (${registration.owner}): ${file}`,
  );
}

export function createOmpWriterRegistry(): OmpWriterRegistry {
  return new DefaultOmpWriterRegistry();
}

/** The Bridge-wide registry. */
export const ompWriters: OmpWriterRegistry = createOmpWriterRegistry();
