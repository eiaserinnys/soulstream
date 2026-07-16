import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ContainerBrowseService,
  createContainerBrowseStore,
} from "../../src/catalog/container_browse_service.js";
import { SessionDB } from "../../src/db/session_db.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;

describePostgres("container browse PostgreSQL integration", () => {
  let harness: FullSchemaPostgresHarness | undefined;
  let service: ContainerBrowseService;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    const sql = harness.sql;
    await sql`
      INSERT INTO folders (id, name, sort_order)
      VALUES ('container-folder', 'Container Folder', 1)
    `;
    await sql`
      INSERT INTO sessions (
        session_id, folder_id, display_name, status, session_type, agent_id,
        created_at, updated_at
      ) VALUES (
        'session-named', 'container-folder', 'Named Session', 'running', 'llm',
        'roselin_codex', NOW() - INTERVAL '1 hour', NOW()
      )
    `;
    await sql`
      INSERT INTO events (session_id, id, event_type, payload, searchable_text)
      VALUES ('session-named', 1, 'user_message', '{}'::jsonb, 'Latest user prompt')
    `;
    await sql`
      INSERT INTO markdown_documents (id, title, body, updated_at)
      VALUES ('doc-spec', 'Spec Document', 'Body with searchable details', NOW() - INTERVAL '2 hours')
    `;
    await sql`
      INSERT INTO file_assets (id, storage_key, original_name, mime_type, byte_size, upload_status)
      VALUES ('asset-diagram', 'test/diagram', 'diagram.png', 'image/png', 10, 'committed')
    `;
    await sql`
      INSERT INTO board_items (
        id, folder_id, container_kind, container_id, item_type, item_id, metadata
      ) VALUES
        ('session:session-named', 'container-folder', 'folder', 'container-folder', 'session', 'session-named', '{}'),
        ('markdown:doc-spec', 'container-folder', 'folder', 'container-folder', 'markdown', 'doc-spec', '{}'),
        ('asset:asset-diagram', 'container-folder', 'folder', 'container-folder', 'asset', 'asset-diagram', '{}'),
        ('runbook:archived', 'container-folder', 'folder', 'container-folder', 'runbook', 'archived', '{}')
    `;
    await sql`
      INSERT INTO runbooks (id, board_item_id, title, archived)
      VALUES ('archived', 'runbook:archived', 'Archived Runbook', TRUE)
    `;
    await sql`
      INSERT INTO board_items (
        id, folder_id, container_kind, container_id, item_type, item_id, metadata, updated_at
      )
      SELECT
        'frame:' || value, 'container-folder', 'folder', 'container-folder',
        'frame', 'frame-' || value, jsonb_build_object('title', 'Frame ' || value),
        NOW() - make_interval(secs => value)
      FROM generate_series(1, 205) AS value
    `;
    const db = new SessionDB(sql);
    service = new ContainerBrowseService(createContainerBrowseStore(db));
  }, 45_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 15_000);

  it("pages hundreds of scoped items and excludes archived items by default", async () => {
    const result = await service.browse({
      container: { containerKind: "folder", containerId: "container-folder" },
      cursor: 200,
      limit: 50,
    });
    expect(result.page).toEqual({
      cursor: 200,
      limit: 50,
      total: 208,
      nextCursor: null,
    });
    expect(result.items).toHaveLength(8);
    expect(result.items.every((item) => item.type !== "runbook")).toBe(true);

    const archived = await service.browse({
      container: { containerKind: "folder", containerId: "container-folder" },
      limit: 1,
      includeArchived: true,
    });
    expect(archived.page.total).toBe(209);
    expect(archived.counts.runbook).toBe(1);
  });

  it("searches only session display names and markdown title/body in the container", async () => {
    const markdown = await service.search({
      container: { containerKind: "folder", containerId: "container-folder" },
      query: "searchable details",
      limit: 999,
    });
    expect(markdown.page.limit).toBe(50);
    expect(markdown.items).toEqual([
      expect.objectContaining({ type: "markdown", id: "doc-spec", title: "Spec Document" }),
    ]);

    const session = await service.search({
      container: { containerKind: "folder", containerId: "container-folder" },
      query: "Named Session",
    });
    expect(session.items).toEqual([
      expect.objectContaining({
        type: "session",
        agentSessionId: "session-named",
        displayName: "Named Session",
        eventCount: 1,
      }),
    ]);
  });
});
