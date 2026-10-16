/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { V3GlobalToolbar } from "./V3GlobalToolbar";

vi.mock("@seosoyoung/soul-ui", async () => {
  const actual = await vi.importActual<typeof import("@seosoyoung/soul-ui")>("@seosoyoung/soul-ui");
  return {
    ...actual,
    ThemeToggle: () => <button aria-label="테마 전환" />,
    useGlassSurface: () => false,
    useLiquidLens: () => undefined,
  };
});
vi.mock("../components/ConfigButton", () => ({ ConfigButton: () => <button aria-label="설정" /> }));
vi.mock("./PersistentSessionEntry", () => ({ PersistentSessionEntry: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("uses the actual agent name in the minimal PAS header and keeps a stable usage toggle", () => {
  const onToggleUsage = vi.fn();
  act(() => root.render(
    <V3GlobalToolbar
      variant="minimal"
      appearance="bare"
      sessionName="대화 제목"
      agentName="서소영 (PAS)"
      agentOnly={false}
      showWeeklyUsage
      onToggleUsage={onToggleUsage}
      onOpenConfig={() => undefined}
    />,
  ));

  const brand = host.querySelector(".persistent-session-brand")!;
  expect(brand.textContent).toContain("소울스트림");
  expect(brand.textContent).toContain("서소영 (PAS)");
  expect(brand.textContent).not.toContain("대화 제목");

  const toggle = host.querySelector<HTMLButtonElement>(".persistent-session-weekly-usage-toggle")!;
  expect(toggle).not.toBeNull();
  expect(toggle.getAttribute("aria-label")).toBe("주간 사용량");
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(toggle.getAttribute("type")).toBe("button");
  act(() => toggle.click());
  expect(onToggleUsage).toHaveBeenCalledOnce();
});

it("leaves the default toolbar brand, search, and actions intact", () => {
  act(() => root.render(
    <V3GlobalToolbar
      onOpenConfig={() => undefined}
      onOpenSearch={() => undefined}
      onToggleUsage={() => undefined}
      showWeeklyUsage
    />,
  ));

  expect(host.querySelector(".dashboard-floating-toolbar .dashboard-toolbar-brand")?.textContent).toContain("Soulstream");
  expect(host.querySelector('[aria-label="Open session search"]')).not.toBeNull();
  expect(host.querySelector(".persistent-session-weekly-usage-toggle")).toBeNull();
});
