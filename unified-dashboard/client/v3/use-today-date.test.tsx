/**
 * @vitest-environment jsdom
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTodayDate } from "./use-today-date";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("useTodayDate", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 26, 23, 59, 59));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("advances after local midnight while the dashboard remains open", async () => {
    function Probe() {
      return <output data-testid="today">{useTodayDate()}</output>;
    }

    act(() => root.render(<Probe />));
    expect(container.querySelector("output")?.textContent).toBe("2026-09-26");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(container.querySelector("output")?.textContent).toBe("2026-09-27");
  });
});
