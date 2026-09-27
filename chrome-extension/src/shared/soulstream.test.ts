import { describe, expect, it, vi } from "vitest";

import type { ExtensionConfig } from "./schema.js";
import { extractErrorMessage, sendSessionRequest, sessionHeaders, type FetchLike } from "./soulstream.js";

const config: ExtensionConfig = {
  baseUrl: "https://soulstream.example.com",
  bearerToken: "secret",
  nodeId: "node-a",
  profile: "roselin_codex",
  folderId: "",
  reasoningEffort: "xhigh",
  includeBody: true,
  bodyCharLimit: 12_000,
};

describe("soulstream request helpers", () => {
  it("adds bearer auth only when configured", () => {
    expect(sessionHeaders(config)).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
    });
    expect(sessionHeaders({ ...config, bearerToken: "" })).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("posts to the existing session endpoint with cookies included", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ agentSessionId: "sess-1", nodeId: "node-a" }),
      text: async () => "",
    })) as unknown as FetchLike;

    const result = await sendSessionRequest(config, "prompt", fetchImpl);

    expect(result).toEqual({ agentSessionId: "sess-1", nodeId: "node-a" });
    expect(fetchImpl).toHaveBeenCalledWith("https://soulstream.example.com/api/sessions", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
      },
      body: JSON.stringify({
        prompt: "prompt",
        nodeId: "node-a",
        profile: "roselin_codex",
        reasoningEffort: "xhigh",
      }),
    });
  });

  it("extracts nested FastAPI error messages", () => {
    expect(extractErrorMessage(401, {
      detail: { error: { message: "인증이 필요합니다" } },
    }, "")).toBe("인증이 필요합니다");
  });

  it("reports a non-JSON gateway error body after one body read", async () => {
    const response = new Response("upstream gateway unavailable", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });
    const fetchImpl = vi.fn(async () => response) as unknown as FetchLike;

    await expect(sendSessionRequest(config, "prompt", fetchImpl)).rejects.toThrow(
      "upstream gateway unavailable",
    );
  });
});
