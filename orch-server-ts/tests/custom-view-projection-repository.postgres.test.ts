import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CustomViewProjectionRepository } from
  "../src/board-yjs/custom_view_projection_repository.js";
import { CustomViewRevisionConflictError } from
  "../src/board-yjs/board_projection_types.js";
import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page/page_postgres_harness.js";

describe("CustomViewProjectionRepository PostgreSQL integration", () => {
  let harness: PagePostgresHarness;
  let repository: CustomViewProjectionRepository;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    await harness.sql`
      CREATE TABLE board_custom_views (
        id TEXT PRIMARY KEY,
        board_item_id TEXT NOT NULL UNIQUE REFERENCES board_items(id) ON DELETE CASCADE,
        title TEXT,
        html TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        archived BOOLEAN NOT NULL DEFAULT FALSE,
        created_actor_kind TEXT NOT NULL,
        created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
        created_event_id INTEGER,
        updated_actor_kind TEXT NOT NULL,
        updated_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
        updated_event_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    repository = new CustomViewProjectionRepository(
      createLiveDbSqlResolver({ sql: harness.liveSql }),
    );
  }, 60_000);

  beforeEach(async () => {
    await harness.sql`
      TRUNCATE board_custom_views, board_items, folders, events, sessions
      RESTART IDENTITY CASCADE
    `;
    await harness.sql`
      INSERT INTO sessions (session_id, node_id, status, session_type)
      VALUES ('sess-actor', 'node-1', 'running', 'claude')
    `;
    await harness.sql`
      INSERT INTO folders (id, name, sort_order)
      VALUES ('folder-1', 'Folder', 1)
    `;
    await harness.sql`
      INSERT INTO board_items (
        id, folder_id, container_kind, container_id, membership_kind,
        item_type, item_id, x, y, metadata
      ) VALUES (
        'custom_view:cv-1', 'folder-1', 'task', 'task-1', 'primary',
        'custom_view', 'cv-1', 10, 20, '{}'::jsonb
      )
    `;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("commits the actor event and custom-view row in one transaction", async () => {
    const result = await repository.createCustomViewRecord({
      id: "cv-1",
      boardItemId: "custom_view:cv-1",
      title: "Panel",
      html: "<section></section>",
      actorKind: "agent",
      actorSessionId: "sess-actor",
      idempotencyKey: "custom-view:create:cv-1",
    });

    expect(result).toMatchObject({
      eventId: 1,
      customView: {
        id: "cv-1",
        boardItemId: "custom_view:cv-1",
        revision: 1,
        createdEventId: 1,
        updatedEventId: 1,
      },
    });
    const [event] = await harness.sql<Array<{
      id: number;
      event_type: string;
      payload: Record<string, unknown>;
    }>>`
      SELECT id, event_type, payload
      FROM events
      WHERE session_id = 'sess-actor'
    `;
    expect(event).toMatchObject({
      id: 1,
      event_type: "custom_view_created",
      payload: {
        custom_view_id: "cv-1",
        board_item_id: "custom_view:cv-1",
        revision: 1,
      },
    });
  });

  it("rolls back the actor event when revision CAS rejects the row update", async () => {
    await repository.createCustomViewRecord({
      id: "cv-1",
      boardItemId: "custom_view:cv-1",
      title: "Panel",
      html: "<section></section>",
      actorKind: "agent",
      actorSessionId: "sess-actor",
      idempotencyKey: "custom-view:create:cv-1",
    });

    await expect(repository.patchCustomViewRecord({
      customViewId: "cv-1",
      boardItemId: "custom_view:cv-1",
      expectedRevision: 9,
      title: "Stale",
      html: "<main></main>",
      actorKind: "agent",
      actorSessionId: "sess-actor",
      idempotencyKey: "custom-view:patch:stale",
    })).rejects.toBeInstanceOf(CustomViewRevisionConflictError);

    const [state] = await harness.sql<Array<{
      revision: number;
      title: string;
      event_count: number;
      last_event_id: number;
    }>>`
      SELECT
        cv.revision,
        cv.title,
        (SELECT COUNT(*)::int FROM events WHERE session_id = 'sess-actor') AS event_count,
        s.last_event_id
      FROM board_custom_views cv
      JOIN sessions s ON s.session_id = 'sess-actor'
      WHERE cv.id = 'cv-1'
    `;
    expect(state).toEqual({
      revision: 1,
      title: "Panel",
      event_count: 1,
      last_event_id: 1,
    });
  });
});
