import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TEST_HOME, fetchAllUsageMock, runDoctorMock } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/ccpocket-http-handler-test-home-${process.pid}`,
  fetchAllUsageMock: vi.fn(),
  runDoctorMock: vi.fn(),
}));

// GalleryStore resolves its directory from homedir() at import time.
vi.mock("node:os", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:os")>();
  return { ...mod, homedir: () => TEST_HOME };
});
vi.mock("./usage.js", () => ({ fetchAllUsage: fetchAllUsageMock }));
vi.mock("./doctor.js", () => ({ runDoctor: runDoctorMock }));

import { createHttpRequestHandler } from "./http-handler.js";
import { GalleryStore } from "./gallery-store.js";
import { ImageStore } from "./image-store.js";
import { MediaStore } from "./media-store.js";
import { UploadStore } from "./upload-store.js";

const API_KEY = "test-api-key";
const PNG_BASE64 = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

interface Response {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("createHttpRequestHandler", () => {
  let server: Server | null = null;
  let uploadStore: UploadStore | null = null;
  let galleryStore: GalleryStore;
  let tempDirs: string[] = [];

  beforeEach(async () => {
    fetchAllUsageMock.mockReset().mockResolvedValue([]);
    runDoctorMock.mockReset().mockResolvedValue({ checks: [] });
    await rm(TEST_HOME, { recursive: true, force: true });
    await mkdir(TEST_HOME, { recursive: true });
    galleryStore = new GalleryStore();
    await galleryStore.init();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
    await uploadStore?.dispose();
    uploadStore = null;
    await rm(TEST_HOME, { recursive: true, force: true });
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  async function start(
    options: { apiKey?: string; allowedDirs?: string[] } = {},
  ): Promise<number> {
    uploadStore = new UploadStore();
    server = createServer(
      createHttpRequestHandler({
        apiKey: options.apiKey,
        allowedDirs: options.allowedDirs ?? [TEST_HOME],
        startedAt: Date.now(),
        imageStore: new ImageStore(),
        mediaStore: new MediaStore(),
        uploadStore,
        galleryStore,
        getWebSocketServer: () => ({
          sessionCount: 2,
          clientCount: 1,
          broadcastGalleryNewImage: () => {},
        }),
      }),
    );
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return (server!.address() as AddressInfo).port;
  }

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  describe("with an API key", () => {
    const protectedRoutes: Array<[method: string, path: string]> = [
      ["GET", "/version"],
      ["GET", "/usage"],
      ["GET", "/doctor"],
      ["GET", `/images/${"a".repeat(64)}`],
      ["GET", `/api/media/${"b".repeat(48)}`],
      ["HEAD", `/api/media/${"b".repeat(48)}`],
      ["PUT", `/api/uploads/${"c".repeat(48)}`],
      ["GET", "/api/gallery"],
      ["GET", "/api/gallery/some-id"],
      ["DELETE", "/api/gallery/some-id"],
      ["POST", "/api/gallery/upload"],
      ["GET", "/unknown"],
    ];

    it.each(protectedRoutes)("rejects %s %s without a token", async (method, path) => {
      const port = await start({ apiKey: API_KEY });
      const response = await send(port, path, { method });

      expect(response.status).toBe(401);
      expect(response.headers["www-authenticate"]).toBe('Bearer realm="ccpocket"');
      if (method !== "HEAD") {
        expect(response.headers["content-type"]).toBe("application/json");
        expect(JSON.parse(response.body)).toEqual({ error: "Unauthorized" });
      }
    });

    it("does not run usage or doctor checks for unauthenticated requests", async () => {
      const port = await start({ apiKey: API_KEY });
      await send(port, "/usage");
      await send(port, "/doctor?token=wrong");

      expect(fetchAllUsageMock).not.toHaveBeenCalled();
      expect(runDoctorMock).not.toHaveBeenCalled();
    });

    it("rejects a wrong token and a wrong Bearer header", async () => {
      const port = await start({ apiKey: API_KEY });

      expect((await send(port, "/version?token=wrong")).status).toBe(401);
      expect(
        (await send(port, "/version", { headers: { Authorization: "Bearer wrong" } })).status,
      ).toBe(401);
    });

    it("accepts the key as a token query parameter", async () => {
      const port = await start({ apiKey: API_KEY });
      const response = await send(port, `/version?token=${API_KEY}`);

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toHaveProperty("version");
    });

    it("accepts the key as a Bearer authorization header", async () => {
      const port = await start({ apiKey: API_KEY });
      const response = await send(port, "/usage", {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ providers: [] });
      expect(fetchAllUsageMock).toHaveBeenCalledOnce();
    });

    it("routes authorized requests with a token query to the stores", async () => {
      const meta = await galleryStore.addImageFromBase64(PNG_BASE64, "image/png", "/project");
      const port = await start({ apiKey: API_KEY });
      const token = `token=${API_KEY}`;

      const list = await send(port, `/api/gallery?project=%2Fproject&${token}`);
      expect(list.status).toBe(200);
      expect(JSON.parse(list.body).images).toHaveLength(1);

      const image = await send(port, `/api/gallery/${meta!.id}?${token}`);
      expect(image.status).toBe(200);
      expect(image.headers["content-type"]).toBe("image/png");

      expect((await send(port, `/images/${"a".repeat(64)}?${token}`)).status).toBe(404);
      expect((await send(port, `/api/media/${"b".repeat(48)}?${token}`)).status).toBe(404);
      expect(
        (await send(port, `/api/uploads/${"c".repeat(48)}?${token}`, { method: "PUT" })).status,
      ).toBe(404);

      const deleted = await send(port, `/api/gallery/${meta!.id}?${token}`, { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect(JSON.parse(deleted.body)).toEqual({ deleted: true });
    });

    it("keeps GET /health open with a minimal body", async () => {
      const port = await start({ apiKey: API_KEY });
      const response = await send(port, "/health");

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ status: "ok" });
    });

    it("returns health details to authorized requests", async () => {
      const port = await start({ apiKey: API_KEY });
      const response = await send(port, `/health?token=${API_KEY}`);

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        status: "ok",
        sessions: 2,
        clients: 1,
      });
    });

    it("answers CORS preflight without a token and allows the Authorization header", async () => {
      const port = await start({ apiKey: API_KEY });
      const response = await send(port, "/api/gallery", { method: "OPTIONS" });

      expect(response.status).toBe(204);
      expect(response.headers["access-control-allow-headers"]).toContain("Authorization");
    });
  });

  describe("without an API key", () => {
    it("serves every route without a token", async () => {
      const port = await start();

      expect((await send(port, "/version")).status).toBe(200);
      expect((await send(port, "/api/gallery")).status).toBe(200);
      expect((await send(port, "/usage")).status).toBe(200);
      expect((await send(port, "/unknown")).status).toBe(404);
    });

    it("keeps the full /health body", async () => {
      const port = await start();
      const response = await send(port, "/health");

      expect(JSON.parse(response.body)).toEqual({
        status: "ok",
        uptime: expect.any(Number),
        sessions: 2,
        clients: 1,
      });
    });
  });

  describe("malformed requests", () => {
    it("rejects a request target that is not a URL and keeps serving", async () => {
      const port = await start();
      const response = await send(port, "//[");

      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "Bad Request" });
      expect((await send(port, "/health")).status).toBe(200);
    });

    it("rejects a malformed target before authentication", async () => {
      const port = await start({ apiKey: API_KEY });

      expect((await send(port, `//x:abc?token=${API_KEY}`)).status).toBe(400);
    });

    it("ignores a malformed Host header", async () => {
      const port = await start();
      const response = await send(port, "/api/gallery?project=%2Fproject", {
        headers: { Host: "a b" },
      });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ images: [] });
    });
  });

  it("restricts gallery file uploads to the allowed directories", async () => {
    const allowed = await tempDir("ccpocket-http-allowed-");
    const outside = await tempDir("ccpocket-http-outside-");
    await writeFile(join(outside, "secret.png"), Buffer.from(PNG_BASE64, "base64"));
    const port = await start({ allowedDirs: [allowed] });

    const response = await send(port, "/api/gallery/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: join(outside, "secret.png"), projectPath: allowed }),
    });

    expect(response.status).toBe(403);
    expect(galleryStore.list()).toEqual([]);
  });
});
