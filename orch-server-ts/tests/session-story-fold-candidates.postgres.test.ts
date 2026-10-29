import { afterEach, describe, expect, it } from "vitest";

import { SessionStoryRepository } from "../src/turn-summary/session_story_repository.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page/page_postgres_harness.js";

const LEGACY_CANDIDATE_QUERY = `
  WITH candidates AS (
    SELECT
      s.session_id,
      s.updated_at AS completed_at,
      COUNT(e.id) FILTER (
        WHERE e.event_type = 'turn_summary'
      )::integer AS total_summary_count,
      COUNT(e.id) FILTER (
        WHERE e.event_type = 'turn_summary'
          AND e.id > COALESCE(d.narrative_through_event_id, 0)
      )::integer AS unfolded_summary_count
    FROM sessions s
    LEFT JOIN session_digests d ON d.session_id = s.session_id
    LEFT JOIN events e ON e.session_id = s.session_id
    WHERE s.status = 'completed'
      AND s.updated_at <= $1
    GROUP BY s.session_id, s.updated_at, d.narrative_through_event_id
  )
  SELECT session_id, completed_at
  FROM candidates
  WHERE total_summary_count >= $2
    AND unfolded_summary_count > 0
  ORDER BY completed_at ASC, session_id ASC
  LIMIT $3
`;

describe("SessionStoryRepository completed fold candidates (PostgreSQL)", () => {
  let harness: PagePostgresHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it("preserves candidate ordering and stores candidates with millisecond timestamps", async () => {
    harness = await createPagePostgresHarness();
    const { sql } = harness;
    await sql.unsafe(`
      CREATE TABLE session_digests (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        narrative TEXT NOT NULL,
        highlight TEXT NOT NULL,
        narrative_through_event_id INTEGER NOT NULL,
        fold_count INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const completedBefore = new Date("2026-10-02T00:00:00.000Z");
    const sameCompletedAt = "2026-09-30T00:00:00.000Z";
    const insertSession = async (
      sessionId: string,
      status: string,
      updatedAt: string,
    ) => sql`
      INSERT INTO sessions (session_id, status, updated_at)
      VALUES (${sessionId}, ${status}, ${updatedAt}::timestamptz)
    `;
    const insertEvents = async (
      sessionId: string,
      count: number,
      eventType = "turn_summary",
    ) => {
      for (let id = 1; id <= count; id += 1) {
        await sql`
          INSERT INTO events (session_id, id, event_type)
          VALUES (${sessionId}, ${id}, ${eventType})
        `;
      }
    };
    const insertDigest = async (sessionId: string, watermark: number) => sql`
      INSERT INTO session_digests (
        session_id, narrative, highlight, narrative_through_event_id
      ) VALUES (${sessionId}, '', '', ${watermark})
    `;

    await insertSession("a-no-digest", "completed", sameCompletedAt);
    await insertEvents("a-no-digest", 5);
    await insertSession("b-unfolded-tail", "completed", sameCompletedAt);
    await insertEvents("b-unfolded-tail", 6);
    await insertDigest("b-unfolded-tail", 4);
    await insertSession("c-already-folded", "completed", sameCompletedAt);
    await insertEvents("c-already-folded", 5);
    await insertDigest("c-already-folded", 5);
    await insertSession("d-too-few-summaries", "completed", sameCompletedAt);
    await insertEvents("d-too-few-summaries", 4);
    await sql.unsafe(`
      INSERT INTO events (session_id, id, event_type) VALUES
        ('d-too-few-summaries', 5, 'user_message'),
        ('d-too-few-summaries', 6, 'assistant_message'),
        ('d-too-few-summaries', 7, 'tool_result');
    `);
    await insertSession("e-not-completed-yet", "completed", "2026-10-02T00:00:00.001Z");
    await insertEvents("e-not-completed-yet", 5);
    await insertSession("f-running", "running", sameCompletedAt);
    await insertEvents("f-running", 5);
    await insertSession("g-no-summaries", "completed", sameCompletedAt);
    await insertEvents("g-no-summaries", 3, "tool_result");
    await insertSession("z-later-candidate", "completed", "2026-10-01T00:00:00.000Z");
    await insertEvents("z-later-candidate", 5);

    const repository = new SessionStoryRepository({
      resolveSql: async () => harness!.liveSql,
      close: async () => undefined,
    });
    const expected = ["a-no-digest", "b-unfolded-tail", "z-later-candidate"];
    const input = { completedBefore, minimumSummaryCount: 5, limit: 100 };
    const oldRows = await sql.unsafe(LEGACY_CANDIDATE_QUERY, [
      input.completedBefore,
      input.minimumSummaryCount,
      input.limit,
    ]);
    const oldCandidates = oldRows.map((row) => ({
      sessionId: String(row.session_id),
      completedAt: row.completed_at instanceof Date
        ? row.completed_at
        : new Date(String(row.completed_at)),
    }));
    const newCandidates = await repository.listCompletedFoldCandidates(input);

    expect(oldCandidates).toEqual(newCandidates);
    expect(newCandidates.map((candidate) => candidate.sessionId)).toEqual(expected);
    expect(newCandidates[0]?.completedAt).toEqual(newCandidates[1]?.completedAt);

    const limitedInput = { ...input, limit: 2 };
    const oldLimitedRows = await sql.unsafe(LEGACY_CANDIDATE_QUERY, [
      limitedInput.completedBefore,
      limitedInput.minimumSummaryCount,
      limitedInput.limit,
    ]);
    const oldLimited = oldLimitedRows.map((row) => String(row.session_id));
    const newLimited = await repository.listCompletedFoldCandidates(limitedInput);
    expect(newLimited.map((candidate) => candidate.sessionId)).toEqual(oldLimited);
    expect(oldLimited).toEqual(expected.slice(0, 2));

    const microsecondAt = "2026-10-01T00:00:00.123456Z";
    await sql.unsafe(`
      INSERT INTO sessions (session_id, status, updated_at)
      VALUES ('h-microsecond-candidate', 'completed', '${microsecondAt}'::timestamptz)
    `);
    await insertEvents("h-microsecond-candidate", 5);
    const [storedPrecision] = await sql`
      SELECT updated_at::text AS updated_at
      FROM sessions
      WHERE session_id = 'h-microsecond-candidate'
    `;
    expect(String(storedPrecision?.updated_at)).toContain("00:00:00.123456");
    const microsecondCandidate = (await repository.listCompletedFoldCandidates({
      completedBefore,
      minimumSummaryCount: 5,
      limit: 100,
    })).find((candidate) => candidate.sessionId === "h-microsecond-candidate");
    expect(microsecondCandidate?.completedAt.toISOString()).toBe(
      "2026-10-01T00:00:00.123Z",
    );
    await expect(repository.storeCompletedDigest({
      sessionId: microsecondCandidate!.sessionId,
      completedAt: microsecondCandidate!.completedAt,
      completedBefore,
      minimumSummaryCount: 5,
      narrative: "요약",
      highlight: "핵심",
      narrativeThroughEventId: 5,
      expectedVersion: 0,
    })).resolves.toBe(true);
    await expect(sql`
      SELECT session_id FROM session_digests
      WHERE session_id = 'h-microsecond-candidate'
    `).resolves.toHaveLength(1);

    await insertSession("i-changed-after-read", "completed", sameCompletedAt);
    await insertEvents("i-changed-after-read", 5);
    const changedCandidate = (await repository.listCompletedFoldCandidates({
      completedBefore,
      minimumSummaryCount: 5,
      limit: 100,
    })).find((candidate) => candidate.sessionId === "i-changed-after-read");
    expect(changedCandidate).toBeDefined();
    await sql`
      UPDATE sessions
      SET updated_at = '2026-10-01T00:00:01.000Z'::timestamptz
      WHERE session_id = ${changedCandidate!.sessionId}
    `;
    await expect(repository.storeCompletedDigest({
      sessionId: changedCandidate!.sessionId,
      completedAt: changedCandidate!.completedAt,
      completedBefore,
      minimumSummaryCount: 5,
      narrative: "요약",
      highlight: "핵심",
      narrativeThroughEventId: 5,
      expectedVersion: 0,
    })).resolves.toBe(false);
  });
});
