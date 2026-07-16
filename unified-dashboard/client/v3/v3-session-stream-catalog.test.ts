import { describe, expect, it } from "vitest";
import type { CatalogState, SessionListStreamEvent, SessionSummary } from "@seosoyoung/soul-ui";

import { projectSessionListSnapshot } from "./v3-session-stream-catalog";

describe("v3 session_list catalog projection", () => {
  it("stores the full existing stream snapshot without replacing equal rows", () => {
    const current = session("same", "running");
    const catalog: CatalogState = {
      folders: [],
      sessions: {},
      sessionList: [current],
    };
    const event: SessionListStreamEvent = {
      type: "session_list",
      sessions: [{ ...current }],
      total: 1,
    };

    const projected = projectSessionListSnapshot(catalog, event);

    expect(projected).toBe(catalog);
    expect(projected.sessionList?.[0]).toBe(current);
  });

  it("normalizes wire rows and replaces only the changed session identity", () => {
    const unchanged = session("unchanged", "running");
    const changed = session("changed", "running");
    const catalog: CatalogState = {
      folders: [],
      sessions: {},
      sessionList: [unchanged, changed],
    };
    const event = {
      type: "session_list",
      sessions: [
        { ...unchanged },
        { agent_session_id: "changed", status: "completed", event_count: 0 },
      ],
      total: 2,
    } as unknown as SessionListStreamEvent;

    const projected = projectSessionListSnapshot(catalog, event);

    expect(projected).not.toBe(catalog);
    expect(projected.sessionList?.[0]).toBe(unchanged);
    expect(projected.sessionList?.[1]).not.toBe(changed);
    expect(projected.sessionList?.[1]).toMatchObject({
      agentSessionId: "changed",
      status: "completed",
    });
  });
});

function session(id: string, status: SessionSummary["status"]): SessionSummary {
  return { agentSessionId: id, status, eventCount: 0 };
}
