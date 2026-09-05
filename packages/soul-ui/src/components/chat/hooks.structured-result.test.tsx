/**
 * @vitest-environment jsdom
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../../lib/flatten-tree";
import { useDashboardStore } from "../../stores/dashboard-store";
import { useLazyLoadContent, useLazyLoadToolTrace } from "./hooks";
import { ToolCallGroup } from "./ToolCallGroup";

const originalFetch = globalThis.fetch;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardStore.getState().reset();
  useDashboardStore.setState({ activeSessionKey: "session 1" });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "tool-message",
    role: "tool",
    content: "list_session_events",
    treeNodeId: "tool-368",
    treeNodeType: "tool",
    toolResult: "preview",
    ...overrides,
  };
}

function Probe({ children }: { children: ReactNode }) {
  return children;
}

describe("structured tool result lazy loading", () => {
  it("renders a structured full result through the real tool call surface", async () => {
    const result = { content: [{ type: "text", text: "full", extra: 7 }] };
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ event: { type: "tool_result", result } }),
    }) as Response);

    await act(async () => root.render(
      <ToolCallGroup messages={[message({
        isTruncated: true,
        fullContentEventId: 368,
      })]} />,
    ));
    const groupToggle = container.querySelector<HTMLButtonElement>(
      '[data-slot="tool-call-group-toggle"]',
    )!;
    await act(async () => groupToggle.click());
    const itemToggle = container.querySelector<HTMLButtonElement>(
      '[data-slot="tool-call-item-toggle"]',
    )!;
    await act(async () => itemToggle.click());
    expect(container.querySelector('[data-slot="chat-tool-body"]')?.textContent)
      .toBe("preview");

    const fullButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("전체 내용 보기"))!;
    await act(async () => fullButton.click());
    await vi.waitFor(() => expect(
      container.querySelector('[data-slot="chat-tool-body"]')?.textContent,
    ).toBe(JSON.stringify(result, null, 2)));
  });

  it("loads the raw event result through the same display normalization as live updates", async () => {
    const result = { content: [{ type: "text", text: "full", extra: 7 }] };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ event: { type: "tool_result", result } }),
    }) as Response);
    globalThis.fetch = fetchMock;
    let hook: ReturnType<typeof useLazyLoadContent> | undefined;

    function ContentProbe() {
      hook = useLazyLoadContent(message({ isTruncated: true, fullContentEventId: 368 }));
      return <Probe>{null}</Probe>;
    }
    await act(async () => root.render(<ContentProbe />));
    await act(async () => {
      hook!.loadFullContent();
      await vi.waitFor(() => expect(hook?.loading).toBe(false));
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session%201/events/368");
    expect(hook?.displayContent).toBe(JSON.stringify(result, null, 2));
    expect(hook?.isTruncated).toBe(false);
  });

  it("keeps complete content-block objects when a timeline trace replaces the preview", async () => {
    const result = [{ type: "text", text: "trace body", annotations: { source: "fixture" } }];
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        timeline_id: "tool:368",
        tool_use_id: "tool-r57",
        result,
      }),
    }) as Response);
    let hook: ReturnType<typeof useLazyLoadToolTrace> | undefined;

    function TraceProbe() {
      hook = useLazyLoadToolTrace(message({ toolTraceId: "tool:368" }));
      return <Probe>{null}</Probe>;
    }
    await act(async () => root.render(<TraceProbe />));
    await act(async () => {
      hook!.loadTrace();
      await vi.waitFor(() => expect(hook?.loading).toBe(false));
    });

    expect(hook?.resultContent).toBe(JSON.stringify(result, null, 2));
    expect(hook?.resultContent).toContain('"annotations"');
  });

  it.each([
    ["null", { result: null }, "null"],
    ["false", { result: false }, "false"],
    ["zero", { result: 0 }, "0"],
    ["empty string", { result: "" }, ""],
    ["missing", {}, "local result"],
  ])("distinguishes %s from a missing trace result", async (_label, traceResult, expected) => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ timeline_id: "tool:368", tool_use_id: "tool-r57", ...traceResult }),
    }) as Response);
    let hook: ReturnType<typeof useLazyLoadToolTrace> | undefined;
    function TraceProbe() {
      hook = useLazyLoadToolTrace(message({ toolTraceId: "tool:368", toolResult: "local result" }));
      return <Probe>{null}</Probe>;
    }
    await act(async () => root.render(<TraceProbe />));
    await act(async () => {
      hook!.loadTrace();
      await vi.waitFor(() => expect(hook?.loading).toBe(false));
    });

    expect(hook?.resultContent).toBe(expected);
  });
});
