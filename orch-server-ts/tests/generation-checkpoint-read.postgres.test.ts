import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { EventReadRepository } from "../src/control_plane/repositories/event_read_repository.js";
import { SessionStoryReadRepository } from "../src/control_plane/repositories/session_story_read_repository.js";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";

const hasPostgres = Boolean(process.env.TEST_DATABASE_URL?.trim()) ||
  spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const describePostgres = hasPostgres ? describe : describe.skip;

describePostgres("generation checkpoint reads in PostgreSQL", () => {
  let harness: FullSchemaPostgresHarness;
  let events: EventReadRepository;
  let stories: SessionStoryReadRepository;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    events = new EventReadRepository(harness.sql as unknown as SqlClient);
    stories = new SessionStoryReadRepository(harness.sql as unknown as SqlClient);
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("matches the JavaScript reference for bounded recent reads, duplicate types, session scope, and after total", async () => {
    const sessionId = `checkpoint-events-${randomUUID()}`;
    const otherSessionId = `checkpoint-events-other-${randomUUID()}`;
    await harness.sql`
      INSERT INTO sessions (session_id, display_name)
      VALUES (${sessionId}, ${sessionId}), (${otherSessionId}, ${otherSessionId})
    `;

    const seeded = [
      [1, "user_message"],
      [2, "tool_result"],
      [3, "assistant_message"],
      [4, "user_message"],
      [5, "tool_start"],
      [6, "assistant_message"],
      [7, "user_message"],
      [8, "assistant_message"],
      [9, "debug"],
      [10, "user_message"],
      [11, "assistant_message"],
      [12, "tool_result"],
      [13, "user_message"],
      [14, "assistant_message"],
    ] as const;
    for (const [id, eventType] of seeded) {
      await harness.sql`
        INSERT INTO events (session_id, id, event_type, payload, searchable_text)
        VALUES (${sessionId}, ${id}, ${eventType}, ${harness.sql.json({ text: `event-${id}` })}, '')
      `;
    }
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload, searchable_text)
      VALUES
        (${otherSessionId}, 1, 'user_message', '{"text":"other-1"}', ''),
        (${otherSessionId}, 14, 'assistant_message', '{"text":"other-14"}', '')
    `;

    const eventTypes = ["user_message", "assistant_message", "user_message"];
    const baseline = (limit: number, predicate: (id: number) => boolean) =>
      seeded
        .filter(([id, type]) => predicate(id) && eventTypes.includes(type))
        .map(([id, type]) => ({ id, type }))
        .sort((left, right) => left.id - right.id)
        .slice(-limit);
    const ids = (rows: Array<{ id: number; event_type: string }>) =>
      rows.map(({ id, event_type }) => [id, event_type]);

    const recent = await events.readRecentEvents(sessionId, 4, eventTypes);
    const before = await events.readRecentEventsBefore(sessionId, 10, 3, eventTypes);
    const after = await events.readRecentEventsAfter(sessionId, 4, 2, eventTypes);
    const unfilteredAfter = await events.readRecentEventsAfter(sessionId, 4, 3, []);

    expect(ids(recent)).toEqual(baseline(4, () => true).map(({ id, type }) => [id, type]));
    expect(ids(before)).toEqual(baseline(3, (id) => id <= 10).map(({ id, type }) => [id, type]));
    expect(ids(after.events)).toEqual(baseline(2, (id) => id > 4).map(({ id, type }) => [id, type]));
    expect(after.total).toBe(seeded.filter(([id, type]) => id > 4 && eventTypes.includes(type)).length);
    expect(ids(unfilteredAfter.events)).toEqual(
      seeded.filter(([id]) => id > 4).map(([id, type]) => [id, type]).slice(-3),
    );
    expect(unfilteredAfter.total).toBe(seeded.filter(([id]) => id > 4).length);
  }, 30_000);

  it("keeps the global turn number after a middle digest watermark", async () => {
    const sessionId = `checkpoint-story-${randomUUID()}`;
    await harness.sql`INSERT INTO sessions (session_id, display_name) VALUES (${sessionId}, ${sessionId})`;
    for (const [id, eventType, content] of [
      [1, "turn_summary", "turn 1"],
      [2, "user_message", "input 1"],
      [3, "turn_summary", "turn 2"],
      [4, "assistant_message", "response 2"],
      [5, "turn_summary", "turn 3"],
      [6, "tool_result", "tool"],
      [7, "turn_summary", "turn 4"],
      [8, "assistant_message", "response 4"],
      [9, "turn_summary", "turn 5"],
    ] as const) {
      await harness.sql`
        INSERT INTO events (session_id, id, event_type, payload, searchable_text)
        VALUES (${sessionId}, ${id}, ${eventType}, ${harness.sql.json({ content })}, '')
      `;
    }
    await harness.sql`
      INSERT INTO session_digests (
        session_id, narrative, highlight, narrative_through_event_id, fold_count
      ) VALUES (${sessionId}, 'folded narrative', 'folded highlight', 5, 3)
    `;

    const story = await stories.getSessionStory(sessionId);

    expect(story.unfoldedTurnSummaries.map(({ eventId, turnNumber }) => [eventId, turnNumber]))
      .toEqual([[7, 4], [9, 5]]);
  }, 30_000);
});
