/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStreamStatus } from "./SessionStreamStatus";

describe("SessionStreamStatus", () => {
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

  it("shows an error label and a manual reconnect action after the stream stops", () => {
    const reconnect = vi.fn();
    flushSync(() => root.render(
      <SessionStreamStatus status="error" reconnect={reconnect} />,
    ));

    const button = container.querySelector<HTMLButtonElement>("[data-testid='v3-session-stream-retry']");
    expect(button?.textContent).toContain("연결 오류");
    expect(button?.textContent).toContain("다시 연결");
    flushSync(() => button?.click());
    expect(reconnect).toHaveBeenCalledOnce();
  });
});
