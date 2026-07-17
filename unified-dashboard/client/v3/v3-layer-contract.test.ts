import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("v3 layer contract", () => {
  it("owns one ordered panel < overlay < modal < toast scale", () => {
    const css = read("./v3-layer-contract.css");
    const value = (name: string) => Number(new RegExp(`${name}:\\s*(\\d+)`).exec(css)?.[1]);

    expect(value("--v3-layer-panel")).toBeLessThan(value("--v3-layer-overlay"));
    expect(value("--v3-layer-overlay")).toBeLessThan(value("--v3-layer-modal"));
    expect(value("--v3-layer-modal")).toBeLessThan(value("--v3-layer-toast"));
  });

  it("puts the toast in the body portal above shared dialogs and v3 overlays", () => {
    const layout = read("./V3DashboardLayout.tsx");
    const toast = read("./V3Toast.tsx");
    const dialog = read("../../../packages/soul-ui/src/components/ui/dialog.tsx");
    const layers = read("./v3-layer-contract.css");
    const contextMenu = read("./V3ContextMenu.tsx");

    expect(layout).toContain("<V3Toast message={toast}");
    expect(toast).toContain("createPortal");
    expect(toast).toContain("document.body");
    expect(dialog).toContain("z-[var(--v3-layer-modal,50)]");
    expect(layers).toContain(".v3-workspace-scrim");
    expect(layers).toContain("z-index: var(--v3-layer-overlay)");
    expect(layers).toContain("z-index: var(--v3-layer-toast)");
    expect(layers).toContain("z-index: calc(var(--v3-layer-panel) + 2)");
    expect(contextMenu).toContain("getBoundingClientRect");
    expect(contextMenu).toContain("top: y");
    expect(contextMenu).toContain("left: x");
  });
});
