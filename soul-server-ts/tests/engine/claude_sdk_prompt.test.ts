import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import {
  makeCacheableSystemPrompt,
  makeCompactSystemReminder,
} from "../../src/engine/claude_sdk_prompt.js";

describe("makeCacheableSystemPrompt", () => {
  it("marks a plain string prompt as the cacheable static prefix", () => {
    expect(makeCacheableSystemPrompt("atom rules")).toEqual([
      "atom rules",
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    ]);
  });

  it("keeps a prompt that already carries the dynamic boundary unchanged", () => {
    const blocks = [
      "atom rules",
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      "folder prompt",
      "task system prompt",
    ];

    expect(makeCacheableSystemPrompt(blocks)).toBe(blocks);
  });
});

describe("makeCompactSystemReminder", () => {
  it("re-injects every block, including the dynamic suffix behind the boundary", () => {
    const reminder = makeCompactSystemReminder([
      "atom rules",
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      "folder prompt",
    ]);

    expect(reminder).toContain("atom rules");
    expect(reminder).toContain("folder prompt");
    expect(reminder).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  });
});
