import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile, realpath, stat, unlink } from "node:fs/promises";
import { join, extname, basename, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_IMAGE_FILE_SIZE } from "./image-store.js";
import { isCanonicalPathAllowed } from "./path-utils.js";

export interface GalleryImageMeta {
  id: string;
  filename: string;
  mimeType: string;
  projectPath: string;
  sessionId?: string;
  sourcePath: string;
  addedAt: string;
  sizeBytes: number;
}

export interface GalleryImageInfo {
  id: string;
  url: string;
  mimeType: string;
  projectPath: string;
  projectName: string;
  sessionId?: string;
  addedAt: string;
  sizeBytes: number;
}

const GALLERY_DIR = join(homedir(), ".ccpocket", "gallery");
const IMAGES_DIR = join(GALLERY_DIR, "images");
const INDEX_FILE = join(GALLERY_DIR, "index.json");

/**
 * Largest POST /api/gallery/upload body: the base64 form of the largest image
 * the Bridge accepts, plus room for the other JSON fields.
 */
export const GALLERY_UPLOAD_MAX_BODY_BYTES =
  Math.ceil(MAX_IMAGE_FILE_SIZE / 3) * 4 + 64 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function projectNameFromPath(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : projectPath;
}

export class GalleryStore {
  private index: GalleryImageMeta[] = [];

  private async resolveReadablePath(filePath: string, projectPath: string): Promise<string | null> {
    const candidates: string[] = [];
    if (isAbsolute(filePath)) {
      candidates.push(filePath);
      candidates.push(resolve(projectPath, filePath.replace(/^\/+/, "")));
    } else {
      candidates.push(resolve(projectPath, filePath));
      candidates.push(filePath);
    }

    for (const candidate of candidates) {
      try {
        const st = await stat(candidate);
        if (st.isFile()) return candidate;
      } catch {
        // Try next candidate.
      }
    }
    return null;
  }

  async init(): Promise<void> {
    await mkdir(IMAGES_DIR, { recursive: true });
    try {
      const data = await readFile(INDEX_FILE, "utf-8");
      this.index = JSON.parse(data) as GalleryImageMeta[];
    } catch {
      // File doesn't exist or is corrupt — start fresh
      this.index = [];
    }
  }

  private async saveIndex(): Promise<void> {
    await writeFile(INDEX_FILE, JSON.stringify(this.index, null, 2), "utf-8");
  }

  async addImage(
    filePath: string,
    projectPath: string,
    sessionId?: string,
  ): Promise<GalleryImageMeta | null> {
    try {
      const resolvedPath = await this.resolveReadablePath(filePath, projectPath);
      if (!resolvedPath) return null;
      return await this.copyImage(resolvedPath, projectPath, sessionId);
    } catch (err) {
      console.warn(`[gallery] Failed to add image ${filePath}:`, err);
      return null;
    }
  }

  private async copyImage(
    resolvedPath: string,
    projectPath: string,
    sessionId?: string,
  ): Promise<GalleryImageMeta | null> {
    const st = await stat(resolvedPath);

    const ext = extname(resolvedPath).toLowerCase();
    const mimeType = MIME_TYPES[ext];
    if (!mimeType) return null;

    const id = randomUUID();
    const filename = `${id}${ext}`;
    const destPath = join(IMAGES_DIR, filename);

    await copyFile(resolvedPath, destPath);

    const meta: GalleryImageMeta = {
      id,
      filename,
      mimeType,
      projectPath,
      sessionId,
      sourcePath: resolvedPath,
      addedAt: new Date().toISOString(),
      sizeBytes: st.size,
    };

    this.index.push(meta);
    await this.saveIndex();

    console.log(`[gallery] Added image ${id} from ${basename(resolvedPath)}`);
    return meta;
  }

  /**
   * Add a client-named file for POST /api/gallery/upload. The file is copied
   * from its canonical path only when that path lies inside allowedDirs.
   */
  private async addAllowedImage(
    filePath: string,
    projectPath: string,
    allowedDirs: readonly string[],
    sessionId?: string,
  ): Promise<GalleryImageMeta | "not_allowed" | null> {
    try {
      const resolvedPath = await this.resolveReadablePath(filePath, projectPath);
      if (!resolvedPath) return null;
      const canonicalPath = await realpath(resolvedPath);
      if (!(await isCanonicalPathAllowed(canonicalPath, allowedDirs))) {
        return "not_allowed";
      }
      return await this.copyImage(canonicalPath, projectPath, sessionId);
    } catch (err) {
      console.warn(`[gallery] Failed to add image ${filePath}:`, err);
      return null;
    }
  }

  /**
   * Add an image from base64-encoded data.
   * This allows mobile clients to upload images directly without file paths.
   */
  async addImageFromBase64(
    base64Data: string,
    mimeType: string,
    projectPath: string,
    sessionId?: string,
  ): Promise<GalleryImageMeta | null> {
    try {
      // Validate mime type and get extension
      const ext = Object.entries(MIME_TYPES).find(([, mime]) => mime === mimeType)?.[0];
      if (!ext) {
        console.warn(`[gallery] Unsupported mime type: ${mimeType}`);
        return null;
      }

      const id = randomUUID();
      const filename = `${id}${ext}`;
      const destPath = join(IMAGES_DIR, filename);

      // Decode base64 and write to file
      const buffer = Buffer.from(base64Data, "base64");
      await writeFile(destPath, buffer);

      const meta: GalleryImageMeta = {
        id,
        filename,
        mimeType,
        projectPath,
        sessionId,
        sourcePath: "base64_upload",
        addedAt: new Date().toISOString(),
        sizeBytes: buffer.length,
      };

      this.index.push(meta);
      await this.saveIndex();

      console.log(`[gallery] Added image ${id} from base64 (${Math.round(buffer.length / 1024)}KB)`);
      return meta;
    } catch (err) {
      console.warn(`[gallery] Failed to add image from base64:`, err);
      return null;
    }
  }

  list(options?: { projectPath?: string; sessionId?: string }): GalleryImageInfo[] {
    let items = this.index;
    if (options?.projectPath) {
      items = items.filter((m) => m.projectPath === options.projectPath);
    }
    if (options?.sessionId) {
      items = items.filter((m) => m.sessionId === options.sessionId);
    }
    // Return newest first
    return [...items]
      .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime())
      .map((m) => ({
        id: m.id,
        url: `/api/gallery/${m.id}`,
        mimeType: m.mimeType,
        projectPath: m.projectPath,
        projectName: projectNameFromPath(m.projectPath),
        sessionId: m.sessionId,
        addedAt: m.addedAt,
        sizeBytes: m.sizeBytes,
      }));
  }

  getImagePath(id: string): string | null {
    const meta = this.index.find((m) => m.id === id);
    if (!meta) return null;
    return join(IMAGES_DIR, meta.filename);
  }

  /**
   * Get image as Base64 for SDK message embedding.
   * Returns null if image not found.
   */
  async getImageAsBase64(id: string): Promise<{ base64: string; mimeType: string } | null> {
    const meta = this.index.find((m) => m.id === id);
    if (!meta) return null;

    const filePath = join(IMAGES_DIR, meta.filename);
    try {
      const buffer = await readFile(filePath);
      return {
        base64: buffer.toString("base64"),
        mimeType: meta.mimeType,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get mime type for an image by ID.
   */
  getMimeType(id: string): string | null {
    const meta = this.index.find((m) => m.id === id);
    return meta?.mimeType ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const idx = this.index.findIndex((m) => m.id === id);
    if (idx === -1) return false;

    const meta = this.index[idx];
    const filePath = join(IMAGES_DIR, meta.filename);

    try {
      await unlink(filePath);
    } catch {
      // File may already be deleted
    }

    this.index.splice(idx, 1);
    await this.saveIndex();
    console.log(`[gallery] Deleted image ${id}`);
    return true;
  }

  /**
   * Handle HTTP requests for gallery image serving.
   * Returns true if the request was handled.
   */
  handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "", "http://localhost");

    // Match /api/gallery/:id (alphanumeric, hyphens, underscores)
    const imageMatch = url.pathname.match(/^\/api\/gallery\/([a-zA-Z0-9_-]+)$/);

    // GET /api/gallery/:id — serve image file
    if (imageMatch && req.method === "GET") {
      const id = imageMatch[1];
      return this.serveImage(id, res);
    }

    // DELETE /api/gallery/:id
    if (imageMatch && req.method === "DELETE") {
      const id = imageMatch[1];
      this.delete(id).then((ok) => {
        if (ok) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ deleted: true }));
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
        }
      }).catch(() => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      });
      return true;
    }

    // GET /api/gallery — list images (exact path or with query string)
    if (url.pathname === "/api/gallery" && req.method === "GET") {
      const project = url.searchParams.get("project") ?? undefined;
      const images = this.list({ projectPath: project });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ images }));
      return true;
    }

    return false;
  }

  private serveImage(id: string, res: ServerResponse): boolean {
    const meta = this.index.find((m) => m.id === id);
    if (!meta) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return true;
    }

    const filePath = join(IMAGES_DIR, meta.filename);
    readFile(filePath)
      .then((buffer) => {
        res.writeHead(200, {
          "Content-Type": meta.mimeType,
          "Content-Length": buffer.length,
          "Cache-Control": "public, max-age=3600",
        });
        res.end(buffer);
      })
      .catch(() => {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      });

    return true;
  }

  /**
   * Handle POST /api/gallery/upload.
   * Accepts JSON body with EITHER:
   *   - { filePath: string, projectPath: string, sessionId?: string } (file path mode;
   *     the file must lie inside allowedDirs, an empty list allows any path)
   *   - { base64: string, mimeType: string, projectPath: string, sessionId?: string } (base64 mode)
   * Bodies larger than GALLERY_UPLOAD_MAX_BODY_BYTES are rejected with 413.
   * Returns true if the request was handled.
   */
  handleUploadRequest(
    req: IncomingMessage,
    res: ServerResponse,
    options: {
      allowedDirs: readonly string[];
      onNewImage?: (meta: GalleryImageMeta) => void;
    },
  ): boolean {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== "/api/gallery/upload" || req.method !== "POST") return false;

    let tooLarge = false;
    const rejectTooLarge = () => {
      tooLarge = true;
      // Close the connection instead of reading the rest of the body.
      res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ error: "Request body too large" }));
    };
    if (Number(req.headers["content-length"]) > GALLERY_UPLOAD_MAX_BODY_BYTES) {
      rejectTooLarge();
      return true;
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      receivedBytes += chunk.length;
      if (receivedBytes > GALLERY_UPLOAD_MAX_BODY_BYTES) {
        chunks.length = 0;
        rejectTooLarge();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      if (tooLarge) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          filePath?: string;
          base64?: string;
          mimeType?: string;
          projectPath?: string;
          sessionId?: string;
        };

        if (!parsed.projectPath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "projectPath is required" }));
          return;
        }

        let meta: GalleryImageMeta | null = null;

        // Base64 mode: save from base64 data
        if (parsed.base64 && parsed.mimeType) {
          meta = await this.addImageFromBase64(
            parsed.base64,
            parsed.mimeType,
            parsed.projectPath,
            parsed.sessionId,
          );
        }
        // File path mode: copy from file path
        else if (parsed.filePath) {
          const added = await this.addAllowedImage(
            parsed.filePath,
            parsed.projectPath,
            options.allowedDirs,
            parsed.sessionId,
          );
          if (added === "not_allowed") {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePath is outside the allowed directories" }));
            return;
          }
          meta = added;
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Either filePath or (base64 + mimeType) is required" }));
          return;
        }

        if (!meta) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to add image (unsupported format or invalid data)" }));
          return;
        }
        const info = this.metaToInfo(meta);
        if (options.onNewImage) options.onNewImage(meta);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ image: info }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
      }
    });
    return true;
  }

  /** Convert GalleryImageMeta to GalleryImageInfo for WS broadcast. */
  metaToInfo(meta: GalleryImageMeta): GalleryImageInfo {
    return {
      id: meta.id,
      url: `/api/gallery/${meta.id}`,
      mimeType: meta.mimeType,
      projectPath: meta.projectPath,
      projectName: projectNameFromPath(meta.projectPath),
      sessionId: meta.sessionId,
      addedAt: meta.addedAt,
      sizeBytes: meta.sizeBytes,
    };
  }
}
