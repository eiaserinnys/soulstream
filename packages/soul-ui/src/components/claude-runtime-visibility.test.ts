import { describe, expect, it } from "vitest";

import { shouldShowClaudeRuntimePanels } from "./claude-runtime-visibility";

describe("shouldShowClaudeRuntimePanels", () => {
  it("shows Claude runtime panels only for Claude backend sessions", () => {
    expect(shouldShowClaudeRuntimePanels("claude")).toBe(true);
    expect(shouldShowClaudeRuntimePanels("codex")).toBe(false);
    expect(shouldShowClaudeRuntimePanels("openai-agents")).toBe(false);
    expect(shouldShowClaudeRuntimePanels(null)).toBe(false);
    expect(shouldShowClaudeRuntimePanels(undefined)).toBe(false);
  });
});
