/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SettingFieldWidget, type SettingField } from "./SettingFieldWidget";

// Use the existing settings interaction tests' actual React DOM harness.
it.each(["secret", "text", "bool"] as const)("preserves the ordinary %s control's direct row structure", async (kind) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const field: SettingField = { key: kind, field_name: kind, label: "설정", description: "", value: "value", value_type: kind === "bool" ? "bool" : "str", sensitive: kind === "secret", hot_reloadable: true, read_only: false };
  try {
    await act(async () => root.render(<SettingFieldWidget field={field} value={kind === "bool" ? "true" : "value"} onChange={() => undefined} />));
    const row = container.querySelector('[data-testid="config-field-row"]')!;
    const control = row.children[1]!;
    expect(control.classList.contains("relative") && control.classList.contains("min-w-0")).toBe(false);
    if (kind === "bool") expect(control.getAttribute("role")).toBe("switch");
    else if (kind === "text") expect(control.getAttribute("data-slot")).toBe("input-control");
    else {
      expect(control.className).toBe("flex items-center gap-1");
      expect(control.children[0]?.getAttribute("data-slot")).toBe("input-control");
      expect(control.children[1]?.tagName).toBe("BUTTON");
    }
    expect(row.querySelector('[role="status"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
