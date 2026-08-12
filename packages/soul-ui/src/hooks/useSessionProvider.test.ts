/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
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

class FakeSessionProvider implements SessionStorageProvider {
  subscribeCalls: Array<{
    sessionKey: string;
    options?: { lastEventId?: number };
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
    options?: { lastEventId?: number },
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

function SessionProviderProbe({ provider }: { provider: SessionStorageProvider }) {
  useSessionProvider({
    sessionKey: "sess-1",
    getSessionProvider: () => provider,
  });
  return null;
}

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
    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
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
});
