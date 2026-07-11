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
  onSessions,
  provider,
  sessionScope = "view",
}: {
  onSessions: (sessions: SessionSummary[]) => void;
  provider: SessionStorageProvider;
  sessionScope?: "view" | "all";
}) {
  const { sessions } = useSessionListProvider({
    getSessionProvider: () => provider,
    sessionScope,
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

  it("loads the all-sessions index once with limit=0 through the existing query path", async () => {
    const provider = makeProvider([makeSession("global-a"), makeSession("global-b")]);
    let latest: SessionSummary[] = [];

    flushSync(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe, {
            provider,
            sessionScope: "all",
            onSessions: (value) => {
              latest = value;
            },
          }),
        ),
      );
    });

    await waitFor(() => {
      expect(provider.fetchSessions).toHaveBeenCalledWith({ offset: 0, limit: 0 });
      expect(latest.map((session) => session.agentSessionId)).toEqual(["global-a", "global-b"]);
    });
    expect(provider.fetchSessions).toHaveBeenCalledTimes(1);
  });
});
