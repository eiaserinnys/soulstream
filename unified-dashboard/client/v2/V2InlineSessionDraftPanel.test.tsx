/** @vitest-environment jsdom */
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createInlineSessionDraft,
  resolveInlineSessionDraftTarget,
  V2InlineSessionDraftPanel,
  type V2InlineSessionDraft,
} from "./V2InlineSessionDraftPanel";

const node = {
  nodeId: "node-a",
  host: "localhost",
  port: 1,
  status: "connected" as const,
  capabilities: {},
  connectedAt: 1,
  sessionCount: 0,
};

describe("V2InlineSessionDraftPanel", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    flushSync(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.unstubAllGlobals();
  });

  it("creates only local state and auto-selects the sole connected node", () => {
    expect(createInlineSessionDraft(
      { pageId: "page-a", blockId: "block-a" },
      [node],
      "8c55c4d8-625b-4b1f-92ec-81dcb52ae453",
    )).toEqual(expect.objectContaining({
      pageId: "page-a",
      blockId: "block-a",
      nodeId: "node-a",
      prompt: "",
      pending: false,
    }));
  });

  it("keeps the prompt and selections visible while surfacing a retryable error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      agents: [{ id: "roselin", name: "Roselin" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const draft: V2InlineSessionDraft = {
      pageId: "page-a",
      blockId: "block-a",
      recoverySessionId: "8c55c4d8-625b-4b1f-92ec-81dcb52ae453",
      nodeId: "node-a",
      agentId: "roselin",
      prompt: "Preserved prompt",
      pending: false,
      error: "Target block changed. Retry after returning to the page.",
    };
    const onSubmit = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(createElement(V2InlineSessionDraftPanel, {
      draft,
      nodes: [node],
      onChange: vi.fn(),
      onSubmit,
      onCancel: vi.fn(),
    })));
    await Promise.resolve();

    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="First session prompt"]')?.value)
      .toBe("Preserved prompt");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Target block changed");
    flushSync(() => container!.querySelector<HTMLButtonElement>('[data-testid="v2-inline-session-send"]')!.click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("rejects stale text and recovers an already converted primary session_ref", () => {
    const draft = createInlineSessionDraft(
      { pageId: "page-a", blockId: "block-a" },
      [node],
      "8c55c4d8-625b-4b1f-92ec-81dcb52ae453",
    );
    expect(resolveInlineSessionDraftTarget({
      draft,
      connectedNodeIds: new Set(["node-a"]),
      currentPage: {
        id: "page-a",
        version: 7,
        blocks: [{ id: "block-a", type: "paragraph", textValue: "changed", properties: {} }],
      },
    })).toEqual({ kind: "error", message: "The draft block changed. Restore /세션 before retrying." });

    expect(resolveInlineSessionDraftTarget({
      draft,
      connectedNodeIds: new Set(["node-a"]),
      currentPage: {
        id: "page-a",
        version: 8,
        blocks: [{
          id: "block-a",
          type: "session_ref",
          textValue: "[[Daily]]",
          properties: { sessionId: "session-recovered", primary: true },
        }],
      },
    })).toEqual({ kind: "recovered", sessionId: "session-recovered" });
  });
});
