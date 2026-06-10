/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoulSSEEvent } from "@shared/types";

import { useDashboardStore } from "../../stores/dashboard-store";
import { ChatView } from "./ChatView";

const virtuosoMock = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  requestOlder: vi.fn(),
  props: null as Record<string, unknown> | null,
}));

vi.mock("react-virtuoso", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  const Virtuoso = React.forwardRef<unknown, Record<string, unknown>>((props, ref) => {
    const scrollerRef = React.useRef<HTMLDivElement>(null);
    virtuosoMock.props = props;
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: virtuosoMock.scrollToIndex,
      scrollBy: vi.fn(),
      scrollTo: vi.fn(),
      getState: vi.fn(),
      autoscrollToBottom: vi.fn(),
      scrollIntoView: vi.fn(),
    }));
    React.useEffect(() => {
      virtuosoMock.props = props;
      const setScrollerRef = props.scrollerRef as
        | ((ref: HTMLDivElement | null) => void)
        | undefined;
      setScrollerRef?.(scrollerRef.current);
      return () => {
        setScrollerRef?.(null);
      };
    }, [props]);

    return React.createElement("div", { ref: scrollerRef, "data-testid": "virtuoso" });
  });

  return { Virtuoso };
});

vi.mock("./useMessageHistoryBuffer", () => ({
  useMessageHistoryBuffer: () => ({
    loading: false,
    reachedTop: false,
    requestOlder: virtuosoMock.requestOlder,
  }),
}));

vi.mock("../ChatInput", () => ({
  ChatInput: () => createElement("div", { "data-testid": "chat-input" }),
}));

vi.mock("./VirtualizedItem", () => ({
  VirtualizedItem: () => createElement("div", { "data-testid": "chat-item" }),
}));

vi.mock("./hooks", () => ({
  useLlmContext: () => undefined,
}));

vi.mock("./ChatRuntimeCompactStrips", () => ({
  ChatRuntimeCompactStrips: () =>
    createElement("div", { "data-testid": "runtime-strips" }),
}));

function makeUserMessage(eventId: number): { event: SoulSSEEvent; eventId: number } {
  return {
    event: {
      type: "user_message",
      text: `message-${eventId}`,
      timestamp: 0,
    } as unknown as SoulSSEEvent,
    eventId,
  };
}

function flushPassiveEffects(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

async function renderChatView(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(createElement(ChatView));
  });
  await flushPassiveEffects();

  return { container, root };
}

describe("ChatView long-session initial bottom focus", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let now = 0;

  beforeEach(() => {
    now = 0;
    useDashboardStore.getState().reset();
    useDashboardStore.getState().setActiveSession("sess-long");
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    virtuosoMock.scrollToIndex.mockClear();
    virtuosoMock.requestOlder.mockClear();
    virtuosoMock.props = null;
  });

  afterEach(async () => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
      await flushPassiveEffects();
    }
    container?.remove();
    root = undefined;
    container = undefined;
    useDashboardStore.getState().reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps retrying bottom focus after a late false atBottom report until the session reaches bottom", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeUserMessage(1000),
      makeUserMessage(1001),
    ]);

    ({ container, root } = await renderChatView());
    expect(container.querySelector('[data-testid="virtuoso"]')).not.toBeNull();
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });

    virtuosoMock.scrollToIndex.mockClear();
    now = 1000;
    flushSync(() => {
      const atBottomStateChange = virtuosoMock.props?.atBottomStateChange as
        | ((atBottom: boolean) => void)
        | undefined;
      atBottomStateChange?.(false);
    });
    await flushPassiveEffects();

    now = 1001;
    flushSync(() => {
      useDashboardStore.getState().processHistoryEvents([
        makeUserMessage(900),
        makeUserMessage(901),
      ]);
    });
    await flushPassiveEffects();

    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });
  });
});
