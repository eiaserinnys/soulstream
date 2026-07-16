import { describe, expect, it, vi } from "vitest";

import {
  beginPlannerLoad,
  completePlannerLoad,
  loadConfirmedResult,
} from "./planner-query-state";

describe("planner query state", () => {
  it("does not replace ready content while a background refresh is pending", () => {
    const current = {
      status: "ready" as const,
      data: { items: [{ id: "task-a", title: "업무" }] },
      message: null,
    };

    expect(beginPlannerLoad(current)).toBe(current);
  });

  it("keeps the load state and rows across an equivalent response", () => {
    const current = {
      status: "ready" as const,
      data: { items: [{ id: "task-a", title: "업무" }] },
      message: null,
    };

    const completed = completePlannerLoad(current, {
      items: current.data.items.map((item) => ({ ...item })),
    });

    expect(completed).toBe(current);
    expect(completed.data.items).toBe(current.data.items);
  });

  it("confirms a one-shot empty transition once before publishing it", async () => {
    const previous = { items: [{ id: "task-a" }] };
    const load = vi.fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [{ id: "task-a" }] });

    await expect(loadConfirmedResult({
      previous,
      load,
      clearsVisibleContent: (current, next) => current.items.length > 0 && next.items.length === 0,
    })).resolves.toEqual(previous);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("publishes a confirmed empty result after one bounded confirmation", async () => {
    const previous = { items: [{ id: "task-a" }] };
    const load = vi.fn().mockResolvedValue({ items: [] });

    await expect(loadConfirmedResult({
      previous,
      load,
      clearsVisibleContent: (current, next) => current.items.length > 0 && next.items.length === 0,
    })).resolves.toEqual({ items: [] });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
