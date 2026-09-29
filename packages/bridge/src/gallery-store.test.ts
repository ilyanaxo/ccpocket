import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/ccpocket-gallery-test-home-${process.pid}`,
}));

vi.mock("node:os", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:os")>();
  return {
    ...mod,
    homedir: () => TEST_HOME,
  };
});

import { GALLERY_UPLOAD_MAX_BODY_BYTES, GalleryStore } from "./gallery-store.js";

describe("GalleryStore.addImage", () => {
  beforeEach(async () => {
    await rm(TEST_HOME, { recursive: true, force: true });
    await mkdir(TEST_HOME, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_HOME, { recursive: true, force: true });
  });

  it("resolves leading-slash project-relative paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccpocket-gallery-project-"));
    try {
      const imageDir = join(root, "images");
      const imagePath = join(imageDir, "screenshots.png");
      await mkdir(imageDir, { recursive: true });
      await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));

      const store = new GalleryStore();
      await store.init();

      const meta = await store.addImage("/images/screenshots.png", root, "session-1");
      expect(meta).not.toBeNull();
      expect(meta?.sourcePath).toBe(imagePath);
      expect(meta?.mimeType).toBe("image/png");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex");

describe("GalleryStore.handleUploadRequest", () => {
  let server: Server | null = null;
  let store: GalleryStore;
  let roots: string[] = [];

  beforeEach(async () => {
    await rm(TEST_HOME, { recursive: true, force: true });
    await mkdir(TEST_HOME, { recursive: true });
    store = new GalleryStore();
    await store.init();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
    await rm(TEST_HOME, { recursive: true, force: true });
    for (const root of roots) await rm(root, { recursive: true, force: true });
    roots = [];
  });

  async function start(allowedDirs: string[]): Promise<number> {
    server = createServer((req, res) => {
      if (!store.handleUploadRequest(req, res, { allowedDirs })) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return (server!.address() as AddressInfo).port;
  }

  async function makeRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  function upload(
    port: number,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/gallery/upload",
          headers: { "Content-Type": "application/json" },
          agent: false,
        },
        (res) => {
          let text = "";
          res.on("data", (chunk: Buffer) => (text += chunk.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  }

  /** Send the given body bytes without ending the request; resolve with the status. */
  function statusBeforeBodyEnds(
    port: number,
    headers: Record<string, string | number>,
    bodyBytes: number,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/gallery/upload",
          headers,
          agent: false,
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        },
      );
      req.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
      });
      req.flushHeaders();
      if (bodyBytes > 0) req.write(Buffer.alloc(bodyBytes, 0x20));
    });
  }

  it("copies a file inside the allowed directories", async () => {
    const allowed = await makeRoot("ccpocket-gallery-allowed-");
    await writeFile(join(allowed, "shot.png"), PNG_BYTES);
    const port = await start([allowed]);

    const response = await upload(port, { filePath: "shot.png", projectPath: allowed });

    expect(response.status).toBe(201);
    expect(store.list()).toHaveLength(1);
  });

  it("rejects a file outside the allowed directories", async () => {
    const allowed = await makeRoot("ccpocket-gallery-allowed-");
    const outside = await makeRoot("ccpocket-gallery-outside-");
    await writeFile(join(outside, "secret.png"), PNG_BYTES);
    const port = await start([allowed]);

    const response = await upload(port, {
      filePath: join(outside, "secret.png"),
      projectPath: allowed,
    });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: "filePath is outside the allowed directories",
    });
    expect(store.list()).toEqual([]);
  });

  it("rejects a symlink inside the allowed directories that points outside", async () => {
    const allowed = await makeRoot("ccpocket-gallery-allowed-");
    const outside = await makeRoot("ccpocket-gallery-outside-");
    await writeFile(join(outside, "secret.png"), PNG_BYTES);
    await symlink(join(outside, "secret.png"), join(allowed, "link.png"));
    const port = await start([allowed]);

    const response = await upload(port, { filePath: "link.png", projectPath: allowed });

    expect(response.status).toBe(403);
    expect(store.list()).toEqual([]);
  });

  it("accepts any readable file when the allowed directories are unrestricted", async () => {
    const outside = await makeRoot("ccpocket-gallery-outside-");
    await writeFile(join(outside, "shot.png"), PNG_BYTES);
    const port = await start([]);

    const response = await upload(port, {
      filePath: join(outside, "shot.png"),
      projectPath: "/project",
    });

    expect(response.status).toBe(201);
  });

  it("still accepts base64 uploads within the size limit", async () => {
    const port = await start([]);

    const response = await upload(port, {
      base64: PNG_BYTES.toString("base64"),
      mimeType: "image/png",
      projectPath: "/project",
    });

    expect(response.status).toBe(201);
  });

  it("rejects a declared body larger than the limit before it is sent", async () => {
    const port = await start([]);

    const status = await statusBeforeBodyEnds(
      port,
      { "Content-Type": "application/json", "Content-Length": GALLERY_UPLOAD_MAX_BODY_BYTES + 1 },
      0,
    );

    expect(status).toBe(413);
  });

  it("rejects a streamed body once it exceeds the limit", async () => {
    const port = await start([]);

    const status = await statusBeforeBodyEnds(
      port,
      { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
      GALLERY_UPLOAD_MAX_BODY_BYTES + 1,
    );

    expect(status).toBe(413);
  });
});
