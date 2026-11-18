/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SettingsListHeader, SettingsListRow } from "./SettingsListDetail";

it("keeps Korean words together in the list description", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SettingsListHeader title="목록" description="목록 설명" actions={null} />));
    const description = container.querySelector("p")!;
    expect(description.classList.contains("break-keep")).toBe(true);
    expect(description.classList.contains("break-words")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

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
