import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionSummary } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { createRenameSessionOperation } from "./rename-session";

interface SessionPage {
  sessions: SessionSummary[];
  total: number;
}

describe("createRenameSessionOperation", () => {
  let queryClient: QueryClient;
  const queryKey = ["sessions", "all", "ids", null, ["session-a"]] as const;

  beforeEach(() => {
    useDashboardStore.getState().reset();
    useDashboardStore.getState().setCatalog({
      folders: [],
      sessions: { "session-a": { folderId: null, displayName: "이전 이름" } },
    });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData<InfiniteData<SessionPage>>(queryKey, {
      pages: [{
        sessions: [{ agentSessionId: "session-a", displayName: "이전 이름" } as SessionSummary],
        total: 1,
      }],
      pageParams: [0],
    });
  });

  afterEach(() => {
    queryClient.clear();
    vi.restoreAllMocks();
  });

  it("updates the dashboard store and targeted session queries in one optimistic boundary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { renameSessionOptimistic } = createRenameSessionOperation({
      url: (sessionId) => `/api/sessions/${sessionId}/display-name`,
      method: "PATCH",
    });

    await renameSessionOptimistic("session-a", "새 이름", { queryClient });

    expect(useDashboardStore.getState().catalog?.sessions["session-a"]?.displayName).toBe("새 이름");
    expect(queryClient.getQueryData<InfiniteData<SessionPage>>(queryKey)?.pages[0]?.sessions[0]?.displayName)
      .toBe("새 이름");
  });

  it("restores both projections and rethrows when the network request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { renameSessionOptimistic } = createRenameSessionOperation({
      url: (sessionId) => `/api/sessions/${sessionId}/display-name`,
      method: "PATCH",
    });

    await expect(renameSessionOptimistic("session-a", "실패 이름", { queryClient }))
      .rejects.toThrow("Rename failed: 503");

    expect(useDashboardStore.getState().catalog?.sessions["session-a"]?.displayName).toBe("이전 이름");
    expect(queryClient.getQueryData<InfiniteData<SessionPage>>(queryKey)?.pages[0]?.sessions[0]?.displayName)
      .toBe("이전 이름");
  });
});
