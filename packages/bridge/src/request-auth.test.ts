import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  apiKeyMatches,
  isAuthorizedRequest,
  parseRequestUrl,
} from "./request-auth.js";

function request(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("parseRequestUrl", () => {
  it("parses the path and query of a request target", () => {
    const url = parseRequestUrl("/version?token=abc");
    expect(url?.pathname).toBe("/version");
    expect(url?.searchParams.get("token")).toBe("abc");
  });

  it("returns null for a target that is not a URL", () => {
    expect(parseRequestUrl("//[")).toBeNull();
    expect(parseRequestUrl("//x:abc")).toBeNull();
  });

  it("treats a missing target as the root path", () => {
    expect(parseRequestUrl(undefined)?.pathname).toBe("/");
  });
});

describe("apiKeyMatches", () => {
  it("accepts the exact key", () => {
    expect(apiKeyMatches("secret", "secret")).toBe(true);
  });

  it("rejects a different key, a prefix and a missing value", () => {
    expect(apiKeyMatches("wrong!", "secret")).toBe(false);
    expect(apiKeyMatches("secre", "secret")).toBe(false);
    expect(apiKeyMatches("", "secret")).toBe(false);
    expect(apiKeyMatches(null, "secret")).toBe(false);
    expect(apiKeyMatches(undefined, "secret")).toBe(false);
  });
});

describe("isAuthorizedRequest", () => {
  it("allows every request when no API key is configured", () => {
    expect(isAuthorizedRequest(request(), parseRequestUrl("/version"), undefined)).toBe(true);
    expect(isAuthorizedRequest(request(), null, "")).toBe(true);
  });

  it("accepts the key as a token query parameter", () => {
    expect(
      isAuthorizedRequest(request(), parseRequestUrl("/version?token=secret"), "secret"),
    ).toBe(true);
  });

  it("accepts the key as a Bearer authorization header", () => {
    const url = parseRequestUrl("/version");
    expect(
      isAuthorizedRequest(request({ authorization: "Bearer secret" }), url, "secret"),
    ).toBe(true);
    expect(
      isAuthorizedRequest(request({ authorization: "bearer secret" }), url, "secret"),
    ).toBe(true);
  });

  it("rejects missing, wrong and non-Bearer credentials", () => {
    const url = parseRequestUrl("/version?token=wrong");
    expect(isAuthorizedRequest(request(), parseRequestUrl("/version"), "secret")).toBe(false);
    expect(isAuthorizedRequest(request(), url, "secret")).toBe(false);
    expect(
      isAuthorizedRequest(request({ authorization: "Basic secret" }), url, "secret"),
    ).toBe(false);
    expect(
      isAuthorizedRequest(request({ authorization: "Bearer wrong" }), url, "secret"),
    ).toBe(false);
  });

  it("rejects a request whose target could not be parsed", () => {
    expect(isAuthorizedRequest(request(), null, "secret")).toBe(false);
  });
});
