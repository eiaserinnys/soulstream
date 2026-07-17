/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskTodayToggle } from "./TaskTodayToggle";

describe("TaskTodayToggle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it("renders the state-aware add and remove actions", () => {
    const render = (inToday: boolean) => flushSync(() => root.render(
      <TaskTodayToggle inToday={inToday} onToggle={vi.fn()} />,
    ));

    render(false);
    expect(button().getAttribute("aria-label")).toBe("오늘 플래너에 추가");
    expect(button().title).toBe("오늘 플래너에 추가");
    expect(button().className).toContain("dashboard-icon-cap");
    expect(button().getAttribute("aria-pressed")).toBe("false");

    render(true);
    expect(button().getAttribute("aria-label")).toBe("오늘 플래너에서 제거");
    expect(button().title).toBe("오늘 플래너에서 제거");
    expect(button().getAttribute("aria-pressed")).toBe("true");
  });

  it("blocks duplicate clicks while the canonical toggle is pending", async () => {
    const request = deferred<void>();
    const onToggle = vi.fn(() => request.promise);
    flushSync(() => root.render(<TaskTodayToggle inToday onToggle={onToggle} />));

    button().click();
    await vi.waitFor(() => expect(button().disabled).toBe(true));
    button().click();
    expect(onToggle).toHaveBeenCalledTimes(1);

    request.resolve();
    await vi.waitFor(() => expect(button().disabled).toBe(false));
  });

  function button(): HTMLButtonElement {
    const target = container.querySelector<HTMLButtonElement>("button");
    if (!target) throw new Error("오늘 플래너 토글을 찾지 못했습니다.");
    return target;
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
