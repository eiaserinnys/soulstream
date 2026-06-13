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
});
