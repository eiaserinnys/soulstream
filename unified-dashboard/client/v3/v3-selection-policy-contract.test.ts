import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesEntry = readFileSync(new URL("./v3-dashboard-styles.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("./v3-selection-policy.css", import.meta.url), "utf8");

describe("v3 text selection policy", () => {
  it("loads the semantic selection layer before the final dialog rules", () => {
    const selectionIndex = stylesEntry.indexOf('import "./v3-selection-policy.css";');
    expect(selectionIndex).toBeGreaterThan(stylesEntry.indexOf('import "./v3-layer-contract.css";'));
    expect(selectionIndex).toBeLessThan(stylesEntry.indexOf('import "./v3-dialog-hierarchy.css";'));
  });

  it("keeps selection inside the dialog when a drag reaches the viewport outside its popup", () => {
    const chrome = css.match(/([^{}]+)\{([^}]*user-select:\s*none[^}]*)\}/);
    expect(chrome?.[1].split(',').map(s => s.trim())).toContain('[data-slot="dialog-viewport"]');
  });

  it.each(['.v3-shell', '.v3-popup-chrome', '[data-slot="dialog-popup"]', '[data-slot="alert-dialog-popup"]', '[data-slot="popover-popup"]'])("blocks %s chrome and restores its user content", (boundary) => {
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]+)\}/g)];
    const chrome = rules.find(([, selectors, body]) => selectors.split(',').map(s => s.trim()).includes(boundary) && /user-select:\s*none/.test(body));
    expect(chrome).toBeDefined();
    const content = rules.find(([, selectors, body]) => selectors.includes(`${boundary} :where(`) && /user-select:\s*text/.test(body));
    expect(content).toBeDefined();
    const exceptions = content?.[1].split(`${boundary} :where(`)[1]?.split(')')[0].split(',').map(s => s.trim());
    for (const selector of ['input', 'textarea', '[contenteditable="true"]', '[data-slot="chat-body"]', '[data-slot="chat-tool-body"]', '[data-v3-selectable-content="true"]', '[data-slot="attachment-preview-body"]', '[data-slot="dialog-error-message"]']) {
      expect(exceptions).toContain(selector);
    }
  });
});
