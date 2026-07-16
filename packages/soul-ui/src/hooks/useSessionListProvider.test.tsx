/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EventTreeNode,
  SessionSummary,
  SoulSSEEvent,
} from "../shared/types";
import type { SessionStorageProvider } from "../providers/types";
import { retainEqualValue } from "../lib/structural-sharing";
import { useDashboardStore } from "../stores/dashboard-store";
import { useSessionListProvider } from "./useSessionListProvider";

const initialCatalogLoadSpy = vi.hoisted(() => vi.fn());
const streamCacheSyncSpy = vi.hoisted(() => vi.fn());

vi.mock("./useInitialCatalogLoad", () => ({
  useInitialCatalogLoad: initialCatalogLoadSpy,
}));

vi.mock("./useSessionStreamCacheSync", () => ({
  useSessionStreamCacheSync: streamCacheSyncSpy,
}));

function makeSession(agentSessionId: string): SessionSummary {
  const now = "2026-06-07T00:00:00Z";
  return {
    agentSessionId,
    status: "running",
    sessionType: "claude",
    createdAt: now,
    updatedAt: now,
    eventCount: 1,
    prompt: agentSessionId,
  };
}

function makeProvider(sessions: SessionSummary[]): SessionStorageProvider {
  return {
    fetchSessions: vi.fn().mockResolvedValue({
      sessions,
      total: sessions.length,
      hasMore: false,
    }),
    fetchFolderCounts: vi.fn().mockResolvedValue({}),
    fetchCards: vi.fn().mockResolvedValue([] as EventTreeNode[]),
    subscribe: vi.fn(
      (
        _sessionKey: string,
        _onEvent: (event: SoulSSEEvent, eventId: number) => void,
      ) => () => {},
    ),
  };
}

function Probe({
  external,
  onSessions,
  provider,
  sessionIds,
}: {
  external?: boolean;
  onSessions: (sessions: SessionSummary[]) => void;
  provider: SessionStorageProvider;
  sessionIds?: readonly string[];
}) {
  const { sessions } = useSessionListProvider({
    intervalMs: 10,
    getSessionProvider: () => provider,
    externalProvider: external ? provider : undefined,
    sessionIds,
    viewModeOverride: "feed",
    folderIdOverride: null,
    streamEnabled: false,
    initialCatalogLoadEnabled: false,
    folderCountsEnabled: false,
  });
  onSessions(sessions);
  return null;
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let i = 0; i < 30; i += 1) {
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

describe("useSessionListProvider query overrides", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    initialCatalogLoadSpy.mockClear();
    streamCacheSyncSpy.mockClear();
    useDashboardStore.getState().reset();
    useDashboardStore.getState().selectFolder("empty-folder");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
  });

  it("keeps a sidebar feed query on feedOnly even after the center selects a folder", async () => {
    const provider = makeProvider([makeSession("global-feed")]);
    let latest: SessionSummary[] = [];

    flushSync(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe, {
            provider,
            onSessions: (value) => {
              latest = value;
            },
          }),
        ),
      );
    });

    await waitFor(() => {
      expect(provider.fetchSessions).toHaveBeenCalledWith({
        offset: 0,
        limit: 50,
        feedOnly: true,
      });
    });

    expect(provider.fetchSessions).not.toHaveBeenCalledWith(
      expect.objectContaining({ folderId: "empty-folder" }),
    );
    await waitFor(() => {
      expect(latest.map((s) => s.agentSessionId)).toEqual(["global-feed"]);
    });
    expect(provider.fetchFolderCounts).not.toHaveBeenCalled();
    expect(initialCatalogLoadSpy).toHaveBeenCalledWith(false);
    expect(streamCacheSyncSpy).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("requests only the session summaries referenced by a page", async () => {
    const provider = makeProvider([makeSession("session-b")]);
    let latest: SessionSummary[] = [];

    flushSync(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe, {
            provider,
            sessionIds: ["session-b", "session-a", "session-b"],
            onSessions: (value) => {
              latest = value;
            },
          }),
        ),
      );
    });

    await waitFor(() => {
      expect(provider.fetchSessions).toHaveBeenCalledWith({
        offset: 0,
        limit: 50,
        sessionIds: ["session-a", "session-b"],
      });
    });
    await waitFor(() => {
      expect(latest.map((session) => session.agentSessionId)).toEqual(["session-b"]);
    });
  });

  it("does not fetch the unbounded session list while a ready page has no references", async () => {
    const provider = makeProvider([]);

    flushSync(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe, {
            provider,
            sessionIds: [],
            onSessions: () => undefined,
          }),
        ),
      );
    });

    await waitFor(() => {
      expect(queryClient.getQueryState(["sessions", "all", "ids", null, []])?.status)
        .toBe("success");
    });
    expect(provider.fetchSessions).not.toHaveBeenCalled();
  });

  it("keeps one sessions identity across six equivalent external-provider polls", async () => {
    const source = [makeSession("session-a"), makeSession("session-b")];
    const provider = makeProvider(source);
    provider.fetchSessions = vi.fn(async () => ({
      sessions: source.map((session) => ({ ...session })),
      total: source.length,
      hasMore: false,
    }));
    const observed: SessionSummary[][] = [];

    flushSync(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe, {
            external: true,
            provider,
            onSessions: (value) => observed.push(value),
          }),
        ),
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(vi.mocked(provider.fetchSessions).mock.calls.length).toBeGreaterThanOrEqual(6);
    const populated = observed.filter((sessions) => sessions.length > 0);
    expect(populated.length).toBeGreaterThan(0);
    expect(new Set(populated).size).toBe(1);
  });

  it("does not publish an unconfirmed empty list while a new ids query is pending", async () => {
    const sessionA = makeSession("session-a");
    const sessionB = makeSession("session-b");
    let resolveSecond: ((value: { sessions: SessionSummary[]; total: number; hasMore: boolean }) => void) | null = null;
    const provider = makeProvider([sessionA]);
    provider.fetchSessions = vi.fn(async (options) => {
      if (options.sessionIds?.includes("session-b")) {
        return await new Promise((resolve) => { resolveSecond = resolve; });
      }
      return { sessions: [sessionA], total: 1, hasMore: false };
    });
    let latest: SessionSummary[] = [];
    const render = (sessionIds: readonly string[]) => {
      flushSync(() => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(Probe, {
              provider,
              sessionIds,
              onSessions: (value) => { latest = value; },
            }),
          ),
        );
      });
    };

    render(["session-a"]);
    await waitFor(() => expect(latest.map((session) => session.agentSessionId)).toEqual(["session-a"]));

    render(["session-a", "session-b"]);
    await Promise.resolve();
    expect(latest.map((session) => session.agentSessionId)).toEqual(["session-a"]);

    resolveSecond?.({ sessions: [sessionA, sessionB], total: 2, hasMore: false });
    await waitFor(() => expect(latest.map((session) => session.agentSessionId)).toEqual(["session-a", "session-b"]));
  });
});

describe("session list structural sharing", () => {
  it("keeps the array and unchanged session identities across equivalent polling responses", () => {
    const previous = [makeSession("session-a"), makeSession("session-b")];
    const equivalent = previous.map((session) => ({ ...session }));

    const retained = retainEqualValue(previous, equivalent);

    expect(retained).toBe(previous);
    expect(retained[0]).toBe(previous[0]);
    expect(retained[1]).toBe(previous[1]);
  });

  it("reuses unchanged rows while replacing a session whose visible summary changed", () => {
    const previous = [makeSession("session-a"), makeSession("session-b")];
    const changed = [
      { ...previous[0], displayName: "새 제목" },
      { ...previous[1] },
    ];

    const retained = retainEqualValue(previous, changed);

    expect(retained).not.toBe(previous);
    expect(retained[0]).not.toBe(previous[0]);
    expect(retained[1]).toBe(previous[1]);
  });
});
