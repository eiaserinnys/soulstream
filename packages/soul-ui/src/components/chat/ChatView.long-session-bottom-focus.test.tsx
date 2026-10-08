/**
 * @vitest-environment jsdom
 */

import { createElement, type ComponentType } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoulSSEEvent } from "@shared/types";

import { createChatSessionStore, useDashboardStore } from "../../stores/dashboard-store";
import { ChatView } from "./ChatView";
import { MAX_SEARCH_FOCUS_HISTORY_PAGES } from "./ChatView.reverse-helpers";

const virtuosoMock = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  requestOlder: vi.fn(),
  notifyViewportGeometry: vi.fn(),
  blockedReason: null as "error" | null,
  canLoadOlder: false,
  historyLoading: false,
  reachedTop: false,
  props: null as Record<string, unknown> | null,
}));
const chatInputMock = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  activeSessionKey: null as string | null,
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
    }, [props.scrollerRef]);

    const data = (props.data as any[] | undefined) ?? [];
    const components = props.components as
      | { Header?: ComponentType; EmptyPlaceholder?: ComponentType }
      | undefined;
    const Header = components?.Header;
    const EmptyPlaceholder = components?.EmptyPlaceholder;
    const firstItemIndex = props.firstItemIndex as number;
    const computeItemKey = props.computeItemKey as (
      index: number,
      item: any,
    ) => React.Key;
    const itemContent = props.itemContent as (index: number, item: any) => React.ReactNode;
    return React.createElement(
      "div",
      { ref: scrollerRef, "data-testid": "virtuoso" },
      Header ? React.createElement(Header) : null,
      data.length === 0 && EmptyPlaceholder
        ? React.createElement(EmptyPlaceholder)
        : null,
      data.map((item, index) => React.createElement(
        "div",
        { key: computeItemKey(firstItemIndex + index, item) },
        itemContent(firstItemIndex + index, item),
      )),
    );
  });

  return { Virtuoso };
});

vi.mock("./useMessageHistoryBuffer", () => ({
  VIEWPORT_FILL_MARGIN_PX: 200,
  useMessageHistoryBuffer: () => ({
    loading: virtuosoMock.historyLoading,
    reachedTop: virtuosoMock.reachedTop,
    canLoadOlder: virtuosoMock.canLoadOlder,
    blockedReason: virtuosoMock.blockedReason,
    requestOlder: virtuosoMock.requestOlder,
    notifyViewportGeometry: virtuosoMock.notifyViewportGeometry,
  }),
}));

vi.mock("../ChatInput", async () => {
  const { useChatStore } = await vi.importActual<typeof import("../../stores/chat-store-scope")>(
    "../../stores/chat-store-scope",
  );
  return {
    ChatInput: (props: Record<string, unknown>) => {
      chatInputMock.props = props;
      chatInputMock.activeSessionKey = useChatStore((state) => state.activeSessionKey);
      return createElement("div", { "data-testid": "chat-input" });
    },
  };
});

vi.mock("./VirtualizedItem", () => ({
  VirtualizedItem: ({ item }: { item: any }) => {
    const firstMessage = item.type === "tool-group"
      ? item.messages[0]
      : item.type === "summary-group"
        ? item.anchor.type === "tool-group"
          ? item.anchor.messages[0]
          : item.anchor.msg
        : item.type === "single"
          ? item.msg
          : null;
    return createElement("div", {
      "data-testid": "chat-item",
      "data-tree-node-id": firstMessage?.treeNodeId,
    });
  },
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

function makeAssistantMessage(eventId: number): { event: SoulSSEEvent; eventId: number } {
  return {
    event: {
      type: "assistant_message",
      text: `assistant-${eventId}`,
      timestamp: 0,
    } as unknown as SoulSSEEvent,
    eventId,
  };
}

function makeComplete(eventId: number): { event: SoulSSEEvent; eventId: number } {
  return {
    event: {
      type: "complete",
      timestamp: 0,
    } as unknown as SoulSSEEvent,
    eventId,
  };
}

function makeToolStart(eventId: number): { event: SoulSSEEvent; eventId: number } {
  return {
    event: {
      type: "tool_start",
      tool_name: "Read",
      tool_input: { file_path: `/tmp/${eventId}` },
      tool_use_id: `tool-use-${eventId}`,
      timestamp: 0,
    } as unknown as SoulSSEEvent,
    eventId,
  };
}

function makeTurnSummary(
  eventId: number,
  anchorEventId: number,
): { event: SoulSSEEvent; eventId: number } {
  return {
    event: {
      type: "turn_summary",
      content: `summary-${eventId}`,
      final_response_event_id: anchorEventId,
      parent_event_id: anchorEventId,
      timestamp: 0,
    } as unknown as SoulSSEEvent,
    eventId,
  };
}

function virtuosoData(): any[] {
  return (virtuosoMock.props?.data as any[] | undefined) ?? [];
}

function itemKeyAt(dataIndex: number): React.Key {
  const data = virtuosoData();
  const firstItemIndex = virtuosoMock.props?.firstItemIndex as number;
  const computeItemKey = virtuosoMock.props?.computeItemKey as (
    index: number,
    item: any,
  ) => React.Key;
  return computeItemKey(firstItemIndex + dataIndex, data[dataIndex]);
}

function setFirstVisibleDataIndex(dataIndex: number): {
  absoluteIndex: number;
  key: React.Key;
} {
  const firstItemIndex = virtuosoMock.props?.firstItemIndex as number;
  const absoluteIndex = firstItemIndex + dataIndex;
  const key = itemKeyAt(dataIndex);
  const scroller = document.querySelector<HTMLElement>('[data-testid="virtuoso"]');
  if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
  const makeRect = (top: number, bottom: number): DOMRect => ({
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 320,
    width: 320,
    height: bottom - top,
    toJSON: () => ({}),
  });
  scroller.getBoundingClientRect = () => makeRect(100, 300);
  const markers = Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-chat-item-key]"),
  );
  markers.forEach((marker, index) => {
    const row = marker.firstElementChild as HTMLElement | null;
    if (!row) throw new Error("chat item geometry target이 없습니다.");
    const top = 100 + (index - dataIndex) * 40;
    row.getBoundingClientRect = () => makeRect(top, top + 40);
  });
  scroller.dispatchEvent(new Event("scroll"));
  expect(scroller.dataset.chatFirstVisibleKey).toBe(String(key));
  return { absoluteIndex, key };
}

function findDataIndexByKey(key: React.Key): number {
  return virtuosoData().findIndex((_, index) => itemKeyAt(index) === key);
}

function reportAtBottom(atBottom: boolean): void {
  const callback = virtuosoMock.props?.atBottomStateChange as
    | ((value: boolean) => void)
    | undefined;
  if (!callback) throw new Error("Virtuoso atBottom callback이 없습니다.");
  callback(atBottom);
}

function configureScroller(
  container: HTMLElement,
  { scrollHeight, clientHeight, scrollTop }: {
    scrollHeight: number;
    clientHeight: number;
    scrollTop: number;
  },
) {
  const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
  if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    writable: true,
    value: scrollHeight,
  });
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    writable: true,
    value: scrollTop,
  });
  const scrollTo = vi.fn((optionsOrX?: ScrollToOptions | number, y?: number) => {
    const top = typeof optionsOrX === "number" ? y : optionsOrX?.top;
    if (top !== undefined) scroller.scrollTop = top;
  });
  scroller.scrollTo = scrollTo;
  return {
    scroller,
    scrollTo,
    setScrollHeight(value: number) {
      Object.defineProperty(scroller, "scrollHeight", {
        configurable: true,
        writable: true,
        value,
      });
    },
  };
}

async function addLiveUserMessage(eventId: number): Promise<void> {
  flushSync(() => {
    const message = makeUserMessage(eventId);
    useDashboardStore.getState().processEvent(message.event, eventId);
  });
  await flushPassiveEffects();
}

async function addLiveEvent(event: SoulSSEEvent, eventId: number): Promise<void> {
  flushSync(() => useDashboardStore.getState().processEvent(event, eventId));
  await flushPassiveEffects();
}

function flushPassiveEffects(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

async function renderChatView(props: Partial<NonNullable<Parameters<typeof ChatView>[0]>> = {}): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(createElement(
      ChatView as unknown as ComponentType<Record<string, unknown>>,
      props as Record<string, unknown>,
    ));
  });
  await flushPassiveEffects();

  return { container, root };
}

function markOlderExploration(container: HTMLElement | undefined): void {
  if (!container) throw new Error("ChatView test container가 없습니다.");
  const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
  if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    writable: true,
    value: 900,
  });
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
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
    virtuosoMock.notifyViewportGeometry.mockClear();
    virtuosoMock.blockedReason = null;
    virtuosoMock.canLoadOlder = false;
    virtuosoMock.historyLoading = false;
    virtuosoMock.reachedTop = false;
    virtuosoMock.props = null;
    chatInputMock.props = null;
    chatInputMock.activeSessionKey = null;
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

  it("hides only the Follow row in manuscript mode and forwards the composer anchor", async () => {
    const composerAnchorRef = { current: null };
    ({ container, root } = await renderChatView({
      presentation: "manuscript",
      composerAnchorRef,
    }));

    expect(container.querySelector<HTMLElement>('[data-slot="chat-root"]')?.dataset.chatPresentation)
      .toBe("manuscript");
    expect(container.textContent).not.toContain("Follow");
    expect(container.querySelector('[data-testid="runtime-strips"]')).not.toBeNull();
    expect(chatInputMock.props?.presentation).toBe("manuscript");
    expect(chatInputMock.props?.composerAnchorRef).toBe(composerAnchorRef);
  });

  it("keeps runtime strips by default and omits them when the caller hides session auxiliaries", async () => {
    ({ container, root } = await renderChatView({ presentation: "manuscript" }));
    expect(container.querySelector('[data-testid="runtime-strips"]')).not.toBeNull();

    flushSync(() => {
      root?.render(createElement(
        ChatView as unknown as ComponentType<Record<string, unknown>>,
        { presentation: "manuscript", showRuntimeStrips: false },
      ));
    });
    await flushPassiveEffects();
    expect(container.querySelector('[data-testid="runtime-strips"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-input"]')).not.toBeNull();
  });

  it("(가) 원고형은 atBottom 안에서 위쪽 휠 뒤 새 메시지가 오면 하단을 유지한다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView({ presentation: "manuscript" }));
    const geometry = configureScroller(container, {
      scrollHeight: 800,
      clientHeight: 400,
      scrollTop: 400,
    });
    flushSync(() => reportAtBottom(true));
    await flushPassiveEffects();

    flushSync(() => {
      geometry.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
    });
    expect(virtuosoMock.props?.followOutput).toBe(false);
    geometry.setScrollHeight(820);

    await addLiveUserMessage(1001);

    expect(container.textContent).not.toContain("New Messages");
    expect(virtuosoMock.props?.followOutput).toBeTypeOf("function");
    expect(geometry.scrollTo).toHaveBeenCalledWith({ top: 820, behavior: "auto" });
    expect(geometry.scroller.scrollTop).toBe(820);
  });

  it("(나) 원고형은 아래로 돌아오면 따라가기를 다시 켠다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView({ presentation: "manuscript" }));
    const geometry = configureScroller(container, {
      scrollHeight: 800,
      clientHeight: 400,
      scrollTop: 400,
    });
    flushSync(() => reportAtBottom(true));
    await flushPassiveEffects();

    flushSync(() => {
      geometry.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      reportAtBottom(false);
    });
    expect(virtuosoMock.props?.followOutput).toBe(false);
    geometry.scroller.scrollTop = 400;
    flushSync(() => reportAtBottom(true));
    await flushPassiveEffects();
    geometry.setScrollHeight(820);

    await addLiveUserMessage(1001);

    expect(container.textContent).not.toContain("New Messages");
    expect(virtuosoMock.props?.followOutput).toBeTypeOf("function");
    expect(geometry.scrollTo).toHaveBeenCalledWith({ top: 820, behavior: "auto" });
    expect(geometry.scroller.scrollTop).toBe(820);
  });

  it("(다) 원고형은 하단 판정 밖에서 새 메시지가 오면 버튼을 보인다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView({ presentation: "manuscript" }));
    const geometry = configureScroller(container, {
      scrollHeight: 800,
      clientHeight: 400,
      scrollTop: 400,
    });
    flushSync(() => reportAtBottom(true));
    await flushPassiveEffects();

    flushSync(() => {
      geometry.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      geometry.scroller.scrollTop = 250;
      reportAtBottom(false);
    });
    geometry.setScrollHeight(820);

    await addLiveUserMessage(1001);

    expect(container.querySelector('button[aria-label="새 메시지로 이동"]')).not.toBeNull();
    expect(virtuosoMock.props?.followOutput).toBe(false);
    expect(geometry.scrollTo).not.toHaveBeenCalled();
  });

  it("does not show the new-message button for any event in a cache-keepalive turn", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView({ presentation: "manuscript" }));
    const geometry = configureScroller(container, {
      scrollHeight: 800,
      clientHeight: 400,
      scrollTop: 400,
    });
    flushSync(() => {
      geometry.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      geometry.scroller.scrollTop = 250;
      reportAtBottom(false);
    });
    await flushPassiveEffects();

    const keepaliveEvents = [
      {
        type: "user_message",
        input_id: "keepalive-1001",
        text: "캐시 유지용 호출입니다. 도구를 쓰지 말고 'ok'만 답하십시오.",
        purpose: "cache_keepalive",
      },
      { type: "generation_started", context_reset: true },
      { type: "assistant_message", text: "ok" },
      { type: "complete", result: "done", attachments: [], turn_cost_usd: 0.01, session_cost_usd: 0.04 },
      {
        type: "debug",
        kind: "persistent_instruction_recorded",
        input_id: "keepalive-1001",
        timestamp: 1,
        instructions: [{ id: "record-1001", text: "Keep notes concise", source_turns: ["T12"], action: "added" }],
        cap_reached: false,
      },
    ] as unknown as SoulSSEEvent[];
    for (const [index, event] of keepaliveEvents.entries()) {
      await addLiveEvent(event, 1001 + index);
      expect(container.querySelector('[aria-label="새 메시지로 이동"]')).toBeNull();
    }

    await addLiveUserMessage(1006);

    expect(container.querySelector('[aria-label="새 메시지로 이동"]')).not.toBeNull();
    expect(virtuosoMock.props?.followOutput).toBe(false);
    expect(geometry.scrollTo).not.toHaveBeenCalled();
  });

  it.each(["threshold", "returned-to-bottom"] as const)(
    "(라) 기본 모양은 %s 경로에서 기존처럼 새 메시지 버튼을 보인다",
    async (scenario) => {
      useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
      ({ container, root } = await renderChatView({ presentation: "default" }));
      const geometry = configureScroller(container, {
        scrollHeight: 800,
        clientHeight: 400,
        scrollTop: 400,
      });
      flushSync(() => reportAtBottom(true));
      await flushPassiveEffects();

      flushSync(() => {
        geometry.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
        if (scenario === "returned-to-bottom") {
          geometry.scroller.scrollTop = 400;
          reportAtBottom(false);
          reportAtBottom(true);
        }
      });
      geometry.setScrollHeight(820);

      await addLiveUserMessage(1001);

      expect(container.textContent).toContain("New Messages");
      expect(virtuosoMock.props?.followOutput).toBe(false);
      expect(geometry.scrollTo).not.toHaveBeenCalled();
    },
  );

  it("shows manuscript new messages as a textless accessible bare cap", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView({ presentation: "manuscript" }));
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void) | undefined)?.(true);
    });
    await flushPassiveEffects();

    const geometry = configureScroller(container, {
      scrollHeight: 800,
      clientHeight: 400,
      scrollTop: 400,
    });
    flushSync(() => reportAtBottom(true));
    await flushPassiveEffects();
    flushSync(() => {
      geometry.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      geometry.scroller.scrollTop = 250;
      reportAtBottom(false);
    });
    geometry.setScrollHeight(820);
    await addLiveUserMessage(1001);

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="새 메시지로 이동"]');
    expect(button?.getAttribute("data-slot")).toBe("dashboard-icon-cap");
    expect(button?.className).toContain("dashboard-icon-cap--bare");
    expect(button?.className).toContain("v3-pas-floating-cap");
    expect(button?.textContent).toBe("");
    expect(button?.querySelector("svg")?.getAttribute("stroke-width")).toBeDefined();

    button?.click();
    await flushPassiveEffects();
    expect(container.querySelector('button[aria-label="새 메시지로 이동"]')).toBeNull();
  });

  it("uses the assigned transcript scope while keeping the PAS session selected globally", async () => {
    const scope = createChatSessionStore("assigned-session");

    ({ container, root } = await renderChatView({ storeScope: scope }));

    expect(chatInputMock.activeSessionKey).toBe("assigned-session");
    expect(useDashboardStore.getState().activeSessionKey).toBe("sess-long");
  });

  it.each([
    ["manuscript", "hidden", true, 1],
    ["manuscript", "collapsed", false, 1],
    ["default", "hidden", true, 2],
  ] as const)("preserves the existing row coordinate after %s history prepend (usage %s, context %s)", async (presentation, turnUsageMode, withContext, addedRows) => {
    useDashboardStore.getState().setPersistentSessionDisplaySettings("sess-long", {
      show_generation_separator: true,
      show_jev_candidates: true,
      show_character: true,
      animate_character: true,
      turn_usage_mode: turnUsageMode,
    });
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000), makeAssistantMessage(1001)]);
    ({ container, root } = await renderChatView({ presentation }));
    const before = setFirstVisibleDataIndex(1);
    const beforeFirstIndex = virtuosoMock.props?.firstItemIndex as number;
    const beforeLength = virtuosoData().length;
    const beforePrepended = useDashboardStore.getState().chatPrependedCount;

    flushSync(() => {
      useDashboardStore.getState().processHistoryEvents([
        makeUserMessage(900),
        ...(withContext ? [{ eventId: 901, event: { type: "context_usage", used_tokens: 500, max_tokens: 1000, percent: 50 } as SoulSSEEvent }] : []),
        makeComplete(902),
      ]);
    });
    await flushPassiveEffects();

    expect(useDashboardStore.getState().chatPrependedCount - beforePrepended).toBe(2);
    expect(virtuosoData().length - beforeLength).toBe(addedRows);
    const afterFirstIndex = virtuosoMock.props?.firstItemIndex as number;
    expect(beforeFirstIndex - afterFirstIndex).toBe(addedRows);
    expect(afterFirstIndex + findDataIndexByKey(before.key)).toBe(before.absoluteIndex);
  });

  it.each([
    ["unloaded", null, true],
    ["other session", { sessionId: "other", turnUsageMode: "hidden" }, true],
    ["missing key", { sessionId: "sess-long" }, true],
    ["hidden", { sessionId: "sess-long", turnUsageMode: "hidden" }, false],
  ] as const)("defaults manuscript usage to on for %s", async (_label, settings, expected) => {
    useDashboardStore.setState({ persistentSessionDisplaySettings: settings as any });
    useDashboardStore.getState().processHistoryEvents([
      makeUserMessage(1),
      { eventId: 2, event: { type: "context_usage", used_tokens: 500, max_tokens: 1000, percent: 50 } as SoulSSEEvent },
      makeComplete(3),
      makeUserMessage(4),
      { eventId: 5, event: { type: "context_usage", used_tokens: 600, max_tokens: 1000, percent: 60 } as SoulSSEEvent },
      { eventId: 6, event: { type: "error", message: "실패" } as SoulSSEEvent },
    ]);
    ({ container, root } = await renderChatView({ presentation: "manuscript" }));
    const complete = virtuosoData().find(item => item.type === "single" && item.msg.treeNodeType === "complete");
    const error = virtuosoData().find(item => item.type === "single" && item.msg.treeNodeType === "error");
    expect(Boolean(complete?.msg.turnUsageCaption)).toBe(expected);
    expect(Boolean(error?.msg.turnUsageCaption)).toBe(expected);
  });

  it("keeps unanchored rows visible after a keepalive complete when manuscript usage is off", async () => {
    useDashboardStore.getState().setPersistentSessionDisplaySettings("sess-long", {
      show_generation_separator: true,
      show_jev_candidates: true,
      show_character: true,
      animate_character: true,
      turn_usage_mode: "hidden",
    });
    useDashboardStore.getState().processHistoryEvents([
      { eventId: 1, event: { type: "user_message", input_id: "keepalive", text: "keepalive input", purpose: "cache_keepalive", timestamp: 0 } as SoulSSEEvent },
      { eventId: 2, event: { type: "assistant_message", content: "ok", timestamp: 0 } as SoulSSEEvent },
      { eventId: 3, event: { type: "complete", result: "done", attachments: [], timestamp: 0 } as SoulSSEEvent },
      { eventId: 4, event: { type: "system_message", text: "after keepalive", timestamp: 0 } as SoulSSEEvent },
      { eventId: 5, event: { type: "user_message", input_id: "human", text: "human input", timestamp: 0 } as SoulSSEEvent },
      { eventId: 6, event: { type: "assistant_message", content: "human answer", timestamp: 0 } as SoulSSEEvent },
    ]);
    ({ container, root } = await renderChatView({ presentation: "manuscript" }));

    const visibleMessages = virtuosoData().flatMap((item: any) => (
      item.type === "single" ? [item.msg] : []
    ));
    const visibleContent = visibleMessages.map((message: any) => message.content);
    expect(visibleContent).toContain("after keepalive");
    expect(visibleContent).toContain("human input");
    expect(visibleContent).toContain("human answer");
    expect(visibleContent).not.toContain("keepalive input");
    expect(visibleContent).not.toContain("ok");
  });

  it("shows a human turn after a keepalive without a complete when manuscript usage is off", async () => {
    useDashboardStore.getState().setPersistentSessionDisplaySettings("sess-long", {
      show_generation_separator: true,
      show_jev_candidates: true,
      show_character: true,
      animate_character: true,
      turn_usage_mode: "hidden",
    });
    useDashboardStore.getState().processHistoryEvents([
      { eventId: 1, event: { type: "user_message", input_id: "keepalive", text: "keepalive input", purpose: "cache_keepalive", timestamp: 0 } as SoulSSEEvent },
      { eventId: 2, event: { type: "assistant_message", content: "ok", timestamp: 0 } as SoulSSEEvent },
      { eventId: 3, event: { type: "user_message", input_id: "human", text: "human input", timestamp: 0 } as SoulSSEEvent },
      { eventId: 4, event: { type: "assistant_message", content: "human answer", timestamp: 0 } as SoulSSEEvent },
    ]);
    ({ container, root } = await renderChatView({ presentation: "manuscript" }));

    const visibleMessages = virtuosoData().flatMap((item: any) => (
      item.type === "single" ? [item.msg] : []
    ));
    const visibleContent = visibleMessages.map((message: any) => message.content);
    expect(visibleContent).toContain("human input");
    expect(visibleContent).toContain("human answer");
    expect(visibleContent).not.toContain("keepalive input");
    expect(visibleContent).not.toContain("ok");
  });

  it.each(["manuscript", "default"] as const)("settles a single-pixel bottom gap in %s without changing the default tolerance", async presentation => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1)]);
    ({ container, root } = await renderChatView({ presentation }));
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]')!;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 800 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 399 });
    const nativeScrollTo = vi.fn(() => { scroller.scrollTop = 400; });
    scroller.scrollTo = nativeScrollTo;
    const heightChanged = virtuosoMock.props?.totalListHeightChanged as () => void;
    heightChanged();
    expect(nativeScrollTo).toHaveBeenCalledTimes(presentation === "manuscript" ? 1 : 0);
    expect(scroller.scrollTop).toBe(presentation === "manuscript" ? 400 : 399);
    heightChanged();
    expect(nativeScrollTo).toHaveBeenCalledTimes(presentation === "manuscript" ? 1 : 0);
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

    flushSync(() => {
      const atBottomStateChange = virtuosoMock.props?.atBottomStateChange as
        | ((atBottom: boolean) => void)
        | undefined;
      atBottomStateChange?.(true);
    });
    await flushPassiveEffects();

    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 800 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    virtuosoMock.scrollToIndex.mockClear();
    now = 1000;
    flushSync(() => {
      const atBottomStateChange = virtuosoMock.props?.atBottomStateChange as
        | ((atBottom: boolean) => void)
        | undefined;
      atBottomStateChange?.(false);
    });
    await flushPassiveEffects();
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });

    virtuosoMock.scrollToIndex.mockClear();
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

  it("빈 viewport를 먼저 mount하지 않고 첫 visible page의 최종 좌표로 시작한다", async () => {
    ({ container, root } = await renderChatView());
    expect(container.querySelector('[data-testid="virtuoso"]')).toBeNull();

    flushSync(() => {
      useDashboardStore.getState().processHistoryEvents([
        makeUserMessage(1000),
        makeUserMessage(1001),
      ]);
    });
    await flushPassiveEffects();

    expect(container.querySelector('[data-testid="virtuoso"]')).not.toBeNull();
    expect(virtuosoData()).toHaveLength(2);
    expect(virtuosoMock.props?.firstItemIndex).toBe(9_998);
    expect(virtuosoMock.props?.initialTopMostItemIndex).toEqual({
      index: 1,
      align: "end",
    });
  });

  it("초기 정착 중 명시적 위스크롤은 뒤 history commit의 bottom 이동을 취소한다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    virtuosoMock.scrollToIndex.mockClear();

    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    scroller?.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void) | undefined)?.(false);
    flushSync(() => {
      useDashboardStore.getState().processHistoryEvents([makeUserMessage(900)]);
    });
    await flushPassiveEffects();

    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("follow-off에서 first visible 앞의 live 과거 summary를 anchor stable row 안에 결합한다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeAssistantMessage(1000),
      makeComplete(1001),
      makeUserMessage(1100),
    ]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    virtuosoMock.scrollToIndex.mockClear();

    flushSync(() => {
      markOlderExploration(container);
    });
    await flushPassiveEffects();
    const completeIndex = virtuosoData().findIndex(
      (item) => item.type === "single" && item.msg.treeNodeType === "complete",
    );
    const before = setFirstVisibleDataIndex(completeIndex);
    const beforeFirstItemIndex = virtuosoMock.props?.firstItemIndex as number;

    flushSync(() => {
      useDashboardStore.getState().processEvent(makeTurnSummary(1200, 1000).event, 1200);
    });
    await flushPassiveEffects();

    const afterIndex = findDataIndexByKey(before.key);
    const afterFirstItemIndex = virtuosoMock.props?.firstItemIndex as number;
    expect(afterIndex).toBe(completeIndex);
    expect(afterFirstItemIndex).toBe(beforeFirstItemIndex);
    expect(afterFirstItemIndex + afterIndex).toBe(before.absoluteIndex);
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("first visible 뒤의 live summary는 firstItemIndex를 바꾸지 않는다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeAssistantMessage(1000),
      makeComplete(1001),
      makeUserMessage(1100),
    ]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    virtuosoMock.scrollToIndex.mockClear();
    flushSync(() => {
      markOlderExploration(container);
    });
    await flushPassiveEffects();
    const before = setFirstVisibleDataIndex(0);
    const beforeFirstItemIndex = virtuosoMock.props?.firstItemIndex as number;

    flushSync(() => {
      useDashboardStore.getState().processEvent(makeTurnSummary(1200, 1000).event, 1200);
    });
    await flushPassiveEffects();

    expect(findDataIndexByKey(before.key)).toBe(0);
    expect(virtuosoMock.props?.firstItemIndex).toBe(beforeFirstItemIndex);
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("미로딩 anchor summary는 data와 firstItemIndex를 바꾸지 않는다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1100)]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    virtuosoMock.scrollToIndex.mockClear();
    flushSync(() => {
      markOlderExploration(container);
    });
    await flushPassiveEffects();
    const before = setFirstVisibleDataIndex(0);
    const beforeFirstItemIndex = virtuosoMock.props?.firstItemIndex as number;
    const beforeLength = virtuosoData().length;

    flushSync(() => {
      useDashboardStore.getState().processEvent(makeTurnSummary(1200, 1000).event, 1200);
    });
    await flushPassiveEffects();

    expect(virtuosoData()).toHaveLength(beforeLength);
    expect(itemKeyAt(0)).toBe(before.key);
    expect(virtuosoMock.props?.firstItemIndex).toBe(beforeFirstItemIndex);
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("미로딩 summary의 anchor prepend는 history count만으로 visible 절대 좌표를 보존한다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeUserMessage(1100),
      makeTurnSummary(1200, 1000),
    ]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    virtuosoMock.scrollToIndex.mockClear();
    flushSync(() => {
      markOlderExploration(container);
    });
    await flushPassiveEffects();
    const before = setFirstVisibleDataIndex(0);
    const beforePrependedCount = useDashboardStore.getState().chatPrependedCount;

    now = 1100;
    flushSync(() => {
      useDashboardStore.getState().processHistoryEvents([
        makeAssistantMessage(1000),
        makeComplete(1001),
      ]);
    });
    await flushPassiveEffects();

    const afterIndex = findDataIndexByKey(before.key);
    const added = useDashboardStore.getState().chatPrependedCount - beforePrependedCount;
    expect(added).toBe(2);
    expect(afterIndex).toBe(2);
    expect((virtuosoMock.props?.firstItemIndex as number) + afterIndex).toBe(
      before.absoluteIndex,
    );
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("bottom의 live summary는 bottom을 유지하고 미로딩 summary는 scroll을 일으키지 않는다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeAssistantMessage(1000),
      makeComplete(1001),
      makeUserMessage(1100),
    ]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    virtuosoMock.scrollToIndex.mockClear();

    flushSync(() => {
      useDashboardStore.getState().processEvent(makeTurnSummary(1200, 999).event, 1200);
    });
    await flushPassiveEffects();
    expect(virtuosoData()).toHaveLength(3);
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();

    flushSync(() => {
      useDashboardStore.getState().processEvent(makeTurnSummary(1201, 1000).event, 1201);
    });
    await flushPassiveEffects();
    expect(virtuosoData()).toHaveLength(3);
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });
  });

  it("stable key와 행 수가 같은 streaming delta도 bottom follow를 유지한다", async () => {
    useDashboardStore.getState().processEvent(
      {
        type: "text_start",
        parent_event_id: "0",
        timestamp: 0,
      } as unknown as SoulSSEEvent,
      1000,
    );
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    const beforeLength = virtuosoData().length;
    const beforeKey = itemKeyAt(0);
    virtuosoMock.scrollToIndex.mockClear();

    flushSync(() => {
      useDashboardStore.getState().processEvent(
        {
          type: "text_delta",
          text: "streaming content grew",
          timestamp: 1,
        } as unknown as SoulSSEEvent,
        1001,
      );
    });
    await flushPassiveEffects();

    expect(virtuosoData()).toHaveLength(beforeLength);
    expect(itemKeyAt(0)).toBe(beforeKey);
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });
  });

  it("duplicate reconnect와 reload는 stable key·순서·follow-off 좌표를 바꾸지 않는다", async () => {
    const history = [
      makeAssistantMessage(1000),
      makeComplete(1001),
      makeUserMessage(1100),
      makeTurnSummary(1200, 1000),
    ];
    useDashboardStore.getState().processHistoryEvents(history);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    flushSync(() => {
      markOlderExploration(container);
    });
    await flushPassiveEffects();
    const visible = setFirstVisibleDataIndex(2);
    const beforeKeys = virtuosoData().map((_, index) => itemKeyAt(index));
    const beforeFirstItemIndex = virtuosoMock.props?.firstItemIndex;
    virtuosoMock.scrollToIndex.mockClear();

    flushSync(() => {
      useDashboardStore.getState().processEvent(history[3].event, history[3].eventId);
      useDashboardStore.getState().processHistoryEvents(history);
    });
    await flushPassiveEffects();

    expect(virtuosoData().map((_, index) => itemKeyAt(index))).toEqual(beforeKeys);
    expect(findDataIndexByKey(visible.key)).toBe(2);
    expect(virtuosoMock.props?.firstItemIndex).toBe(beforeFirstItemIndex);
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("자동 reconnect는 같은 세션의 live 논리 삽입 보정을 유지한다", async () => {
    const history = [
      makeAssistantMessage(1000),
      makeComplete(1001),
      makeUserMessage(1100),
    ];
    useDashboardStore.getState().processHistoryEvents(history);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    flushSync(() => {
      markOlderExploration(container);
    });
    await flushPassiveEffects();
    const completeIndex = virtuosoData().findIndex(
      (item) => item.type === "single" && item.msg.treeNodeType === "complete",
    );
    const visible = setFirstVisibleDataIndex(completeIndex);
    flushSync(() => {
      useDashboardStore.getState().processEvent(makeTurnSummary(1200, 1000).event, 1200);
    });
    await flushPassiveEffects();
    const correctedFirstItemIndex = virtuosoMock.props?.firstItemIndex;
    virtuosoMock.scrollToIndex.mockClear();

    flushSync(() => {
      useDashboardStore.getState().processHistoryEvents([
        ...history,
        makeTurnSummary(1200, 1000),
      ]);
    });
    await flushPassiveEffects();

    expect(virtuosoMock.props?.firstItemIndex).toBe(correctedFirstItemIndex);
    expect(findDataIndexByKey(visible.key)).toBe(completeIndex);
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("수동 clearTree 뒤 같은 세션 reconnect는 이전 논리 삽입 보정을 버린다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeAssistantMessage(1000),
      makeComplete(1001),
      makeUserMessage(1100),
    ]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    flushSync(() => {
      markOlderExploration(container);
    });
    await flushPassiveEffects();
    const completeIndex = virtuosoData().findIndex(
      (item) => item.type === "single" && item.msg.treeNodeType === "complete",
    );
    setFirstVisibleDataIndex(completeIndex);
    flushSync(() => {
      useDashboardStore.getState().processEvent(makeTurnSummary(1200, 1000).event, 1200);
    });
    await flushPassiveEffects();

    flushSync(() => {
      useDashboardStore.getState().clearTree();
    });
    expect(useDashboardStore.getState().tree).toBeNull();
    // clearTree의 empty-data 렌더를 지난 뒤 같은 ChatView instance에 reconnect한다.
    // 빈 상태에서는 Virtuoso가 unmount되므로 remount 좌표가 훅 reset의 증거다.
    flushSync(() => {
      root?.render(createElement(ChatView));
    });
    await flushPassiveEffects();

    flushSync(() => {
      useDashboardStore.getState().processHistoryEvents([
        makeAssistantMessage(2000),
        makeComplete(2001),
        makeUserMessage(2100),
      ]);
    });
    await flushPassiveEffects();

    const prependedCount = useDashboardStore.getState().chatPrependedCount;
    expect(virtuosoMock.props?.firstItemIndex).toBe(10_000 - prependedCount);
    expect(virtuosoData().map((_, index) => itemKeyAt(index))).toEqual([
      "asst-msg-2000",
      "complete-2001",
      "user-msg-2100",
    ]);
  });

  it("session switch는 이전 세션의 논리 삽입 보정과 key를 재사용하지 않는다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeAssistantMessage(1000),
      makeComplete(1001),
      makeUserMessage(1100),
    ]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    flushSync(() => {
      markOlderExploration(container);
    });
    await flushPassiveEffects();
    setFirstVisibleDataIndex(1);
    flushSync(() => {
      useDashboardStore.getState().processEvent(makeTurnSummary(1200, 1000).event, 1200);
    });
    await flushPassiveEffects();
    expect(virtuosoMock.props?.firstItemIndex).toBe(9_997);

    flushSync(() => {
      useDashboardStore.getState().setActiveSession("sess-other");
      useDashboardStore.getState().processHistoryEvents([makeUserMessage(2000)]);
    });
    await flushPassiveEffects();

    expect(virtuosoMock.props?.firstItemIndex).toBe(9_999);
    expect(virtuosoData().map((_, index) => itemKeyAt(index))).toEqual([
      "user-msg-2000",
    ]);
  });

  it.each([
    ["error", "0행", false],
    ["error", "1행", true],
  ] as const)("%s %s 상태에 이전 대화 수동 재시도 어포던스를 노출한다", async (reason, _label, withRow) => {
    virtuosoMock.blockedReason = reason;
    if (withRow) {
      useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    }

    ({ container, root } = await renderChatView());
    const virtuoso = container.querySelector('[data-testid="virtuoso"]');
    if (withRow) expect(virtuoso).not.toBeNull();
    else expect(virtuoso).toBeNull();
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("이전 대화를 불러오지 못했습니다. 다시 시도"),
    );
    expect(button).toBeDefined();

    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("manual");
  });

  it("0행·추가 cursor는 버튼 없이 자동으로 이어 받는다", async () => {
    virtuosoMock.canLoadOlder = true;
    ({ container, root } = await renderChatView());
    expect(container.querySelector('[data-testid="virtuoso"]')).toBeNull();
    expect(container.textContent).not.toContain("이전 대화 더 불러오기");
    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("automatic");
  });

  it("화면 미충족 첫 행의 startReached는 입력 없이 자동 채움을 연다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]')!;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 600 });
    (virtuosoMock.props?.startReached as (() => void))();
    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("automatic");
    expect(container.textContent).not.toContain("이전 대화 더 불러오기");
  });

  it("위 입력 뒤 실제 scroll 도착을 계속 판단하여 추가 입력 없이 이어 받는다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]')!;
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 900 });
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -200 }));
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();
    scroller.scrollTop = 700;
    scroller.dispatchEvent(new Event("scroll"));
    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("automatic");
    virtuosoMock.requestOlder.mockClear();
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("automatic");
  });

  it("follow-on short list의 오류 재시도는 prepend 높이 변경과 bottom 보정이 경쟁하지 않는다", async () => {
    virtuosoMock.blockedReason = "error";
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 800 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });
    const nativeScrollTo = vi.fn();
    scroller.scrollTo = nativeScrollTo;
    virtuosoMock.scrollToIndex.mockClear();
    virtuosoMock.requestOlder.mockClear();
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("이전 대화를 불러오지 못했습니다. 다시 시도"),
    );

    flushSync(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    flushSync(() => {
      useDashboardStore.getState().processHistoryEvents([makeUserMessage(900)]);
    });
    await flushPassiveEffects();
    (virtuosoMock.props?.itemsRendered as (() => void) | undefined)?.();
    (virtuosoMock.props?.totalListHeightChanged as (() => void) | undefined)?.();

    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("manual");
    expect(virtuosoMock.props?.followOutput).toBe(false);
    expect(nativeScrollTo).not.toHaveBeenCalled();
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("0행에는 Virtuoso를 mount하지 않고 Waiting 상태를 표시한다", async () => {
    ({ container, root } = await renderChatView());

    expect(container.querySelector('[data-testid="virtuoso"]')).toBeNull();
    expect(container.textContent).toContain("Waiting for events...");
    expect(virtuosoMock.notifyViewportGeometry).toHaveBeenCalled();
  });

  it("채워진 화면의 mount-time startReached는 요청 없이 실제 위스크롤을 기다린다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    expect(virtuosoMock.notifyViewportGeometry).toHaveBeenCalled();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 800 });
    const nativeScrollTo = vi.fn();
    scroller.scrollTo = nativeScrollTo;

    virtuosoMock.notifyViewportGeometry.mockClear();
    virtuosoMock.scrollToIndex.mockClear();
    (virtuosoMock.props?.itemsRendered as (() => void) | undefined)?.();
    (virtuosoMock.props?.totalListHeightChanged as (() => void) | undefined)?.();
    expect(virtuosoMock.notifyViewportGeometry).toHaveBeenCalledTimes(2);
    expect(nativeScrollTo).toHaveBeenCalledWith({ top: 800, behavior: "auto" });
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();

    (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void) | undefined)?.(true);
    (virtuosoMock.props?.startReached as (() => void) | undefined)?.();
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();

    scroller.dispatchEvent(new Event("scroll"));
    (virtuosoMock.props?.startReached as (() => void) | undefined)?.();
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();

    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("automatic");
    nativeScrollTo.mockClear();
    (virtuosoMock.props?.totalListHeightChanged as (() => void) | undefined)?.();
    expect(nativeScrollTo).not.toHaveBeenCalled();
  });

  it("스크롤바의 실제 위쪽 이동만 탐색 의도로 인정한다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    virtuosoMock.requestOlder.mockClear();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 900,
    });

    scroller.dispatchEvent(new Event("scroll"));
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();

    scroller.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("automatic");
  });

  it("같은 세션에서 scroller가 unmount되면 남아 있던 위쪽 탐색 의도를 버린다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    virtuosoMock.requestOlder.mockClear();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 900,
    });

    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();

    const setScrollerRef = virtuosoMock.props?.scrollerRef as
      | ((ref: HTMLDivElement | null) => void)
      | undefined;
    setScrollerRef?.(null);
    (virtuosoMock.props?.startReached as (() => void) | undefined)?.();

    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();
  });

  it("Follow를 다시 켜면 남아 있던 위쪽 탐색 의도를 버린다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    virtuosoMock.requestOlder.mockClear();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 900,
    });

    flushSync(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    });
    expect(virtuosoMock.props?.followOutput).toBe(false);
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();
    const followButton = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("Follow"),
    );
    flushSync(() => {
      followButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushPassiveEffects();

    scroller.scrollTop = 0;
    (virtuosoMock.props?.startReached as (() => void) | undefined)?.();
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();
    expect(virtuosoMock.props?.followOutput).toBeTypeOf("function");
    expect(
      (virtuosoMock.props?.followOutput as (() => "auto" | false) | undefined)?.(),
    ).toBe("auto");
  });

  it("자식 control의 키와 pointer 입력을 history 탐색으로 오인하지 않는다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    virtuosoMock.requestOlder.mockClear();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 900,
    });
    const button = document.createElement("button");
    scroller.appendChild(button);

    button.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "Home",
    }));
    button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));

    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();
    expect(
      (virtuosoMock.props?.followOutput as (() => "auto" | false) | undefined)?.(),
    ).toBe("auto");
  });

  it("위쪽 입력을 소비할 수 있는 중첩 scroller를 outer history 탐색으로 오인하지 않는다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    virtuosoMock.requestOlder.mockClear();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    const nestedScroller = document.createElement("div");
    nestedScroller.style.overflowY = "auto";
    Object.defineProperty(nestedScroller, "scrollHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(nestedScroller, "clientHeight", {
      configurable: true,
      value: 100,
    });
    Object.defineProperty(nestedScroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 50,
    });
    const nestedContent = document.createElement("div");
    nestedScroller.appendChild(nestedContent);
    scroller.appendChild(nestedScroller);

    nestedContent.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      deltaY: -40,
    }));
    const touchStart = new Event("touchstart", { bubbles: true });
    const touchMove = new Event("touchmove", { bubbles: true });
    Object.defineProperty(touchStart, "touches", { value: [{ clientY: 100 }] });
    Object.defineProperty(touchMove, "touches", { value: [{ clientY: 120 }] });
    nestedContent.dispatchEvent(touchStart);
    nestedContent.dispatchEvent(touchMove);

    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();
    expect(
      (virtuosoMock.props?.followOutput as (() => "auto" | false) | undefined)?.(),
    ).toBe("auto");

    nestedScroller.scrollTop = 0;
    nestedContent.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      deltaY: -40,
    }));
    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("automatic");
  });

  it.each(["ArrowUp", "PageUp", "Home"])(
    "%s 키의 위쪽 탐색 의도로 이전 대화를 요청한다",
    async (key) => {
      useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
      ({ container, root } = await renderChatView());
      virtuosoMock.requestOlder.mockClear();
      const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');

      scroller?.dispatchEvent(new KeyboardEvent("keydown", { key }));

      expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("automatic");
    },
  );

  it("아래로 끄는 touch 탐색 의도로 이전 대화를 요청한다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    ({ container, root } = await renderChatView());
    virtuosoMock.requestOlder.mockClear();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    const touchStart = new Event("touchstart");
    const touchMove = new Event("touchmove");
    Object.defineProperty(touchStart, "touches", { value: [{ clientY: 100 }] });
    Object.defineProperty(touchMove, "touches", { value: [{ clientY: 120 }] });

    scroller?.dispatchEvent(touchStart);
    scroller?.dispatchEvent(touchMove);

    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("automatic");
  });

  it("검색 focus 이동은 follow와 bottom 보정을 끄고 과거 행에 머문다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeUserMessage(1000),
      makeAssistantMessage(1001),
      makeUserMessage(1002),
    ]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void))?.(true);
    });
    await flushPassiveEffects();
    virtuosoMock.scrollToIndex.mockClear();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 800 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 400,
    });
    const nativeScrollTo = vi.fn();
    scroller.scrollTo = nativeScrollTo;
    const targetDataIndex = findDataIndexByKey("user-msg-1000");
    flushSync(() => {
      useDashboardStore.getState().setFocusEventId(1000);
    });
    await flushPassiveEffects();

    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({
      index: targetDataIndex,
      align: "center",
    });
    expect(virtuosoMock.props?.followOutput).toBe(false);

    (virtuosoMock.props?.atBottomStateChange as ((value: boolean) => void) | undefined)?.(false);
    (virtuosoMock.props?.itemsRendered as (() => void) | undefined)?.();
    (virtuosoMock.props?.totalListHeightChanged as (() => void) | undefined)?.();

    // The explicit request scrolls once; itemsRendered resolves its stable row key.
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(nativeScrollTo).not.toHaveBeenCalled();
  });

  it("이전 검색 이벤트의 highlight timeout은 새 검색 focus를 지우지 않는다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(42)]);
    useDashboardStore.getState().setFocusEventId(42, "sess-long");
    ({ container, root } = await renderChatView());
    const previousTarget = container.querySelector<HTMLElement>(
      '[data-chat-item-key="user-msg-42"] [data-tree-node-id]',
    );
    if (!previousTarget) throw new Error("검색 대상 chat row가 없습니다.");

    vi.useFakeTimers();
    try {
      const itemsRendered = virtuosoMock.props?.itemsRendered as (() => void) | undefined;
      if (!itemsRendered) throw new Error("Virtuoso itemsRendered callback이 없습니다.");
      flushSync(() => itemsRendered());
      expect(previousTarget.classList.contains("chat-focus-ring")).toBe(true);

      flushSync(() => {
        useDashboardStore.getState().setFocusEventId(7, "sess-long");
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(useDashboardStore.getState().focusEventId).toBe(7);
      expect(useDashboardStore.getState().focusEventSessionId).toBe("sess-long");
      expect(previousTarget.classList.contains("chat-focus-ring")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("같은 이벤트 재선택은 이전 highlight timer가 focus와 ring을 지우지 않는다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeUserMessage(7),
      makeUserMessage(42),
    ]);
    useDashboardStore.getState().setFocusEventId(7, "sess-long");
    ({ container, root } = await renderChatView());
    const eventSeven = container.querySelector<HTMLElement>(
      '[data-chat-item-key="user-msg-7"] [data-tree-node-id]',
    );
    const eventFortyTwo = container.querySelector<HTMLElement>(
      '[data-chat-item-key="user-msg-42"] [data-tree-node-id]',
    );
    if (!eventSeven || !eventFortyTwo) throw new Error("검색 대상 chat row가 없습니다.");

    vi.useFakeTimers();
    try {
      const renderItems = () => {
        const callback = virtuosoMock.props?.itemsRendered as (() => void) | undefined;
        if (!callback) throw new Error("Virtuoso itemsRendered callback이 없습니다.");
        flushSync(() => callback());
      };
      renderItems();
      expect(eventSeven.classList.contains("chat-focus-ring")).toBe(true);

      await vi.advanceTimersByTimeAsync(500);
      flushSync(() => useDashboardStore.getState().setFocusEventId(42, "sess-long"));
      renderItems();
      expect(eventFortyTwo.classList.contains("chat-focus-ring")).toBe(true);

      await vi.advanceTimersByTimeAsync(500);
      flushSync(() => useDashboardStore.getState().setFocusEventId(7, "sess-long"));
      renderItems();
      expect(eventSeven.classList.contains("chat-focus-ring")).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(useDashboardStore.getState().focusEventId).toBe(7);
      expect(eventSeven.classList.contains("chat-focus-ring")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("검색 focus는 현재 기록에 없는 이벤트를 찾을 때까지 과거 페이지를 불러온다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeUserMessage(1000),
      makeAssistantMessage(1001),
    ]);
    virtuosoMock.canLoadOlder = true;
    ({ container, root } = await renderChatView());
    virtuosoMock.scrollToIndex.mockClear();

    flushSync(() => {
      useDashboardStore.getState().setFocusEventId(42);
    });
    await flushPassiveEffects();
    expect(virtuosoMock.requestOlder).toHaveBeenCalledWith("manual");
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();

    flushSync(() => {
      useDashboardStore.getState().processHistoryEvents([makeUserMessage(900)]);
    });
    await flushPassiveEffects();
    expect(virtuosoMock.requestOlder).toHaveBeenCalledTimes(2);

    flushSync(() => {
      useDashboardStore.getState().processHistoryEvents([makeUserMessage(42)]);
    });
    await flushPassiveEffects();

    const targetIndex = findDataIndexByKey("user-msg-42");
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({
      index: targetIndex,
      align: "center",
    });
    expect(virtuosoMock.requestOlder).toHaveBeenCalledTimes(2);
  });

  it("검색 focus 이벤트가 대화 기록에 없으면 기록 끝에서 명시적으로 알린다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    virtuosoMock.reachedTop = true;
    ({ container, root } = await renderChatView());

    flushSync(() => {
      useDashboardStore.getState().setFocusEventId(42);
    });
    await flushPassiveEffects();

    expect(container?.querySelector('[role="alert"]')?.textContent)
      .toContain("검색 결과 이벤트를 대화에서 찾을 수 없습니다");
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();
  });

  it("검색 focus는 자동으로 과거 페이지를 제한된 수만큼 요청한다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(1000)]);
    virtuosoMock.canLoadOlder = true;
    ({ container, root } = await renderChatView());

    flushSync(() => useDashboardStore.getState().setFocusEventId(42, "sess-long"));
    await flushPassiveEffects();
    expect(virtuosoMock.requestOlder).toHaveBeenCalledTimes(1);

    for (let pageIndex = 1; pageIndex < MAX_SEARCH_FOCUS_HISTORY_PAGES; pageIndex += 1) {
      flushSync(() => {
        useDashboardStore.getState().processHistoryEvents([
          makeUserMessage(1000 - pageIndex * 100),
        ]);
      });
      await flushPassiveEffects();
    }
    expect(virtuosoMock.requestOlder).toHaveBeenCalledTimes(MAX_SEARCH_FOCUS_HISTORY_PAGES);

    flushSync(() => useDashboardStore.getState().processHistoryEvents([makeUserMessage(400)]));
    await flushPassiveEffects();

    expect(virtuosoMock.requestOlder).toHaveBeenCalledTimes(MAX_SEARCH_FOCUS_HISTORY_PAGES);
    expect(container?.querySelector('[role="alert"]')?.textContent)
      .toContain(`${MAX_SEARCH_FOCUS_HISTORY_PAGES}페이지`);
  });

  it("검색 focus 이동은 아직 소비되지 않은 history 탐색 의도를 취소한다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeUserMessage(1000),
      makeAssistantMessage(1001),
      makeUserMessage(1002),
    ]);
    ({ container, root } = await renderChatView());
    virtuosoMock.requestOlder.mockClear();
    const scroller = container.querySelector<HTMLElement>('[data-testid="virtuoso"]');
    if (!scroller) throw new Error("Virtuoso scroller mock이 없습니다.");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 900,
    });

    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();
    flushSync(() => {
      useDashboardStore.getState().setFocusEventId(1000);
    });
    await flushPassiveEffects();

    scroller.scrollTop = 0;
    (virtuosoMock.props?.startReached as (() => void) | undefined)?.();
    expect(virtuosoMock.requestOlder).not.toHaveBeenCalled();
  });

  it("같은 검색 focus 요청은 새 트리 이벤트가 와도 한 번만 스크롤한다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeUserMessage(1000),
      makeAssistantMessage(1001),
    ]);
    ({ container, root } = await renderChatView());
    virtuosoMock.scrollToIndex.mockClear();

    flushSync(() => {
      useDashboardStore.getState().setFocusEventId(1000, "sess-long");
    });
    await flushPassiveEffects();
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledTimes(1);

    flushSync(() => {
      useDashboardStore.getState().processEvent(makeAssistantMessage(1002).event, 1002);
    });
    await flushPassiveEffects();

    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it("DOM 행을 찾지 못한 포커스 요청은 재시도가 끝나면 해제한다", async () => {
    useDashboardStore.getState().processHistoryEvents([makeUserMessage(42)]);
    ({ container, root } = await renderChatView());
    flushSync(() => {
      useDashboardStore.getState().setFocusEventId(42, "sess-long");
    });
    await flushPassiveEffects();

    const targetRow = container.querySelector<HTMLElement>(
      '[data-chat-item-key="user-msg-42"]',
    );
    expect(targetRow).not.toBeNull();
    targetRow?.remove();

    let frameId = 0;
    const pendingFrames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      frameId += 1;
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const flushFrames = () => {
      while (pendingFrames.length > 0) {
        const frames = pendingFrames.splice(0);
        flushSync(() => frames.forEach((callback) => callback(0)));
      }
    };

    const itemsRendered = virtuosoMock.props?.itemsRendered as (() => void) | undefined;
    if (!itemsRendered) throw new Error("Virtuoso itemsRendered callback이 없습니다.");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      flushSync(() => itemsRendered());
      flushFrames();
    }

    expect(useDashboardStore.getState().focusEventId).toBeNull();
  });

  it("도구 그룹의 두 번째 메시지도 Virtuoso 행 key로 찾아 하이라이트한다", async () => {
    useDashboardStore.getState().processHistoryEvents([
      makeToolStart(10),
      makeToolStart(11),
    ]);
    useDashboardStore.getState().setFocusEventId(11, "sess-long");
    ({ container, root } = await renderChatView());

    const targetRow = container.querySelector<HTMLElement>(
      '[data-chat-item-key="tg-tool-11"]',
    );
    const targetMessage = targetRow?.querySelector<HTMLElement>("[data-tree-node-id]");
    if (!targetMessage) throw new Error("도구 그룹 chat row가 없습니다.");
    const itemsRendered = virtuosoMock.props?.itemsRendered as (() => void) | undefined;
    if (!itemsRendered) throw new Error("Virtuoso itemsRendered callback이 없습니다.");

    flushSync(() => itemsRendered());

    expect(targetMessage.classList.contains("chat-focus-ring")).toBe(true);
  });
});
