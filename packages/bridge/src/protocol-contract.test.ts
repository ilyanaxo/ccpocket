import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// BridgeWebSocketServer's stores resolve homedir() at import time; point HOME
// at a temp directory before the Bridge modules load so the suite never
// writes into the real ~/.ccpocket.
const suiteHome = await vi.hoisted(async () => {
  const { mkdtempSync: makeTemp } = await import("node:fs");
  const { tmpdir: osTmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const home = makeTemp(joinPath(osTmpdir(), "ccpocket-contract-suite-"));
  process.env.HOME = home;
  return home;
});

afterAll(() => {
  rmSync(suiteHome, { recursive: true, force: true });
});
import { parseClientMessage } from "./parser.js";
import {
  BRIDGE_PROTOCOL_CAPABILITIES,
  clientProtocolRange,
  negotiateProtocolVersion,
} from "./protocol-version.js";
import { getVersionInfo } from "./version.js";
import { BridgeWebSocketServer } from "./websocket.js";

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../../test/fixtures/protocol/v1/${name}.json`, import.meta.url),
    "utf8",
  );
}

describe("protocol v1 contract fixtures", () => {
  it.each(["legacy-client-capabilities", "current-client-capabilities"])(
    "accepts %s",
    (name) => {
      const message = parseClientMessage(fixture(name));
      expect(message?.type).toBe("client_capabilities");
      if (message?.type !== "client_capabilities") return;

      expect(
        negotiateProtocolVersion(clientProtocolRange(message)),
      ).toBe(1);
    },
  );

  it.each(["legacy-session-list", "current-session-list"])(
    "keeps %s as a frozen server fixture",
    (name) => {
      const message = JSON.parse(fixture(name)) as Record<string, unknown>;
      expect(message.type).toBe("session_list");
      expect(message.sessions).toEqual([]);
    },
  );
});

// ---- omp contract (docs/omp-integration.md §9.6) ----

const { sessionListMock, listOmpModelsMock, getAllRecentSessionsMock } = vi.hoisted(() => ({
  sessionListMock: vi.fn((): unknown[] => []),
  listOmpModelsMock: vi.fn(),
  getAllRecentSessionsMock: vi.fn(),
}));

vi.mock("./session.js", () => ({
  MAX_HISTORY_PER_SESSION: 100,
  providerSupportsQueuedInput: (provider: string) =>
    provider === "codex" || provider === "omp",
  SessionManager: class ContractSessionManager {
    list() {
      return sessionListMock();
    }
    get() {
      return undefined;
    }
    getWorktreeStore() {
      return null;
    }
    destroyAll() {}
  },
}));

vi.mock("./omp-sessions.js", () => ({
  findOmpSessionFile: vi.fn(async () => null),
  getOmpSessionName: vi.fn(async () => null),
  getOmpSessionSettings: vi.fn(async () => undefined),
  listOmpModels: listOmpModelsMock,
  readOmpSessionHeader: vi.fn(async () => null),
  renameOmpRecentSession: vi.fn(async () => false),
}));

vi.mock("./sessions-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sessions-index.js")>()),
  getAllRecentSessions: getAllRecentSessionsMock,
}));

function jsonFixture(name: string): unknown {
  return JSON.parse(fixture(name)) as unknown;
}

function variants(name: string): Array<Record<string, unknown>> {
  const value = jsonFixture(name);
  return (Array.isArray(value) ? value : [value]) as Array<Record<string, unknown>>;
}

const OMP_CLIENT_FIXTURES = [
  "omp-client-capabilities",
  "omp-start",
  "omp-resume",
  "legacy-app-omp-resume",
  "omp-set-model",
  "omp-list-recent-sessions",
  "omp-resolve-session-link",
  "omp-archive-session",
];

describe("protocol v1 omp contract fixtures", () => {
  it.each(OMP_CLIENT_FIXTURES)("parses every variant of the client fixture %s", (name) => {
    for (const variant of variants(name)) {
      const parsed = parseClientMessage(JSON.stringify(variant));
      expect(parsed).toEqual(variant);
    }
  });

  it("negotiates protocol 1 with the omp client_capabilities fixture", () => {
    const message = parseClientMessage(fixture("omp-client-capabilities"));
    expect(message?.type).toBe("client_capabilities");
    if (message?.type !== "client_capabilities") return;
    expect(negotiateProtocolVersion(clientProtocolRange(message))).toBe(1);
  });

  it("advertises the same capabilities in /version", () => {
    expect(getVersionInfo(Date.now()).protocolCapabilities).toEqual([
      ...BRIDGE_PROTOCOL_CAPABILITIES,
    ]);
    expect(BRIDGE_PROTOCOL_CAPABILITIES).toContain("provider_omp_v1");
  });

  describe("server fixtures built by the Bridge", () => {
    let httpServer: ReturnType<typeof createServer>;
    let bridge: BridgeWebSocketServer;
    let tempHome: string;
    const savedHome = process.env.HOME;

    beforeEach(() => {
      // The Bridge's stores write under ~/.ccpocket.
      tempHome = mkdtempSync(join(tmpdir(), "ccpocket-contract-"));
      process.env.HOME = tempHome;
      httpServer = createServer();
      sessionListMock.mockReset();
      listOmpModelsMock.mockReset();
      getAllRecentSessionsMock.mockReset();
    });

    afterEach(() => {
      bridge?.close();
      httpServer.close();
      process.env.HOME = savedHome;
      rmSync(tempHome, { recursive: true, force: true });
    });

    function client(declaresOmp: boolean) {
      const ws = { readyState: 1, send: vi.fn() };
      (bridge as any).wss.clients.add(ws);
      const capabilities = JSON.parse(fixture("omp-client-capabilities")) as Record<string, unknown>;
      if (!declaresOmp) delete capabilities.supportedProviders;
      return {
        ws,
        declare: () =>
          (bridge as any).handleClientMessage(parseClientMessage(JSON.stringify(capabilities)), ws),
        messages: () =>
          ws.send.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>),
      };
    }

    it("sends omp-session-list.json from sendSessionList and broadcastSessionList", async () => {
      const expected = jsonFixture("omp-session-list") as Record<string, unknown>;
      sessionListMock.mockReturnValue(expected.sessions as unknown[]);
      listOmpModelsMock.mockResolvedValue({
        models: expected.ompModels,
        availability: expected.ompAvailability,
      });
      bridge = new BridgeWebSocketServer({ server: httpServer });
      await (bridge as any).refreshOmpModels();

      const omp = client(true);
      await omp.declare();
      const direct = omp.messages().filter((m) => m.type === "session_list").at(-1);
      expect(direct).toMatchObject(expected);

      omp.ws.send.mockClear();
      (bridge as any).broadcastSessionList();
      const broadcast = omp.messages().find((m) => m.type === "session_list");
      expect(broadcast).toMatchObject(expected);
    });

    it("keeps omp sessions and fields away from a client that does not declare omp", async () => {
      const expected = jsonFixture("omp-session-list") as Record<string, unknown>;
      sessionListMock.mockReturnValue(expected.sessions as unknown[]);
      listOmpModelsMock.mockResolvedValue({
        models: expected.ompModels,
        availability: expected.ompAvailability,
      });
      bridge = new BridgeWebSocketServer({ server: httpServer });
      await (bridge as any).refreshOmpModels();

      const legacy = client(false);
      await legacy.declare();
      (bridge as any).sendSessionList(legacy.ws);
      const list = legacy.messages().filter((m) => m.type === "session_list").at(-1)!;
      expect(list.sessions).toEqual([]);
      expect(list.protocolCapabilities).toEqual(expected.protocolCapabilities);
      expect(list).not.toHaveProperty("ompModels");
      expect(list).not.toHaveProperty("ompAvailability");
      expect(list).not.toHaveProperty("ompModelsRevision");
    });

    it("sends omp-recent-sessions.json for list_recent_sessions {provider:\"omp\"}", async () => {
      const expected = jsonFixture("omp-recent-sessions") as Record<string, unknown>;
      const entries = (expected.sessions as Array<Record<string, unknown>>).map(
        ({ workspace: _workspace, ...entry }) => entry,
      );
      getAllRecentSessionsMock.mockResolvedValue({ sessions: entries, hasMore: false });
      listOmpModelsMock.mockResolvedValue({ models: [], availability: "no_models" });
      bridge = new BridgeWebSocketServer({ server: httpServer });
      const omp = client(true);
      await omp.declare();
      const request = variants("omp-list-recent-sessions").find((v) => v.provider === "omp")!;
      await (bridge as any).handleClientMessage(parseClientMessage(JSON.stringify(request)), omp.ws);
      await vi.waitFor(() =>
        expect(omp.messages().some((m) => m.type === "recent_sessions")).toBe(true),
      );
      expect(omp.messages().find((m) => m.type === "recent_sessions")).toMatchObject(expected);
      expect(getAllRecentSessionsMock).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "omp" }),
      );
    });
  });
});
