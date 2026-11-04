/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SettingsListRow } from "./SettingsListDetail";

it("renders each settings row as a block button", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SettingsListRow title="세션" meta="에이전트" selected={false} onSelect={() => undefined} />));
    expect(container.querySelector("button")?.classList.contains("block")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
