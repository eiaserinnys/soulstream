import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSurfaceFiles = [
  "dialog.tsx",
  "alert-dialog.tsx",
] as const;

function readUiSource(fileName: string) {
  return readFileSync(new URL(fileName, import.meta.url), "utf-8");
}

describe("dialog liquid glass surfaces", () => {
  it("densifies popup surfaces before the opaque WebGL-off override", () => {
    const css = readFileSync(new URL("../../styles/globals.css", import.meta.url), "utf-8");
    const rule = css.match(/\[data-slot="popover-popup"\][^{]+\{\s*background:\s*color-mix\(in srgb, var\(--lg-card\) 45%, var\(--background\)\);\s*\}/s)?.[0] ?? "";
    expect(rule).toContain('[data-slot="menu-popup"]');
    expect(rule).toContain('[data-slot="select-popup"] > .glass');
    expect(rule).not.toContain('[data-slot="dialog-popup"]');
    expect(rule).not.toContain('[data-slot="alert-dialog-popup"]');
    expect(css.indexOf(rule)).toBeLessThan(css.indexOf('html[data-webgl-glass="off"] [data-slot="dialog-popup"]'));
  });

  it("uses the popup surface color for both select scroll arrows", () => {
    const css = readFileSync(new URL("../../styles/globals.css", import.meta.url), "utf-8");
    const select = readUiSource("select.tsx");
    expect(select.match(/before:from-\[var\(--select-popup-surface\)\]/g)).toHaveLength(2);
    expect(css).toMatch(/\[data-slot="select-popup"\]\s*\{\s*--select-popup-surface:\s*color-mix\(in srgb, var\(--lg-card\) 45%, var\(--background\)\);/);
    expect(css).toMatch(/html\[data-webgl-glass="off"\]\s+\[data-slot="select-popup"\]\s*\{\s*--select-popup-surface:\s*var\(--popover\);/);
  });

  it("uses the opaque popover token on all five popup surfaces when WebGL is off", () => {
    const css = readFileSync(new URL("../../styles/globals.css", import.meta.url), "utf-8");
    const rule = css.match(/html\[data-webgl-glass="off"\][^{]+\{\s*background:\s*var\(--popover\);\s*\}/s)?.[0] ?? "";
    for (const slot of ["dialog-popup", "alert-dialog-popup", "popover-popup", "menu-popup", "select-popup"]) {
      expect(rule).toContain(`[data-slot="${slot}"]`);
    }
    expect(rule).toMatch(/\[data-slot="select-popup"\]\s*>\s*\.glass/);
    const preceding = css.slice(0, css.indexOf(rule))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
    const nestingDepth = [...preceding].reduce((depth, char) => depth + (char === "{" ? 1 : char === "}" ? -1 : 0), 0);
    expect(nestingDepth).toBe(0);
  });
  it.each(dialogSurfaceFiles)("%s uses the shared liquid glass modal surface", (fileName) => {
    const source = readUiSource(fileName);

    expect(source).toContain("LiquidGlassLayer");
    expect(source).toContain("liquidGlassStyle");
    expect(source).toContain("data-liquid-glass-enhanced");
    expect(source).toContain("liquid-glass-card");
  });

  it("centers regular dialogs in one shared viewport contract", () => {
    const source = readUiSource("dialog.tsx");

    expect(source).toContain("place-items-center");
    expect(source).toContain("bottomStickOnMobile = false");
    expect(source).toContain('data-modal-placement={bottomStickOnMobile ? "mobile-bottom-sheet" : "center"}');
    expect(source).not.toContain("grid-rows-[1fr_auto_3fr]");
    expect(source).not.toContain("row-start-2");
  });

  it("bounds every dialog to the dynamic viewport and gives the panel the scroll remainder", () => {
    const source = readUiSource("dialog.tsx");

    expect(source).toContain("max-h-[calc(100dvh-2rem)]");
    expect(source).toContain("overflow-hidden");
    expect(source).toContain("scrollable = true");
    expect(source).toContain("min-h-0 flex-auto overscroll-contain rounded-[inherit] outline-none");
    expect(source).toContain('scrollable ? "overflow-y-auto" : "overflow-hidden"');
    expect(source).toContain('data-slot="dialog-panel-scroll"');
    expect(source).toContain("flex shrink-0 flex-col");
    expect(source).toContain("가상 키보드를 제외한 가시 영역 높이");
  });
});
