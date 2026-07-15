import { describe, expect, it, vi } from "vitest";

import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { loadMorningRitualData } from "./ritual-data";

describe("morning ritual data", () => {
  it("reads only the two dedicated historical dates and never lists all pages", async () => {
    const api = {
      listPages: vi.fn(),
    } as unknown as PageApiClient;
    const fetchPlanner = vi.fn(async (path: string) => {
      if (path.startsWith("/api/planner/daily-history")) {
        return { dates: ["2026-07-13", "2026-07-11"] };
      }
      const date = new URL(path, "https://example.test").searchParams.get("date");
      return {
        daily: {
          page: page(date === "2026-07-14" ? "today" : `daily-${date}`),
          blocks: [],
          state_vector: "",
        },
        projects: [],
        memo_blocks: [],
        tasks: [],
        review_session_ids: [],
      };
    });

    await expect(loadMorningRitualData({
      api,
      today: "2026-07-14",
      plannerDependencies: { fetchPlanner },
    })).resolves.toEqual({ dailyPageId: "today", items: [] });

    expect(api.listPages).not.toHaveBeenCalled();
    expect(fetchPlanner).toHaveBeenCalledWith(
      "/api/planner/daily-history?before=2026-07-14&limit=2",
    );
    expect(fetchPlanner).toHaveBeenCalledTimes(4);
  });
});

function page(id: string) {
  return {
    id,
    title: id,
    daily_date: null,
    version: 1,
    archived: false,
    metadata: {},
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
  };
}
