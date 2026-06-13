import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buttonVariants } from "./button";

const visualButtonFiles = [
  "../FeedTopBar.tsx",
  "../SessionsTopBar.tsx",
  "../ConfigButton.tsx",
  "../ChatInput.tsx",
  "../AskQuestionBanner.tsx",
  "../chat/ChatInputEditor.tsx",
  "../chat/ChatInputRequest.tsx",
  "../chat/ChatToolApproval.tsx",
] as const;

const localButtonColorPatterns = [
  /from-\[#2E96FF\]/,
  /to-\[#0A84FF\]/,
  /chat-tone-success-button/,
  /chat-tone-warning-button/,
  /chat-tone-danger-outline/,
  /chat-tone-danger-hover/,
] as const;

function readComponentSource(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf-8");
}

describe("button style contract", () => {
  it("exposes the unified variants used by dashboard action buttons", () => {
    expect(buttonVariants({ variant: "default" })).toContain("from-accent-blue/90");
    expect(buttonVariants({ variant: "success" })).toContain("var(--success)");
    expect(buttonVariants({ variant: "warning" })).toContain("var(--color-accent-orange)");
    expect(buttonVariants({ variant: "choice" })).toContain("data-[selected=true]");
    expect(buttonVariants({ variant: "glass" })).toContain("glass-shadow-xs");
  });

  it.each(visualButtonFiles)("%s does not carry local color variants", (relativePath) => {
    const source = readComponentSource(relativePath);

    expect(source).toContain("<Button");
    for (const pattern of localButtonColorPatterns) {
      expect(source).not.toMatch(pattern);
    }
  });
});
