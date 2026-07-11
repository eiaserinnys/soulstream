/** @vitest-environment jsdom */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LegacyFolderProjection, SessionSummary } from "@seosoyoung/soul-ui";
import { V2LegacyFolderSurface } from "./V2LegacyFolderSurface";

function projection(count: number): Extract<LegacyFolderProjection, { status: "ready" }> {
  const rows = Array.from({ length: count }, (_, index) => {
    const session: SessionSummary = {
      agentSessionId: `session-${index}`,
      status: index % 2 === 0 ? "running" : "completed",
      eventCount: 0,
      prompt: `Session ${index}`,
    };
    return {
      kind: "session" as const,
      id: session.agentSessionId,
      depth: 0,
      title: session.prompt!,
      session,
    };
  });
  return {
    status: "ready",
    folder: { id: "folder-a", name: "Legacy folder", sortOrder: 0 },
    rows,
    readOnly: true,
  };
}

describe("V2LegacyFolderSurface", () => {
  let container: HTMLDivElement;
  let root: Root;
  let heightSpy: ReturnType<typeof vi.spyOn>;
  let widthSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    heightSpy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    widthSpy = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    heightSpy.mockRestore();
    widthSpy.mockRestore();
  });

  it("keeps a 2,000-session read-only projection virtualized", () => {
    flushSync(() => root.render(createElement(V2LegacyFolderSurface, {
      state: { status: "ready", projection: projection(2_000) },
      lens: "running",
      onLensChange: vi.fn(),
      onOpenFolder: vi.fn(),
      onOpenSession: vi.fn(),
    })));
    const mounted = container.querySelectorAll("[data-legacy-row]");
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThanOrEqual(40);
    expect(container.textContent).toContain("Read-only virtual page");
    expect(container.querySelector("textarea, input")).toBeNull();
  });

  it("separates authentication, forbidden, missing, and empty states", () => {
    for (const [status, message] of [
      ["authentication", "Sign in again"],
      ["forbidden", "do not have access"],
      ["missing", "no longer exists"],
      ["empty", "Nothing is stored"],
    ] as const) {
      flushSync(() => root.render(createElement(V2LegacyFolderSurface, {
        state: { status, message },
        lens: "default",
        onLensChange: vi.fn(),
        onOpenFolder: vi.fn(),
        onOpenSession: vi.fn(),
      })));
      expect(container.textContent).toContain(message);
    }
  });
});
