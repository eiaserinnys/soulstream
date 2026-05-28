import { describe, expect, it } from "vitest";

import {
  buildCreateSessionRequest,
  buildSessionEndpoint,
  mergeConfig,
  normalizeBodyCharLimit,
  truncateText,
} from "./schema.js";

describe("schema helpers", () => {
  it("normalizes config without inventing server defaults", () => {
    expect(mergeConfig({
      baseUrl: " https://soulstream.example.com/ ",
      nodeId: " node-a ",
      profile: " roselin_codex ",
      bodyCharLimit: "999999",
      reasoningEffort: "xhigh",
    })).toMatchObject({
      baseUrl: "https://soulstream.example.com/",
      nodeId: "node-a",
      profile: "roselin_codex",
      bodyCharLimit: 50_000,
      reasoningEffort: "xhigh",
    });
  });

  it("clamps body limits and preserves truncation metadata", () => {
    expect(normalizeBodyCharLimit(-1)).toBe(0);
    expect(normalizeBodyCharLimit(100_000)).toBe(50_000);
    expect(truncateText("abcdef", 3)).toEqual({ text: "abc", truncated: true });
    expect(truncateText("abc", 3)).toEqual({ text: "abc", truncated: false });
  });

  it("builds the existing Soulstream session endpoint", () => {
    expect(buildSessionEndpoint("https://soulstream.example.com///")).toBe(
      "https://soulstream.example.com/api/sessions",
    );
  });

  it("includes only explicitly configured session fields", () => {
    const request = buildCreateSessionRequest({
      baseUrl: "https://soulstream.example.com",
      bearerToken: "",
      nodeId: "node-a",
      profile: "",
      folderId: "folder-a",
      reasoningEffort: "",
      includeBody: true,
      bodyCharLimit: 12_000,
    }, "prompt");

    expect(request).toEqual({
      prompt: "prompt",
      nodeId: "node-a",
      folderId: "folder-a",
    });
  });
});
