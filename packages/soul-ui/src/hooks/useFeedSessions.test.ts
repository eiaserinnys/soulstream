/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFeedSessions } from "./useFeedSessions";
import type { SessionPage } from "./session-stream-helpers";
import type { SessionSummary } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";

function makeSession(
  agentSessionId: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  const now = new Date(Date.now() - 60_000).toISOString();
  return {
    agentSessionId,
    status: "running",
    sessionType: "claude",
    createdAt: now,
    updatedAt: now,
    eventCount: 0,
    ...overrides,
  };
}

function page(sessions: SessionSummary[]): InfiniteData<SessionPage> {
  return {
    pages: [{ sessions, total: sessions.length }],
    pageParams: [0],
  };
}

function Probe({ onValue }: { onValue: (sessions: SessionSummary[]) => void }) {
  onValue(useFeedSessions());
  return null;
}

describe("useFeedSessions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let latest: SessionSummary[];

  beforeEach(() => {
    latest = [];
    useDashboardStore.getState().reset();
    useDashboardStore.getState().setCatalog({
      folders: [{ id: "folder-a", name: "Folder A", sortOrder: 0 }],
      sessions: {
        "feed-session": { folderId: null, displayName: null },
        "folder-session": { folderId: "folder-a", displayName: null },
      },
    });
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
  });

  it("reads the feed query cache, not folder query pages", async () => {
    queryClient.setQueryData(
      ["sessions", "all", "folder", "folder-a"],
      page([makeSession("folder-session")]),
    );

    flushSync(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe, { onValue: (value) => { latest = value; } }),
        ),
      );
    });
    await Promise.resolve();

    expect(latest.map((s) => s.agentSessionId)).toEqual([]);
  });

  it("returns sessions from the current feed query cache", async () => {
    queryClient.setQueryData(
      ["sessions", "all", "feed", null],
      page([makeSession("feed-session")]),
    );
    queryClient.setQueryData(
      ["sessions", "all", "folder", "folder-a"],
      page([makeSession("folder-session")]),
    );

    flushSync(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe, { onValue: (value) => { latest = value; } }),
        ),
      );
    });
    await Promise.resolve();

    expect(latest.map((s) => s.agentSessionId)).toEqual(["feed-session"]);
  });

  it("keeps old feed sessions while ignoring folder-only query cache data", async () => {
    queryClient.setQueryData(
      ["sessions", "all", "feed", null],
      page([
        makeSession("old-feed-session", {
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: "2026-05-01T00:00:00Z",
        }),
      ]),
    );
    queryClient.setQueryData(
      ["sessions", "all", "folder", "folder-a"],
      page([makeSession("folder-session")]),
    );

    flushSync(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe, { onValue: (value) => { latest = value; } }),
        ),
      );
    });
    await Promise.resolve();

    expect(latest.map((s) => s.agentSessionId)).toEqual(["old-feed-session"]);
  });

  it("does not change feed results when a folder query is populated after render", async () => {
    const observed: string[][] = [];
    queryClient.setQueryData(
      ["sessions", "all", "feed", null],
      page([makeSession("feed-session")]),
    );

    flushSync(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe, {
            onValue: (value) => {
              latest = value;
              observed.push(value.map((s) => s.agentSessionId));
            },
          }),
        ),
      );
    });
    await Promise.resolve();
    expect(latest.map((s) => s.agentSessionId)).toEqual(["feed-session"]);

    queryClient.setQueryData(
      ["sessions", "all", "folder", "folder-a"],
      page([makeSession("folder-session")]),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(latest.map((s) => s.agentSessionId)).toEqual(["feed-session"]);
    expect(observed).toEqual([["feed-session"]]);
  });
});
