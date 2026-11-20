import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource() {
  return readFileSync(new URL("./LiquidGlassCard.tsx", import.meta.url), "utf-8");
}

describe("LiquidGlassCard source contract", () => {
  it("uses a shared filter resource instead of per-surface liquid-glass instances", () => {
    const source = readSource();

    expect(source).toContain("SHARED_GLASS_FILTER_ID");
    expect(source).toContain("liquid-glass-card-shared-filter-standard");
    expect(source).toContain("SHARED_GLASS_FILTER_URL");
    expect(source).not.toContain('from "liquid-glass-react"');
    expect(source).not.toContain("globalMousePos");
    expect(source).not.toContain("mousemove");
  });

  it("inherits the frame radius through the glass layer chain", () => {
    const source = readSource();
    const css = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf-8");

    expect(source).not.toContain("borderRadius: `var(--radius-${cornerRadius})`");
    expect(css).toMatch(/\.liquid-glass-card__effect\s*\{[^}]*border-radius:\s*inherit !important;/s);
    expect(css).toMatch(/\.liquid-glass-card__effect > \.glass\s*\{[^}]*border-radius:\s*inherit !important;/s);
    expect(css).toMatch(/\.liquid-glass-card__layer > span\s*\{\s*border-radius:\s*inherit;/);
    expect(css).not.toContain("border-radius: var(--liquid-glass-radius, inherit)");
  });
});
