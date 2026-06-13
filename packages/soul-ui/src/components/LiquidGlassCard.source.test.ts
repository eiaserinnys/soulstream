import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource() {
  return readFileSync(new URL("./LiquidGlassCard.tsx", import.meta.url), "utf-8");
}

describe("LiquidGlassCard source contract", () => {
  it("passes static mouse coordinates to avoid per-surface mousemove listeners", () => {
    const source = readSource();

    expect(source).toContain("globalMousePos={STATIC_GLASS_MOUSE_POSITION}");
    expect(source).toContain("mouseOffset={STATIC_GLASS_MOUSE_OFFSET}");
  });
});
