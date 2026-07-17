import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSurfaceFiles = [
  "dialog.tsx",
  "alert-dialog.tsx",
  "sheet.tsx",
  "command.tsx",
] as const;

function readUiSource(fileName: string) {
  return readFileSync(new URL(fileName, import.meta.url), "utf-8");
}

describe("dialog liquid glass surfaces", () => {
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
    expect(source).toContain("min-h-0 flex-auto overflow-y-auto");
    expect(source).toContain('data-slot="dialog-panel-scroll"');
    expect(source).toContain("flex shrink-0 flex-col");
    expect(source).toContain("가상 키보드를 제외한 가시 영역 높이");
  });
});
