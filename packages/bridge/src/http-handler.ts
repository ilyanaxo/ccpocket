import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { ImageStore } from "./image-store.js";
import type { MediaStore } from "./media-store.js";
import type { UploadStore } from "./upload-store.js";
import type { GalleryImageInfo, GalleryStore } from "./gallery-store.js";
import { getVersionInfo } from "./version.js";
import { fetchAllUsage } from "./usage.js";
import { runDoctor } from "./doctor.js";
import { isAuthorizedRequest, parseRequestUrl } from "./request-auth.js";

/** The parts of the WebSocket server the HTTP routes read. */
export interface HttpWebSocketState {
  readonly sessionCount: number;
  readonly clientCount: number;
  broadcastGalleryNewImage(image: GalleryImageInfo): void;
}

export interface HttpRequestHandlerOptions {
  apiKey?: string;
  allowedDirs: readonly string[];
  startedAt: number;
  imageStore: ImageStore;
  mediaStore: MediaStore;
  uploadStore: UploadStore;
  galleryStore: GalleryStore;
  /** The WebSocket server attaches to the HTTP server after it is created. */
  getWebSocketServer: () => HttpWebSocketState | null;
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Build the Bridge HTTP request listener. When an API key is configured,
 * every route except OPTIONS preflight and GET /health requires it as
 * `?token=<key>` or `Authorization: Bearer <key>`.
 */
export function createHttpRequestHandler(
  options: HttpRequestHandlerOptions,
): RequestListener {
  const {
    apiKey,
    allowedDirs,
    startedAt,
    imageStore,
    mediaStore,
    uploadStore,
    galleryStore,
    getWebSocketServer,
  } = options;

  return (req: IncomingMessage, res: ServerResponse) => {
    const defaultBodyDeadline = setTimeout(
      () => req.destroy(),
      5 * 60 * 1000,
    );
    defaultBodyDeadline.unref();
    const clearDefaultBodyDeadline = () => {
      clearTimeout(defaultBodyDeadline);
    };
    req.once("end", clearDefaultBodyDeadline);
    req.once("close", clearDefaultBodyDeadline);

    // CORS headers for Flutter Web clients
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, HEAD, POST, PUT, DELETE, OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Content-Length, Range",
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Accept-Ranges, Content-Length, Content-Range, X-File-SHA256, X-Received-Bytes",
    );

    // Every route below parses req.url; reject targets that are not URLs.
    const url = parseRequestUrl(req.url);
    if (!url) {
      sendJson(res, 400, { error: "Bad Request" });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const authorized = isAuthorizedRequest(req, url, apiKey);

    // Health check endpoint. It stays open for the app's reachability probe,
    // which never sends credentials, but reveals details only when authorized.
    if (url.pathname === "/health" && req.method === "GET") {
      const wsServer = getWebSocketServer();
      sendJson(
        res,
        200,
        authorized
          ? {
              status: "ok",
              uptime: Math.floor((Date.now() - startedAt) / 1000),
              sessions: wsServer?.sessionCount ?? 0,
              clients: wsServer?.clientCount ?? 0,
            }
          : { status: "ok" },
      );
      return;
    }

    if (!authorized) {
      sendJson(res, 401, { error: "Unauthorized" }, {
        "WWW-Authenticate": 'Bearer realm="ccpocket"',
      });
      return;
    }

    // Version info endpoint
    if (url.pathname === "/version" && req.method === "GET") {
      sendJson(res, 200, getVersionInfo(startedAt));
      return;
    }

    // Usage endpoint
    if (url.pathname === "/usage" && req.method === "GET") {
      fetchAllUsage()
        .then((providers) => {
          sendJson(res, 200, { providers });
        })
        .catch((err) => {
          sendJson(res, 500, { error: String(err) });
        });
      return;
    }

    // Doctor endpoint
    if (url.pathname === "/doctor" && req.method === "GET") {
      runDoctor()
        .then((report) => {
          sendJson(res, 200, report);
        })
        .catch((err) => {
          sendJson(res, 500, { error: String(err) });
        });
      return;
    }

    // Serve images via ImageStore (in-memory, session-scoped)
    if (imageStore.handleRequest(req, res)) return;

    // Stream local media registered by an authenticated read_file request.
    if (mediaStore.handleRequest(req, res)) return;

    // Receive files through short-lived capabilities prepared over WebSocket.
    if (uploadStore.handleRequest(req, res, clearDefaultBodyDeadline)) return;

    // Serve gallery images via GalleryStore (disk-persistent)
    if (galleryStore.handleRequest(req, res)) return;

    // Upload images via POST /api/gallery/upload
    if (galleryStore.handleUploadRequest(req, res, {
      allowedDirs,
      onNewImage: (meta) => {
        getWebSocketServer()?.broadcastGalleryNewImage(
          galleryStore.metaToInfo(meta),
        );
      },
    })) return;

    // Default 404 for unknown HTTP requests
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  };
}
