/**
 * Connection-level behaviour of BridgeWebSocketServer over real sockets:
 * API key checks on the upgrade request and the keepalive ping. HOME points
 * at a temp directory, and the connect-time model refresh (which would spawn
 * provider CLIs) is stubbed.
 */
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import {
  connect,
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type ClientOptions } from "ws";

// Stores resolve their directories from homedir() at import time, so HOME
// must point at a temp directory before the Bridge modules are imported.
const suiteHome = await vi.hoisted(async () => {
  const { mkdtempSync: makeTemp } = await import("node:fs");
  const { tmpdir: osTmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const home = makeTemp(joinPath(osTmpdir(), "ccpocket-ws-connection-suite-"));
  process.env.HOME = home;
  return home;
});

import { BridgeWebSocketServer } from "./websocket.js";

const API_KEY = "test-api-key";

/** Data in one direction of a {@link startLink} proxy. */
interface LinkDirection {
  /** Holds data back instead of forwarding it. */
  hold(): void;
  /** Forwards up to `bytes` of the held data and keeps holding the rest. */
  release(bytes: number): void;
  /** Forwards all held data and stops holding. */
  open(): void;
}

/**
 * A TCP proxy between one test client and the Bridge that models a slow link:
 * each direction can be held back, and `bridgeSide` can be paused so that the
 * Bridge's own write queue fills up.
 */
interface Link {
  bridgeSide: Socket;
  toBridge: LinkDirection;
  toClient: LinkDirection;
}

function linkDirection(source: Socket, target: Socket): LinkDirection {
  const held: Buffer[] = [];
  let holding = false;
  source.on("data", (chunk: Buffer) => {
    if (holding) held.push(chunk);
    else target.write(chunk);
  });
  const release = (bytes: number) => {
    while (bytes > 0 && held.length > 0) {
      const chunk = held.shift()!;
      if (chunk.length > bytes) held.unshift(chunk.subarray(bytes));
      target.write(chunk.subarray(0, bytes));
      bytes -= chunk.length;
    }
  };
  return {
    hold: () => {
      holding = true;
    },
    release,
    open: () => {
      holding = false;
      release(Infinity);
    },
  };
}

describe("BridgeWebSocketServer connections", () => {
  let httpServer: Server | null = null;
  let bridge: BridgeWebSocketServer | null = null;
  const clients: WebSocket[] = [];
  const proxies: NetServer[] = [];
  const proxySockets: Socket[] = [];

  afterEach(async () => {
    for (const client of clients) client.terminate();
    clients.length = 0;
    for (const socket of proxySockets) socket.destroy();
    proxySockets.length = 0;
    for (const proxy of proxies) proxy.close();
    proxies.length = 0;
    bridge?.close();
    bridge = null;
    await new Promise<void>((resolve) =>
      httpServer ? httpServer.close(() => resolve()) : resolve(),
    );
    httpServer = null;
    vi.useRealTimers();
  });

  afterAll(() => {
    rmSync(suiteHome, { recursive: true, force: true });
  });

  async function start(apiKey?: string): Promise<number> {
    httpServer = createServer();
    bridge = new BridgeWebSocketServer({ server: httpServer, apiKey });
    vi.spyOn(bridge as any, "refreshConnectionMetadata").mockImplementation(() => {});
    await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
    return (httpServer!.address() as AddressInfo).port;
  }

  function client(port: number, path = "/", options: ClientOptions = {}): WebSocket {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, options);
    clients.push(ws);
    return ws;
  }

  /** Start a proxy to the Bridge; `link` resolves once a client connects. */
  async function startLink(bridgePort: number): Promise<{ port: number; link: Promise<Link> }> {
    const proxy = createNetServer();
    proxies.push(proxy);
    const link = new Promise<Link>((resolve) => {
      proxy.once("connection", (clientSide) => {
        const bridgeSide = connect(bridgePort, "127.0.0.1");
        for (const socket of [clientSide, bridgeSide]) {
          proxySockets.push(socket);
          socket.on("error", () => {});
        }
        clientSide.on("close", () => bridgeSide.destroy());
        bridgeSide.on("close", () => clientSide.destroy());
        resolve({
          bridgeSide,
          toBridge: linkDirection(clientSide, bridgeSide),
          toClient: linkDirection(bridgeSide, clientSide),
        });
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    return { port: (proxy.address() as AddressInfo).port, link };
  }

  /** The Bridge's end of the only connected client. */
  async function bridgeEnd(): Promise<WebSocket> {
    await waitFor(() => bridge!.clientCount === 1);
    return [...(bridge as any).wss.clients][0] as WebSocket;
  }

  function rawSocket(ws: WebSocket): Socket {
    return (ws as any)._socket as Socket;
  }

  /**
   * Text that permessage-deflate cannot shrink much, so it occupies the link
   * like real traffic (images, file contents) does.
   */
  function incompressible(bytes: number): string {
    return randomBytes(Math.ceil((bytes * 3) / 4)).toString("base64");
  }

  function tick(): void {
    vi.advanceTimersByTime(BridgeWebSocketServer.KEEPALIVE_INTERVAL_MS);
  }

  /** Resolve with the close code, or "message" when the Bridge sends data first. */
  function firstOutcome(ws: WebSocket): Promise<number | "message"> {
    return new Promise((resolve, reject) => {
      ws.once("message", () => resolve("message"));
      ws.once("close", (code) => resolve(code));
      ws.once("error", reject);
    });
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(condition()).toBe(true);
  }

  describe("API key", () => {
    it("rejects a client without a token", async () => {
      const port = await start(API_KEY);

      expect(await firstOutcome(client(port))).toBe(4001);
    });

    it("accepts the key as a token query parameter", async () => {
      const port = await start(API_KEY);

      expect(await firstOutcome(client(port, `/?token=${API_KEY}`))).toBe("message");
    });

    it("accepts the key as a Bearer authorization header", async () => {
      const port = await start(API_KEY);
      const ws = client(port, "/", { headers: { Authorization: `Bearer ${API_KEY}` } });

      expect(await firstOutcome(ws)).toBe("message");
    });

    it("accepts clients without a token when no API key is set", async () => {
      const port = await start();

      expect(await firstOutcome(client(port))).toBe("message");
    });

    it("ignores a malformed Host header instead of crashing", async () => {
      const port = await start(API_KEY);
      const headers = { Host: "a b" };

      expect(await firstOutcome(client(port, "/", { headers }))).toBe(4001);
      expect(
        await firstOutcome(client(port, `/?token=${API_KEY}`, { headers })),
      ).toBe("message");
    });

    it("rejects an upgrade whose target is not a URL", async () => {
      const port = await start(API_KEY);
      const socket = connect(port, "127.0.0.1");
      const received: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => received.push(chunk));
      await once(socket, "connect");
      socket.write(
        [
          `GET //[?token=${API_KEY} HTTP/1.1`,
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
      // Close frame (0x88) with status code 4001 (0x0fa1).
      const closeFrame = Buffer.from([0x0f, 0xa1]);
      await waitFor(() => Buffer.concat(received).includes(closeFrame));
      socket.destroy();

      expect(Buffer.concat(received).toString("latin1")).toMatch(/^HTTP\/1\.1 101 /);
    });
  });

  describe("keepalive", () => {
    it("terminates a client that answers no ping for two intervals", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const port = await start();
      const responsive = client(port);
      const silent = client(port, "/", { autoPong: false });
      await Promise.all([once(responsive, "open"), once(silent, "open")]);
      await waitFor(() => bridge!.clientCount === 2);

      const serverSockets = [...(bridge as any).wss.clients] as WebSocket[];
      const pongReceived = new Promise((resolve) => {
        for (const socket of serverSockets) socket.once("pong", resolve);
      });
      const pinged = Promise.all([once(responsive, "ping"), once(silent, "ping")]);
      tick();
      await pinged;
      await pongReceived;

      const pingedAgain = Promise.all([once(responsive, "ping"), once(silent, "ping")]);
      tick();
      await pingedAgain;
      expect(silent.readyState).toBe(WebSocket.OPEN);

      const silentClosed = once(silent, "close");
      const responsivePinged = once(responsive, "ping");
      tick();
      const [code] = await silentClosed;
      await responsivePinged;

      expect(code).toBe(1006);
      expect(responsive.readyState).toBe(WebSocket.OPEN);
      await waitFor(() => bridge!.clientCount === 1);
    });

    it("keeps a client whose pong is delayed behind a large message", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const proxy = await startLink(await start());
      const ws = client(proxy.port);
      await once(ws, "open");
      const link = await proxy.link;
      const server = await bridgeEnd();

      link.toClient.hold();
      server.send(incompressible(1_000_000));
      tick();
      tick();
      expect(server.readyState).toBe(WebSocket.OPEN);

      const pongReceived = once(server, "pong");
      link.toClient.open();
      await pongReceived;
      tick();

      expect(server.readyState).toBe(WebSocket.OPEN);
    });

    it("keeps a client while the Bridge's queued data to it drains", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const proxy = await startLink(await start());
      const ws = client(proxy.port);
      await once(ws, "open");
      const link = await proxy.link;
      const server = await bridgeEnd();

      link.toClient.hold();
      link.bridgeSide.pause();
      server.send(incompressible(16 * 1024 * 1024));
      // Compression is asynchronous; tick once the frame reached the socket.
      await waitFor(() => rawSocket(server).writableLength > 0);
      tick();
      // The ping waits in the Bridge's write queue behind the message.
      expect(rawSocket(server).writableLength).toBeGreaterThan(0);

      link.bridgeSide.resume();
      await waitFor(() => rawSocket(server).writableLength === 0);
      tick();
      tick();
      expect(server.readyState).toBe(WebSocket.OPEN);

      const pongReceived = once(server, "pong");
      link.toClient.open();
      await pongReceived;
    });

    it("terminates a client whose queued data stops draining", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const proxy = await startLink(await start());
      const ws = client(proxy.port);
      await once(ws, "open");
      const link = await proxy.link;
      const server = await bridgeEnd();

      link.bridgeSide.pause();
      server.send(incompressible(16 * 1024 * 1024));
      // Compression is asynchronous; tick once the frame reached the socket.
      await waitFor(() => rawSocket(server).writableLength > 0);
      tick();
      expect(rawSocket(server).writableLength).toBeGreaterThan(0);
      tick();
      tick();

      await waitFor(() => bridge!.clientCount === 0);
    });

    it("keeps a client whose pong is queued behind its own large upload", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const proxy = await startLink(await start());
      const ws = client(proxy.port);
      await once(ws, "open");
      const link = await proxy.link;
      const server = await bridgeEnd();

      link.toBridge.hold();
      ws.send(JSON.stringify({ type: "keepalive_padding", padding: incompressible(1_000_000) }));
      // Compression is asynchronous; wait until the upload sits in the link.
      await waitFor(() => ws.bufferedAmount === 0);
      const pinged = once(ws, "ping");
      tick();
      // The automatic pong is now queued behind the upload.
      await pinged;
      for (let interval = 0; interval < 2; interval += 1) {
        const received = once(rawSocket(server), "data");
        link.toBridge.release(64 * 1024);
        await received;
        tick();
      }
      expect(server.readyState).toBe(WebSocket.OPEN);

      const pongReceived = once(server, "pong");
      link.toBridge.open();
      await pongReceived;
    });

    it("does not ping before the interval elapses", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const port = await start();
      const ws = client(port);
      const onPing = vi.fn();
      ws.on("ping", onPing);
      await once(ws, "open");

      vi.advanceTimersByTime(BridgeWebSocketServer.KEEPALIVE_INTERVAL_MS - 1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(onPing).not.toHaveBeenCalled();
    });
  });
});
