import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function css(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

describe("v3 rounded focus ring contract", () => {
  it("uses radius-following shadows instead of square two-pixel outlines", () => {
    const planner = css("./v3-planner.css");
    const context = css("./v3-context-succession.css");
    const runHistory = css("./v3-run-history.css");
    const workspace = css("./v3-task-workspace.css");

    expect(`${planner}\n${context}\n${workspace}`).not.toMatch(/outline:\s*2px/);
    expect(planner).toMatch(/\.v3-task-card:focus-visible\s*{[^}]*box-shadow:/s);
    expect(context).toMatch(/\.v3-context-panel input:focus-visible[^}]*box-shadow:/s);
    expect(context).toMatch(/\.v3-succession-body li select:focus-visible[^}]*box-shadow:/s);
    expect(runHistory).toMatch(/\.v3-run-open\s*{[^}]*border-radius:\s*inherit/s);
    expect(workspace).toMatch(/\.v3-task-title-input\s*{[^}]*border-radius:\s*9px;[^}]*box-shadow:/s);
  });

  it("puts chat focus on the rounded composer instead of its radius-less textarea", () => {
    const planner = css("./v3-planner.css");
    const chatInput = source("../../../packages/soul-ui/src/components/ChatInput.tsx");

    expect(chatInput).toMatch(/data-slot="chat-input-composer"[\s\S]*has-focus-visible:ring-\[3px\]/);
    expect(planner).toMatch(/\[data-slot="chat-input-composer"\] textarea:focus-visible\s*{[^}]*box-shadow:\s*none/s);
  });
});
