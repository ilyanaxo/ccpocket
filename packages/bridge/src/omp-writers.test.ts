import { afterEach, describe, expect, it, vi } from "vitest";
import { createOmpWriterRegistry, type OmpWriterReservation } from "./omp-writers.js";

function exitSignal(): { exited: Promise<void>; exit: () => void } {
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  return { exited, exit };
}

describe("OmpWriterRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves at once when nobody writes the file", async () => {
    const registry = createOmpWriterRegistry();
    await expect(registry.waitForRelease("/tmp/none.jsonl")).resolves.toBeUndefined();
  });

  it("releases a file when its writer exits", async () => {
    const registry = createOmpWriterRegistry();
    const writer = exitSignal();
    registry.register("/tmp/a.jsonl", { owner: "s1", sessionId: "omp-a", exited: writer.exited });
    expect(registry.ownerBySessionId("omp-a")).toEqual({ owner: "s1", file: "/tmp/a.jsonl" });

    let released = false;
    const waiting = registry.waitForRelease("/tmp/a.jsonl").then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    writer.exit();
    await waiting;
    expect(released).toBe(true);
    expect(registry.ownerBySessionId("omp-a")).toBeUndefined();
  });

  it("normalizes paths", async () => {
    const registry = createOmpWriterRegistry();
    const writer = exitSignal();
    registry.register("/tmp/x/../a.jsonl", { owner: "s1", sessionId: "omp-a", exited: writer.exited });
    expect(registry.ownerBySessionId("omp-a")?.file).toBe("/tmp/a.jsonl");
  });

  it("rejects with omp_session_busy when the writer does not exit in time", async () => {
    vi.useFakeTimers();
    const registry = createOmpWriterRegistry();
    registry.register("/tmp/a.jsonl", {
      owner: "s1",
      sessionId: "omp-a",
      exited: new Promise(() => {}),
    });
    const waiting = registry.waitForRelease("/tmp/a.jsonl", 1000);
    const assertion = expect(waiting).rejects.toMatchObject({ code: "omp_session_busy" });
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it("waits for a writer that registered while an earlier one exited", async () => {
    const registry = createOmpWriterRegistry();
    const first = exitSignal();
    const second = exitSignal();
    registry.register("/tmp/a.jsonl", { owner: "s1", sessionId: "omp-a", exited: first.exited });
    let released = false;
    const waiting = registry.waitForRelease("/tmp/a.jsonl").then(() => {
      released = true;
    });
    registry.register("/tmp/a.jsonl", { owner: "s2", sessionId: "omp-a", exited: second.exited });
    first.exit();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(released).toBe(false);
    second.exit();
    await waiting;
    expect(released).toBe(true);
  });

  it("releases a registration explicitly for its owner only", () => {
    const registry = createOmpWriterRegistry();
    registry.register("/tmp/a.jsonl", { owner: "s1", sessionId: "omp-a", exited: new Promise(() => {}) });
    registry.release("/tmp/a.jsonl", "other");
    expect(registry.ownerBySessionId("omp-a")).toBeDefined();
    registry.release("/tmp/a.jsonl", "s1");
    expect(registry.ownerBySessionId("omp-a")).toBeUndefined();
  });

  it("lets only one of two waiters acquire a file released by the same exit", async () => {
    const registry = createOmpWriterRegistry();
    const holder = exitSignal();
    registry.register("/tmp/a.jsonl", { owner: "A", sessionId: "omp-a", exited: holder.exited });
    const order: string[] = [];
    const leases = new Map<string, OmpWriterReservation>();
    const acquire = (owner: string) =>
      registry.acquire("/tmp/a.jsonl", { owner, sessionId: "omp-a" }).then((lease) => {
        order.push(owner);
        leases.set(owner, lease);
      });
    const b = acquire("B");
    const c = acquire("C");
    holder.exit();
    await b;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["B"]);
    expect(registry.ownerBySessionId("omp-a")).toEqual({ owner: "B", file: "/tmp/a.jsonl" });
    leases.get("B")!.release();
    await c;
    expect(order).toEqual(["B", "C"]);
  });

  it("holds a reservation until the child it was handed to exits", async () => {
    const registry = createOmpWriterRegistry();
    const lease = await registry.acquire("/tmp/a.jsonl", { owner: "s1", sessionId: "omp-a" });
    const child = exitSignal();
    lease.holdUntil(child.exited);
    // The resumed process registers over its own reservation after the handshake.
    registry.register("/tmp/a.jsonl", { owner: "s1", sessionId: "omp-a", exited: child.exited });
    let released = false;
    const waiting = registry.waitForRelease("/tmp/a.jsonl").then(() => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(released).toBe(false);
    child.exit();
    await waiting;
    expect(registry.ownerBySessionId("omp-a")).toBeUndefined();
  });

  it("wakes waiters when a registration is released explicitly", async () => {
    const registry = createOmpWriterRegistry();
    registry.register("/tmp/a.jsonl", { owner: "s1", sessionId: "omp-a", exited: new Promise(() => {}) });
    const waiting = registry.waitForRelease("/tmp/a.jsonl", 1000);
    registry.release("/tmp/a.jsonl", "s1");
    await expect(waiting).resolves.toBeUndefined();
  });

  it("times out an acquire with omp_session_busy", async () => {
    vi.useFakeTimers();
    const registry = createOmpWriterRegistry();
    registry.register("/tmp/a.jsonl", { owner: "s1", sessionId: "omp-a", exited: new Promise(() => {}) });
    const acquiring = registry.acquire("/tmp/a.jsonl", { owner: "s2", sessionId: "omp-a" }, 1000);
    const assertion = expect(acquiring).rejects.toMatchObject({ code: "omp_session_busy" });
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(registry.ownerBySessionId("omp-a")?.owner).toBe("s1");
  });

  it("treats a rejected exit promise as released", async () => {
    const registry = createOmpWriterRegistry();
    registry.register("/tmp/a.jsonl", {
      owner: "s1",
      sessionId: "omp-a",
      exited: Promise.reject(new Error("spawn failed")),
    });
    await expect(registry.waitForRelease("/tmp/a.jsonl")).resolves.toBeUndefined();
  });
});
