import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesEntry = readFileSync(new URL("./v3-dashboard-styles.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("./v3-selection-policy.css", import.meta.url), "utf8");
const boundaries = [
  '.v3-shell', '.v3-popup-chrome', '[data-slot="dialog-viewport"]',
  '[data-slot="dialog-popup"]', '[data-slot="alert-dialog-popup"]', '[data-slot="popover-popup"]',
];
const contentSelectors = [
  'input', 'textarea', '[contenteditable="true"]',
  ...[
    '[data-v3-selectable-content="true"]', '[data-slot="chat-body"]', '[data-slot="chat-tool-body"]',
    '[data-slot="attachment-name"]', '[data-slot="attachment-preview-body"]', '[data-slot="dialog-error-message"]',
    '[data-slot="dialog-error-detail"]', '[data-slot="session-story-body"]', '[data-slot="inherited-prompt-body"]',
  ].flatMap(selector => [selector, `${selector} *`]),
];
const buttonSelectors = [
  '[data-v3-selectable-content="true"] button', '[data-v3-selectable-content="true"] button *',
  '[data-slot="attachment-preview-body"] button', '[data-slot="attachment-preview-body"] button *',
];

describe("v3 text selection policy", () => {
  it("loads the semantic selection layer before the final dialog rules", () => {
    const selectionIndex = stylesEntry.indexOf('import "./v3-selection-policy.css";');
    expect(selectionIndex).toBeGreaterThan(stylesEntry.indexOf('import "./v3-layer-contract.css";'));
    expect(selectionIndex).toBeLessThan(stylesEntry.indexOf('import "./v3-dialog-hierarchy.css";'));
  });

  it("uses the same boundaries for chrome, content and buttons with one content exception list", () => {
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]+)\}/g)];
    expect(rules).toHaveLength(3);
    for (const [index, rule] of rules.entries()) {
      const selector = rule[1].trim().match(/^:is\(([^)]+)\)(?:\s+:where\(([^)]+)\))?$/s);
      expect(selector).not.toBeNull();
      if (!selector) throw new Error(`Unexpected selection rule: ${rule[1]}`);
      expect(selector[1].split(',').map(value => value.trim())).toEqual(boundaries);
      const expectedValue = index === 1 ? 'text' : 'none';
      expect(rule[2]).toMatch(new RegExp(`(?:^|\\s)user-select:\\s*${expectedValue}\\s*;`));
      expect(rule[2]).toMatch(new RegExp(`-webkit-user-select:\\s*${expectedValue}\\s*;`));
      if (index === 0) expect(selector[2]).toBeUndefined();
      else expect(selector[2]?.split(',').map(value => value.trim())).toEqual(index === 1 ? contentSelectors : buttonSelectors);
    }
  });
});
