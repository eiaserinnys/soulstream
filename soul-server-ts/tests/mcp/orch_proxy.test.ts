import { describe, expect, it } from "vitest";

import { buildOrchProxyConfig, wsToHttpBase } from "../../src/mcp/orch_proxy.js";

describe("orch proxy config", () => {
  it("converts upstream websocket URL to HTTP base", () => {
    expect(wsToHttpBase("ws://orch.example.com:3105/ws/node")).toBe(
      "http://orch.example.com:3105",
    );
    expect(wsToHttpBase("wss://orch.example.com/ws/node")).toBe(
      "https://orch.example.com",
    );
  });

  it("preserves host and port when path is absent", () => {
    expect(wsToHttpBase("ws://127.0.0.1:5200")).toBe("http://127.0.0.1:5200");
  });

  it("rejects non-websocket schemes", () => {
    expect(() => wsToHttpBase("http://example.com")).toThrow(/ws:\/\//);
  });

  it("builds relay config from upstream URL without depending on MCP_ENABLED", () => {
    expect(
      buildOrchProxyConfig({
        SOULSTREAM_UPSTREAM_URL: "wss://orch.example.com/ws/node",
        AUTH_BEARER_TOKEN: "secret",
      }),
    ).toEqual({
      baseUrl: "https://orch.example.com",
      headers: { authorization: "Bearer secret" },
    });
  });

  it("omits authorization header when auth token is empty", () => {
    expect(
      buildOrchProxyConfig({
        SOULSTREAM_UPSTREAM_URL: "ws://127.0.0.1:3105/ws/node",
        AUTH_BEARER_TOKEN: "",
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:3105",
      headers: {},
    });
  });
});
