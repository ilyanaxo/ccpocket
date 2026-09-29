import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Parse a request target against a fixed origin. The Host header is never
 * used, so a malformed or hostile Host cannot make parsing throw. Returns null
 * for request targets that are not valid URLs (for example `//[`).
 */
export function parseRequestUrl(target: string | undefined): URL | null {
  try {
    return new URL(target ?? "/", "http://localhost");
  } catch {
    return null;
  }
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Compare a presented credential with the API key in constant time. Both
 * values are hashed first so neither the content nor the length of the key
 * influences the comparison time.
 */
export function apiKeyMatches(
  candidate: string | null | undefined,
  apiKey: string,
): boolean {
  if (typeof candidate !== "string") return false;
  return timingSafeEqual(sha256(candidate), sha256(apiKey));
}

function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer +(\S.*)$/i.exec(header ?? "");
  return match ? match[1] : null;
}

/**
 * Whether a request presents the API key as `?token=<key>` or as
 * `Authorization: Bearer <key>`. Always true when no API key is configured.
 */
export function isAuthorizedRequest(
  req: IncomingMessage,
  url: URL | null,
  apiKey: string | null | undefined,
): boolean {
  if (!apiKey) return true;
  return (
    apiKeyMatches(url?.searchParams.get("token"), apiKey) ||
    apiKeyMatches(bearerToken(req.headers.authorization), apiKey)
  );
}
