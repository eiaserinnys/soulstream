/** @vitest-environment jsdom */

import { act, createElement, Fragment } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EventTreeNode,
  SessionNotice,
  SessionSummary,
  SoulSSEEvent,
} from "../shared/types";
import type {
  FetchSessionsOptions,
  SessionListResult,
  SessionStorageProvider,
} from "../providers/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { useSessionListProvider } from "./useSessionListProvider";
import { useSessionStreamSSE } from "./useSessionStreamSSE";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

vi.mock("./useSessionStreamSSE", () => ({
  useSessionStreamSSE: vi.fn(),
}));

function Probe({ provider, onStreamReset }: {
  provider: SessionStorageProvider;
  onStreamReset: () => void;
}) {
  useSessionListProvider({
    getSessionProvider: () => provider,
    viewModeOverride: "feed",
    folderIdOverride: null,
    initialCatalogLoadEnabled: false,
    folderCountsEnabled: false,
    onStreamReset,
  });
  return null;
}

function ProbeWithSecondaryQuery({ provider, onStreamReset }: {
  provider: SessionStorageProvider;
  onStreamReset: () => void;
}) {
  return createElement(Fragment, null,
    createElement(Probe, { provider, onStreamReset }),
    createElement(SecondaryProbe, { provider }),
  );
}

function SecondaryProbe({ provider }: { provider: SessionStorageProvider }) {
  useSessionListProvider({
    getSessionProvider: () => provider,
    viewModeOverride: "folder",
    folderIdOverride: "folder-a",
    streamEnabled: false,
    initialCatalogLoadEnabled: false,
    folderCountsEnabled: false,
  });
  return null;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe("useSessionListProvider replay-gap hydration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.mocked(useSessionStreamSSE).mockClear();
    useDashboardStore.getState().reset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.restoreAllMocks();
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("hydrates the active attention and notice baseline from REST after a global ring gap", async () => {
    const oldAttention = {
      id: "input_request:req-10",
      sourceEventId: 10,
      sessionId: "session-a",
      kind: "input_request" as const,
      requestedAt: "2026-09-07T00:00:00.000Z",
      title: "Old question",
      body: "Already resolved during the gap",
      requestId: "req-10",
      requiresDetail: false,
    };
    const recoveredNotice: SessionNotice = {
      id: "session-a:11",
      sourceEventId: 11,
      sessionId: "session-a",
      kind: "terminal",
      title: "Completed during gap",
      body: "baseline only",
      createdAt: "2026-09-07T00:00:01.000Z",
    };
    const initial: SessionSummary = {
      agentSessionId: "session-a",
      status: "running",
      sessionType: "claude",
      eventCount: 10,
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:00.000Z",
      lastEventId: 10,
      pendingAttentions: [oldAttention],
      attentionRevision: 10,
      recentNotices: [],
      notificationWatermark: 10,
      noticesTruncated: false,
    };
    const recovered: SessionSummary = {
      ...initial,
      updatedAt: "2026-09-07T00:00:01.000Z",
      lastEventId: 11,
      pendingAttentions: [],
      attentionRevision: 11,
      recentNotices: [recoveredNotice],
      notificationWatermark: 11,
      noticesTruncated: true,
    };
    const provider: SessionStorageProvider = {
      fetchSessions: vi.fn<(_options?: FetchSessionsOptions) => Promise<SessionListResult>>()
        .mockResolvedValueOnce({ sessions: [initial], total: 1, hasMore: false })
        .mockResolvedValueOnce({ sessions: [recovered], total: 1, hasMore: false }),
      fetchCards: vi.fn().mockResolvedValue([] as EventTreeNode[]),
      subscribe: vi.fn((
        _sessionKey: string,
        _onEvent: (event: SoulSSEEvent, eventId: number) => void,
      ) => () => undefined),
    };
    const onStreamReset = vi.fn();
    useDashboardStore.getState().setActiveSession("session-a");
    useDashboardStore.getState().setActiveSessionSummary(initial);

    flushSync(() => {
      root.render(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Probe, { provider, onStreamReset }),
      ));
    });
    await waitFor(() => {
      expect(provider.fetchSessions).toHaveBeenCalledTimes(1);
      expect(queryClient.getQueryState(["sessions", "all", "feed", null])?.status)
        .toBe("success");
    });

    const beforeGap = vi.mocked(useSessionStreamSSE).mock.calls.at(-1)?.[0];
    beforeGap?.onReplayGap?.({
      type: "replay_gap",
      latest_id: 99,
      instance_id: "orch-a",
    });

    await waitFor(() => {
      expect(provider.fetchSessions).toHaveBeenCalledTimes(2);
      expect(useDashboardStore.getState().activeSessionSummary).toMatchObject({
        pendingAttentions: [],
        attentionRevision: 11,
        notificationWatermark: 11,
        noticesTruncated: true,
      });
    });
    expect(onStreamReset).toHaveBeenCalledTimes(1);

    const afterGap = vi.mocked(useSessionStreamSSE).mock.calls.at(-1)?.[0];
    afterGap?.onSessionUpdated?.({
      type: "session_updated",
      agent_session_id: "session-a",
      notices: [recoveredNotice],
      notification_watermark: 11,
    });
    expect(useDashboardStore.getState().pendingNotifications).toEqual([]);
  });

  it("refetches every session query and replays live deltas only after gap hydration", async () => {
    const oldAttention = {
      id: "input_request:req-10",
      sourceEventId: 10,
      sessionId: "session-a",
      kind: "input_request" as const,
      requestedAt: "2026-09-07T00:00:00.000Z",
      title: "Question before gap",
      body: "Resolved during gap",
      requestId: "req-10",
      requiresDetail: false,
    };
    const liveAttention = {
      ...oldAttention,
      id: "input_request:req-12",
      sourceEventId: 12,
      requestedAt: "2026-09-07T00:00:02.000Z",
      title: "Question after gap",
      body: "Apply after hydration",
      requestId: "req-12",
    };
    const recoveredNotice: SessionNotice = {
      id: "session-a:11",
      sourceEventId: 11,
      sessionId: "session-a",
      kind: "terminal",
      title: "Gap notice",
      body: "Hydration baseline only",
      createdAt: "2026-09-07T00:00:01.000Z",
    };
    const liveNotice: SessionNotice = {
      id: "session-a:12",
      sourceEventId: 12,
      sessionId: "session-a",
      kind: "response_wait",
      title: "Live notice",
      body: "Alert exactly once after hydration",
      createdAt: "2026-09-07T00:00:02.000Z",
    };
    const initial: SessionSummary = {
      agentSessionId: "session-a",
      status: "running",
      sessionType: "claude",
      eventCount: 10,
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:00.000Z",
      lastEventId: 10,
      pendingAttentions: [oldAttention],
      attentionRevision: 10,
      recentNotices: [],
      notificationWatermark: 10,
      noticesTruncated: false,
    };
    const recovered: SessionSummary = {
      ...initial,
      updatedAt: "2026-09-07T00:00:01.000Z",
      lastEventId: 11,
      pendingAttentions: [],
      attentionRevision: 11,
      recentNotices: [recoveredNotice],
      notificationWatermark: 11,
      noticesTruncated: true,
    };
    const recovery = deferred<SessionListResult>();
    let recovering = false;
    const provider: SessionStorageProvider = {
      fetchSessions: vi.fn(async () => (
        recovering ? recovery.promise : { sessions: [initial], total: 1, hasMore: false }
      )),
      fetchCards: vi.fn().mockResolvedValue([] as EventTreeNode[]),
      subscribe: vi.fn(() => () => undefined),
    };
    const onStreamReset = vi.fn();
    useDashboardStore.getState().setActiveSession("session-a");
    useDashboardStore.getState().setActiveSessionSummary(initial);

    flushSync(() => {
      root.render(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ProbeWithSecondaryQuery, { provider, onStreamReset }),
      ));
    });
    await waitFor(() => expect(provider.fetchSessions).toHaveBeenCalledTimes(2));

    const stream = vi.mocked(useSessionStreamSSE).mock.calls
      .map(([options]) => options)
      .find((options) => options.enabled);
    expect(stream).toBeDefined();
    recovering = true;
    stream?.onReplayGap?.({
      type: "replay_gap",
      latest_id: 99,
      instance_id: "orch-a",
    });
    await waitFor(() => expect(provider.fetchSessions).toHaveBeenCalledTimes(4));

    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      stream?.onSessionUpdated?.({
        type: "session_updated",
        agent_session_id: "session-a",
        attention_revision: 12,
        pending_attentions_delta: {
          [liveAttention.id]: { revision: 12, value: liveAttention },
        },
        notices: [liveNotice],
        notification_watermark: 12,
      });
    });
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;

    expect(useDashboardStore.getState().activeSessionSummary).toMatchObject({
      attentionRevision: 10,
      notificationWatermark: 10,
    });
    expect(useDashboardStore.getState().pendingNotifications).toEqual([]);

    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      recovery.resolve({ sessions: [recovered], total: 1, hasMore: false });
      await waitFor(() => {
        expect(useDashboardStore.getState().activeSessionSummary).toMatchObject({
          pendingAttentions: [expect.objectContaining({ id: liveAttention.id })],
          attentionRevision: 12,
          recentNotices: [
            expect.objectContaining({ id: liveNotice.id }),
            expect.objectContaining({ id: recoveredNotice.id }),
          ],
          notificationWatermark: 12,
          noticesTruncated: true,
        });
      });
    });
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;

    for (const key of [
      ["sessions", "all", "feed", null],
      ["sessions", "all", "folder", "folder-a"],
    ] as const) {
      const cached = queryClient.getQueryData<{
        pages: Array<{ sessions: SessionSummary[] }>;
      }>(key);
      expect(cached?.pages[0].sessions[0]).toMatchObject({
        pendingAttentions: [expect.objectContaining({ id: liveAttention.id })],
        attentionRevision: 12,
        notificationWatermark: 12,
      });
    }
    expect(useDashboardStore.getState().pendingNotifications).toEqual([
      expect.objectContaining({ id: liveNotice.id }),
    ]);
    expect(onStreamReset).toHaveBeenCalledTimes(1);
  });
});
