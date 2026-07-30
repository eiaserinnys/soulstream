import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf-8");
}

describe("SessionStoryDisclosure stacking contract", () => {
  it("keeps the desktop chat header stacking context above the message list", () => {
    const source = readSource("./chat/ChatView.tsx");

    expect(source).toContain(
      'className="relative z-[1] mb-3 flex h-[50px]',
    );
  });

  it("keeps the mobile chat header stacking context above the message list", () => {
    const source = readSource("./MobileChatHeader.tsx");

    expect(source).toContain(
      'className="relative z-[1] shrink-0 px-3 py-2"',
    );
  });
});
