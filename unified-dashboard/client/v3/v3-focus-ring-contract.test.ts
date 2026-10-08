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
    const workspace = css("./v3-folder-workspace.css");
    const runRowFrame = source("./RunRowFrame.tsx");

    expect([planner, context, workspace].join("\n")).not.toMatch(/outline:\s*2px/);
    const sharedFocusRule = planner.match(/(:where\([\s\S]*?\):focus-visible)\s*{([^}]*)}/);
    expect(sharedFocusRule?.[1]).toMatch(/\.v3-shell button/);
    expect(sharedFocusRule?.[1]).toMatch(/\.v3-shell input/);
    expect(sharedFocusRule?.[1]).toMatch(/\.v3-shell select/);
    expect(sharedFocusRule?.[1]).toMatch(/\.v3-shell textarea/);
    expect(sharedFocusRule?.[2]).toMatch(/outline:\s*none/);
    expect(sharedFocusRule?.[2]).toMatch(/box-shadow:/);
    expect(runRowFrame).toMatch(
      /hasActions\s*\?\s*<div className="v3-run-open[^"]*focus-visible:ring-2[^"]*" role="button"\s+tabIndex=\{disabled\?-1:0\}/,
    );
    expect(runRowFrame).toMatch(
      /:\s*<button type="button" className="v3-run-open"[^>]*disabled=\{disabled\}/,
    );
    expect(context).toMatch(/\.v3-context-panel input:focus-visible[^}]*box-shadow:/s);
    expect(context).toMatch(/\.v3-succession-body li select:focus-visible[^}]*box-shadow:/s);
    expect(runHistory).toMatch(/\.v3-run-open\s*{[^}]*border-radius:\s*inherit/s);
    expect(workspace).toMatch(/\.v3-task-title-input\s*{[^}]*border-radius:\s*9px;[^}]*box-shadow:/s);
  });

  it("puts chat focus on the rounded composer instead of its radius-less textarea", () => {
    const planner = css("./v3-planner.css");
    const chatInput = source("../../../packages/soul-ui/src/components/ChatInput.tsx");
    const composer = source("../../../packages/soul-ui/src/components/chat/ChatInputComposer.tsx");

    expect(chatInput).toMatch(/import \{ ChatInputComposer \} from "\.\/chat\/ChatInputComposer";/);
    expect(chatInput).toMatch(/presentation = "default"/);
    expect(chatInput).toMatch(
      /<ChatInputComposer presentation=\{presentation\}>[\s\S]*?<\/ChatInputComposer>/,
    );
    expect(composer).toMatch(/data-slot="chat-input-composer"/);
    expect(composer).toMatch(
      /manuscript \? "[^"]*border-b[^"]*focus-within:border-ring" : "[^"]*rounded-\[25px\][^"]*ring-ring\/50[^"]*has-focus-visible:ring-\[3px\]/,
    );
    expect(planner).toMatch(/\[data-slot="chat-input-composer"\] textarea:focus-visible\s*{[^}]*box-shadow:\s*none/s);
  });
});
