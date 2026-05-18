import { describe, expect, it } from "vitest";

import { wsToHttpBase } from "../../src/mcp/orch_proxy.js";

describe("wsToHttpBase", () => {
  it("ws:// → http://", () => {
    expect(wsToHttpBase("ws://localhost:5200/ws/node")).toBe(
      "http://localhost:5200",
    );
  });

  it("wss:// → https://", () => {
    expect(wsToHttpBase("wss://example.com:443/ws/node")).toBe(
      "https://example.com:443",
    );
  });

  it("path가 없어도 host:port 그대로 보존", () => {
    expect(wsToHttpBase("ws://127.0.0.1:5200")).toBe("http://127.0.0.1:5200");
  });

  it("http:// 스킴은 거부 throw", () => {
    expect(() => wsToHttpBase("http://example.com")).toThrow(/ws:\/\//);
  });
});
