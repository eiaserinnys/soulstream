import { describe, expect, it } from "vitest";

import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";
import { loadSessionFeedStates } from
  "../src/session/session_feed_state_repository.js";

describe("session feed state repository", () => {
  it("hydrates many sessions in three page-batched queries", async () => {
    const statements: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      const statement = strings.join("?");
      statements.push(statement);
      if (statement.includes("FROM session_feed_state")) {
        return [{
          session_id: "session-a",
          attention_revision: 12,
          notification_watermark: 21,
          notification_count: 9,
        }];
      }
      if (statement.includes("FROM session_pending_attentions")) {
        return [{
          session_id: "session-a",
          projection: {
            id: "input_request:req-1",
            sourceEventId: 12,
            sessionId: "session-a",
            kind: "input_request",
            requestedAt: "2026-09-06T12:00:00.000Z",
            title: "입력 요청",
            body: "Continue?",
            requestId: "req-1",
            requiresDetail: false,
          },
        }];
      }
      return [{
        session_id: "session-a",
        projection: {
          id: "session-a:21",
          sourceEventId: 21,
          sessionId: "session-a",
          kind: "error",
          title: "세션 오류",
          body: "boom",
          createdAt: "2026-09-06T12:01:00.000Z",
        },
      }];
    }) as unknown as LivePostgresSql;

    const states = await loadSessionFeedStates(sql, [
      { session_id: "session-a" },
      { session_id: "session-b" },
      { session_id: "session-a" },
    ]);

    expect(statements).toHaveLength(3);
    expect(states.get("session-a")).toMatchObject({
      attentionRevision: 12,
      pendingAttentions: [{ id: "input_request:req-1" }],
      notificationWatermark: 21,
      recentNotices: [{ id: "session-a:21" }],
      noticesTruncated: true,
    });
    expect(states.get("session-b")).toEqual({
      pendingAttentions: [],
      attentionRevision: 0,
      recentNotices: [],
      notificationWatermark: 0,
      noticesTruncated: false,
    });
  });
});
