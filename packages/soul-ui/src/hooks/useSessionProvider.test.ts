/**
 * @vitest-environment jsdom
 */

import { act, createElement, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionProvider } from "./useSessionProvider";
import { useDashboardStore } from "../stores/dashboard-store";
import type {
  EventTreeNode,
  SoulSSEEvent,
} from "../shared/types";
import type {
  FetchSessionsOptions,
  SessionListResult,
  SessionStorageProvider,
} from "../providers/types";
import { DetailCursorStore } from "../providers/detail-cursor-store";
import { useMessageHistoryBuffer } from "../components/chat/useMessageHistoryBuffer";

class FakeSessionProvider implements SessionStorageProvider {
  readonly detailCursorStore = new DetailCursorStore();
  subscribeCalls: Array<{
    sessionKey: string;
    options?: { lastEventId?: number; getLastEventId?: () => number };
  }> = [];
  unsubscribeCount = 0;
  onEvent: ((event: SoulSSEEvent, eventId: number) => void) | null = null;

  async fetchSessions(_options?: FetchSessionsOptions): Promise<SessionListResult> {
    return { sessions: [], total: 0, hasMore: false };
  }

  async fetchFolderCounts(): Promise<Record<string, number>> {
    return {};
  }

  async fetchCards(_sessionKey: string): Promise<EventTreeNode[]> {
    return [];
  }

  subscribe(
    sessionKey: string,
    onEvent: (event: SoulSSEEvent, eventId: number) => void,
    onStatusChange?: (status: "connecting" | "connected" | "error") => void,
    options?: { lastEventId?: number; getLastEventId?: () => number },
  ): () => void {
    this.subscribeCalls.push({ sessionKey, options });
    this.onEvent = onEvent;
    onStatusChange?.("connected");
    return () => {
      this.unsubscribeCount += 1;
    };
  }

  emit(event: SoulSSEEvent, eventId: number): void {
    this.onEvent?.(event, eventId);
  }
}

function SessionProviderProbe({
  provider,
  active = true,
  sessionKey = "sess-1",
  onValue,
}: {
  provider: SessionStorageProvider;
  active?: boolean;
  sessionKey?: string;
  onValue?: (value: ReturnType<typeof useSessionProvider>) => void;
}) {
  const value = useSessionProvider({
    sessionKey,
    getSessionProvider: () => provider,
    active,
    cursorScope: "https://dashboard.test|alice",
  });
  onValue?.(value);
  return null;
}

function SessionProviderWithHistoryProbe({
  provider,
  sessionKey,
}: {
  provider: SessionStorageProvider;
  sessionKey: string;
}) {
  const scrollerRef = useRef<HTMLElement | null>(null);
  const detail = useSessionProvider({
    sessionKey,
    getSessionProvider: () => provider,
    cursorScope: "https://dashboard.test|alice",
  });
  useMessageHistoryBuffer(
    sessionKey,
    scrollerRef,
    detail.synchronizedSessionKey === sessionKey,
  );
  return null;
}

function timelinePage(eventId: number, text: string): Response {
  return new Response(JSON.stringify({
    messages: [{
      id: eventId,
      parent_event_id: null,
      event_type: "user_message",
      payload: { type: "user_message", text },
      created_at: new Date(eventId * 1_000).toISOString(),
    }],
    next_cursor: null,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const defaultProcessEvents = useDashboardStore.getState().processEvents;
const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("useSessionProvider", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    useDashboardStore.getState().reset();
    useDashboardStore.getState().setActiveSession("sess-1");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    useDashboardStore.setState({ processEvents: defaultProcessEvents });
    vi.restoreAllMocks();
  });

  it("does not resubscribe when the active session status changes from completed to running", async () => {
    const provider = new FakeSessionProvider();

    flushSync(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(SessionProviderProbe, { provider }),
        ),
      );
    });
    await Promise.resolve();

    expect(provider.subscribeCalls).toHaveLength(1);
    expect(provider.unsubscribeCount).toBe(0);

    flushSync(() => {
      useDashboardStore.getState().setActiveSessionSummary({
        agentSessionId: "sess-1",
        status: "completed",
        sessionType: "claude",
        eventCount: 0,
        createdAt: "2026-05-23T00:00:00.000Z",
      });
    });
    await Promise.resolve();

    flushSync(() => {
      useDashboardStore.getState().setActiveSessionSummary({
        agentSessionId: "sess-1",
        status: "running",
        sessionType: "claude",
        eventCount: 0,
        createdAt: "2026-05-23T00:00:00.000Z",
      });
    });
    await Promise.resolve();

    expect(provider.subscribeCalls).toHaveLength(1);
    expect(provider.unsubscribeCount).toBe(0);
  });

  it("keeps completed lifecycle state when chat catch-up replays an earlier running turn", async () => {
    const provider = new FakeSessionProvider();
    const completed = {
      agentSessionId: "sess-1",
      status: "completed" as const,
      sessionType: "claude" as const,
      eventCount: 4,
      createdAt: "2026-05-23T00:00:00.000Z",
      reviewState: "needs_review" as const,
    };
    const queryKey = ["sessions", "all", "feed", null] as const;
    queryClient.setQueryData(queryKey, {
      pages: [{ sessions: [completed], total: 1 }],
      pageParams: [0],
    });
    useDashboardStore.getState().setActiveSessionSummary(completed);

    flushSync(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(SessionProviderProbe, { provider }),
        ),
      );
    });
    await Promise.resolve();

    provider.emit({
      type: "history_sync",
      last_event_id: 41,
      is_live: true,
      status: "completed",
    } as SoulSSEEvent, 0);
    provider.emit({
      type: "user_message",
      user: "director",
      text: "earlier turn",
    } as SoulSSEEvent, 41);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const cached = queryClient.getQueryData<{
      pages: Array<{ sessions: Array<typeof completed> }>;
    }>(queryKey);
    expect(cached?.pages[0].sessions[0]).toMatchObject({
      status: "completed",
      reviewState: "needs_review",
    });
    expect(useDashboardStore.getState().activeSessionSummary).toMatchObject({
      status: "completed",
      reviewState: "needs_review",
    });
  });

  it("commits a durable cursor only after its queued chunk is processed", async () => {
    vi.useFakeTimers();
    const provider = new FakeSessionProvider();
    flushSync(() => {
      root.render(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SessionProviderProbe, { provider }),
      ));
    });
    await Promise.resolve();

    provider.emit({ type: "user_message", text: "hello" } as SoulSSEEvent, 12);
    expect(provider.detailCursorStore.get("https://dashboard.test|alice", "sess-1")).toBe(0);

    await vi.advanceTimersByTimeAsync(50);
    expect(provider.detailCursorStore.get("https://dashboard.test|alice", "sess-1")).toBe(12);
    expect(provider.subscribeCalls[0].options?.getLastEventId?.()).toBe(12);
    vi.useRealTimers();
  });

  it("abandons a failed connection generation and replays from the committed cursor", async () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    const provider = new FakeSessionProvider();
    let shouldThrow = true;
    useDashboardStore.setState({
      processEvents: (events) => {
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error("injected processor failure");
        }
        defaultProcessEvents(events);
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    flushSync(() => {
      root.render(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SessionProviderProbe, { provider }),
      ));
    });
    await Promise.resolve();
    const failedConnection = provider.onEvent;

    provider.emit({ type: "user_message", text: "must replay" } as SoulSSEEvent, 12);
    await vi.advanceTimersByTimeAsync(50);

    // A live event racing behind the failed batch belongs to the abandoned
    // generation and must not advance the durable cursor.
    failedConnection?.({ type: "user_message", text: "raced live" } as SoulSSEEvent, 13);
    await vi.advanceTimersByTimeAsync(50);

    // Processor failures use a separate retry backoff so a deterministic
    // poison replay cannot spin physical connections in a tight loop.
    expect(provider.unsubscribeCount).toBe(0);
    expect(provider.subscribeCalls).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });

    expect(provider.unsubscribeCount).toBe(1);
    expect(provider.subscribeCalls).toHaveLength(2);
    expect(provider.subscribeCalls[1].options?.lastEventId).toBe(0);
    expect(provider.detailCursorStore.get("https://dashboard.test|alice", "sess-1")).toBe(0);

    provider.emit({ type: "user_message", text: "must replay" } as SoulSSEEvent, 12);
    provider.emit({ type: "user_message", text: "raced live" } as SoulSSEEvent, 13);
    await vi.advanceTimersByTimeAsync(50);

    expect(provider.detailCursorStore.get("https://dashboard.test|alice", "sess-1")).toBe(13);
    expect(useDashboardStore.getState().tree?.children.map((node) => node.content)).toEqual([
      "must replay",
      "raced live",
    ]);
    vi.useRealTimers();
  });

  it("suspends and resumes the same session without discarding its committed cursor", async () => {
    const provider = new FakeSessionProvider();
    provider.detailCursorStore.commit("https://dashboard.test|alice", "sess-1", 21);

    flushSync(() => {
      root.render(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SessionProviderProbe, { provider, active: true }),
      ));
    });
    await Promise.resolve();
    expect(provider.subscribeCalls[0].options?.lastEventId).toBe(21);

    flushSync(() => {
      root.render(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SessionProviderProbe, { provider, active: false }),
      ));
    });
    expect(provider.unsubscribeCount).toBe(1);

    flushSync(() => {
      root.render(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SessionProviderProbe, { provider, active: true }),
      ));
    });
    expect(provider.subscribeCalls).toHaveLength(2);
    expect(provider.subscribeCalls[1].options?.lastEventId).toBe(21);
  });

  it("hydrates A, B, then A from REST even when each detail stream resumes a cached cursor", async () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    const provider = new FakeSessionProvider();
    provider.detailCursorStore.commit("https://dashboard.test|alice", "sess-a", 10);
    provider.detailCursorStore.commit("https://dashboard.test|alice", "sess-b", 20);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(timelinePage(101, "A first hydration"))
      .mockResolvedValueOnce(timelinePage(201, "B hydration"))
      .mockResolvedValueOnce(timelinePage(102, "A return hydration"));
    vi.stubGlobal("fetch", fetchMock);

    const renderSession = async (sessionKey: string) => {
      await act(async () => {
        useDashboardStore.getState().setActiveSession(sessionKey);
        root.render(createElement(SessionProviderWithHistoryProbe, { provider, sessionKey }));
        await Promise.resolve();
      });
    };
    const synchronize = async (lastEventId: number) => {
      await act(async () => {
        provider.emit({
          type: "history_sync",
          last_event_id: lastEventId,
          is_live: true,
        } as SoulSSEEvent, 0);
        await vi.advanceTimersByTimeAsync(50);
        await Promise.resolve();
      });
    };

    await renderSession("sess-a");
    await synchronize(10);
    expect(useDashboardStore.getState().tree?.children.map((node) => node.content)).toEqual([
      "A first hydration",
    ]);

    await renderSession("sess-b");
    await synchronize(20);
    expect(useDashboardStore.getState().tree?.children.map((node) => node.content)).toEqual([
      "B hydration",
    ]);

    await renderSession("sess-a");
    await synchronize(10);
    expect(provider.subscribeCalls.map((call) => call.options?.lastEventId)).toEqual([10, 20, 10]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(useDashboardStore.getState().tree?.children.map((node) => node.content)).toEqual([
      "A return hydration",
    ]);
    vi.useRealTimers();
  });

  it("rehydrates the REST timeline after the detail owner unmounts and reopens with a cached cursor", async () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    const provider = new FakeSessionProvider();
    provider.detailCursorStore.commit("https://dashboard.test|alice", "sess-a", 30);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(timelinePage(301, "first mount"))
      .mockResolvedValueOnce(timelinePage(302, "reopened mount"));
    vi.stubGlobal("fetch", fetchMock);

    const renderAndSynchronize = async () => {
      await act(async () => {
        useDashboardStore.getState().setActiveSession("sess-a");
        root.render(createElement(SessionProviderWithHistoryProbe, {
          provider,
          sessionKey: "sess-a",
        }));
        await Promise.resolve();
      });
      await act(async () => {
        provider.emit({
          type: "history_sync",
          last_event_id: 30,
          is_live: true,
        } as SoulSSEEvent, 0);
        await vi.advanceTimersByTimeAsync(50);
        await Promise.resolve();
      });
    };

    await renderAndSynchronize();
    expect(useDashboardStore.getState().tree?.children.map((node) => node.content)).toEqual([
      "first mount",
    ]);

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderAndSynchronize();

    expect(provider.subscribeCalls.map((call) => call.options?.lastEventId)).toEqual([30, 30]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useDashboardStore.getState().tree?.children.map((node) => node.content)).toEqual([
      "reopened mount",
    ]);
    vi.useRealTimers();
  });

  it("reconnects from the committed cursor without clearing the rendered tree", async () => {
    vi.useFakeTimers();
    const provider = new FakeSessionProvider();
    let latest: ReturnType<typeof useSessionProvider> | undefined;
    flushSync(() => {
      root.render(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SessionProviderProbe, {
          provider,
          onValue: (value) => { latest = value; },
        }),
      ));
    });
    await Promise.resolve();
    provider.emit({ type: "user_message", text: "keep me" } as SoulSSEEvent, 24);
    await vi.advanceTimersByTimeAsync(50);
    const treeBeforeReconnect = useDashboardStore.getState().tree;
    expect(treeBeforeReconnect).not.toBeNull();

    flushSync(() => latest?.reconnect());

    expect(provider.unsubscribeCount).toBe(1);
    expect(provider.subscribeCalls).toHaveLength(2);
    expect(provider.subscribeCalls[1].options?.lastEventId).toBe(24);
    expect(useDashboardStore.getState().tree).toBe(treeBeforeReconnect);
  });

  it("unblocks history after the committed history_sync marker is processed", async () => {
    vi.useFakeTimers();
    const provider = new FakeSessionProvider();
    let latest: ReturnType<typeof useSessionProvider> | undefined;
    flushSync(() => {
      root.render(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SessionProviderProbe, {
          provider,
          onValue: (value) => { latest = value; },
        }),
      ));
    });
    await Promise.resolve();
    expect(latest?.synchronizedSessionKey).toBeNull();

    provider.emit({
      type: "history_sync",
      last_event_id: 31,
      is_live: true,
    } as SoulSSEEvent, 0);
    await vi.advanceTimersByTimeAsync(50);

    expect(latest?.synchronizedSessionKey).toBe("sess-1");
    expect(provider.detailCursorStore.get("https://dashboard.test|alice", "sess-1")).toBe(31);
    vi.useRealTimers();
  });

  it("discards partial replay and requests a durable refetch on history reset", async () => {
    vi.useFakeTimers();
    const provider = new FakeSessionProvider();
    let latest: ReturnType<typeof useSessionProvider> | undefined;
    flushSync(() => {
      root.render(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SessionProviderProbe, {
          provider,
          onValue: (value) => { latest = value; },
        }),
      ));
    });
    await Promise.resolve();

    provider.emit({ type: "user_message", text: "stale replay" } as SoulSSEEvent, 32);
    provider.emit({
      type: "history_sync",
      last_event_id: 40,
      is_live: true,
      reset_required: true,
      reset_reason: "history_gap",
    }, 0);
    provider.emit({ type: "user_message", text: "fresh live" } as SoulSSEEvent, 41);
    await vi.advanceTimersByTimeAsync(50);

    expect(useDashboardStore.getState().tree?.children).toHaveLength(1);
    expect(useDashboardStore.getState().tree?.children[0]?.content).toBe("fresh live");
    expect(useDashboardStore.getState().historyResetVersion).toBe(1);
    expect(latest?.synchronizedSessionKey).toBe("sess-1");
    expect(provider.detailCursorStore.get("https://dashboard.test|alice", "sess-1")).toBe(41);
    vi.useRealTimers();
  });

  it("preserves the reconnect text snapshot immediately before a reset marker", async () => {
    vi.useFakeTimers();
    const provider = new FakeSessionProvider();
    flushSync(() => {
      root.render(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SessionProviderProbe, { provider }),
      ));
    });
    await Promise.resolve();

    provider.emit({ type: "user_message", text: "discard this replay" } as SoulSSEEvent, 32);
    provider.emit({
      type: "text_snapshot",
      basedOnEventId: 40,
      throughLiveSeq: 41,
      streams: [{
        streamIdentity: "stream-reset",
        text: "partial ",
        updatedAt: "2026-09-07T00:00:00.000Z",
        truncated: false,
        resetRequired: false,
        recovery: "none",
      }],
    }, 0);
    provider.emit({
      type: "history_sync",
      last_event_id: 40,
      is_live: true,
      reset_required: true,
      reset_reason: "history_gap",
    }, 0);
    provider.emit({
      type: "text_delta",
      text: "duplicate",
      streamIdentity: "stream-reset",
      liveSeq: 41,
      liveTextMode: "append",
    } as SoulSSEEvent, 0);
    provider.emit({
      type: "text_delta",
      text: "continued",
      streamIdentity: "stream-reset",
      liveSeq: 42,
      liveTextMode: "append",
    } as SoulSSEEvent, 0);
    await vi.advanceTimersByTimeAsync(50);

    expect(useDashboardStore.getState().tree?.children).toEqual([
      expect.objectContaining({ type: "text", content: "partial continued" }),
    ]);
    expect(provider.detailCursorStore.get("https://dashboard.test|alice", "sess-1")).toBe(40);
    vi.useRealTimers();
  });

  it("preserves a pre-sync text snapshot when the reset marker crosses the batch boundary", async () => {
    vi.useFakeTimers();
    const provider = new FakeSessionProvider();
    flushSync(() => {
      root.render(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SessionProviderProbe, { provider }),
      ));
    });
    await Promise.resolve();

    for (let eventId = 1; eventId <= 63; eventId += 1) {
      provider.emit({
        type: "user_message",
        text: `discard replay ${eventId}`,
      } as SoulSSEEvent, eventId);
    }
    // Event 64 drains immediately, leaving the marker in the next chunk.
    provider.emit({
      type: "text_snapshot",
      basedOnEventId: 63,
      throughLiveSeq: 41,
      streams: [{
        streamIdentity: "stream-boundary",
        text: "partial ",
        updatedAt: "2026-09-07T00:00:00.000Z",
        truncated: false,
        resetRequired: false,
        recovery: "none",
      }],
    }, 0);
    provider.emit({
      type: "history_sync",
      last_event_id: 63,
      is_live: true,
      reset_required: true,
      reset_reason: "history_gap",
    }, 0);
    provider.emit({
      type: "text_delta",
      text: "duplicate",
      streamIdentity: "stream-boundary",
      liveSeq: 41,
      liveTextMode: "append",
    } as SoulSSEEvent, 0);
    provider.emit({
      type: "text_delta",
      text: "continued",
      streamIdentity: "stream-boundary",
      liveSeq: 42,
      liveTextMode: "append",
    } as SoulSSEEvent, 0);
    await vi.advanceTimersByTimeAsync(50);

    expect(useDashboardStore.getState().tree?.children).toEqual([
      expect.objectContaining({ type: "text", content: "partial continued" }),
    ]);
    expect(provider.detailCursorStore.get("https://dashboard.test|alice", "sess-1")).toBe(63);
    vi.useRealTimers();
  });

});
