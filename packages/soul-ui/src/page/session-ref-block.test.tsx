/** @vitest-environment jsdom */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionSummary } from "../shared/types";
import { sessionLensState } from "./page-lenses";
import type { SessionReferenceResolution } from "./session-summary-index";
import { SessionRefBlock } from "./session-ref-block";

function ready(status: SessionSummary["status"]): SessionReferenceResolution {
  return {
    kind: "ready",
    sessionId: "session-a",
    summary: {
      agentSessionId: "session-a",
      displayName: "Investigation",
      prompt: "Find the root cause",
      status,
      eventCount: 3,
      nodeId: "eiaserinnys",
      agentName: "Roselin",
    },
  };
}

describe("SessionRefBlock", () => {
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

  it("rerenders live status from the derived session index", () => {
    flushSync(() => root.render(createElement(SessionRefBlock, {
      resolution: ready("running"),
      lensState: sessionLensState("running", "running"),
      onOpen: vi.fn(),
    })));
    expect(container.querySelector("[data-session-status='running']")).not.toBeNull();
    expect(container.textContent).toContain("Roselin · eiaserinnys");

    flushSync(() => root.render(createElement(SessionRefBlock, {
      resolution: ready("completed"),
      lensState: sessionLensState("completed", "running"),
      onOpen: vi.fn(),
    })));
    expect(container.querySelector("[data-session-status='completed']")).not.toBeNull();
    expect(container.querySelector("[data-lens-state='dimmed']")).not.toBeNull();
  });

  it("opens the canonical session on click, Enter, and Space", () => {
    const onOpen = vi.fn();
    flushSync(() => root.render(createElement(SessionRefBlock, {
      resolution: ready("running"),
      lensState: "neutral",
      onOpen,
    })));
    const target = container.querySelector<HTMLElement>("[role='button']")!;
    target.click();
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it("renders a read-only unavailable placeholder for missing or forbidden sessions", () => {
    flushSync(() => root.render(createElement(SessionRefBlock, {
      resolution: {
        kind: "unavailable",
        sessionId: "session-secret",
        message: "Session unavailable — it may have been deleted or you may not have access.",
      },
      lensState: "neutral",
      onOpen: vi.fn(),
    })));
    expect(container.querySelector("[data-session-ref-unavailable='session-secret']")).not.toBeNull();
    expect(container.textContent).toContain("deleted or you may not have access");
    expect(container.querySelector("textarea")).toBeNull();
  });
});
