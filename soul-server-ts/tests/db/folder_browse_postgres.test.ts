import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FolderBrowseService,
  createFolderBrowseStore,
} from "../../src/catalog/folder_browse_service.js";
import { SessionDB } from "../../src/db/session_db.js";
import type { FolderHostClient } from "../../src/folder/folder_host_client.js";
import { FolderControlPlaneService } from "../../../orch-server-ts/src/folders/folder_control_plane_service.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";
import { configureTestBoardProjectionReadHost } from "../helpers/configure_test_board_projection_host.js";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;

describePostgres("folder browse PostgreSQL integration", () => {
  let harness: FullSchemaPostgresHarness | undefined;
  let service: FolderBrowseService;

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
        id, folder_id, item_type, item_id, metadata
      ) VALUES
        ('session:session-named', 'container-folder', 'session', 'session-named', '{}'),
        ('markdown:doc-spec', 'container-folder', 'markdown', 'doc-spec', '{}'),
        ('asset:asset-diagram', 'container-folder', 'asset', 'asset-diagram', '{}')
    `;
    await sql`
      INSERT INTO board_items (
        id, folder_id, item_type, item_id, metadata, updated_at
      )
      SELECT
        'frame:' || value, 'container-folder',
        'frame', 'frame-' || value, jsonb_build_object('title', 'Frame ' || value),
        NOW() - make_interval(secs => value)
      FROM generate_series(1, 205) AS value
    `;
    await sql`
      INSERT INTO folders (id, name, sort_order)
      VALUES ('large-search-folder', 'Large Search Folder', 2)
    `;
    await sql`
      INSERT INTO sessions (
        session_id, folder_id, display_name, status, session_type, agent_id,
        created_at, updated_at
      )
      SELECT
        'large-session-' || value,
        'large-search-folder',
        'Large Session ' || value,
        'completed',
        'llm',
        'roselin_codex',
        NOW() - make_interval(secs => value),
        NOW() - make_interval(secs => value)
      FROM generate_series(1, 2005) AS value
    `;
    await sql`
      INSERT INTO board_items (
        id, folder_id, item_type, item_id, metadata, updated_at
      )
      SELECT
        'session:large-session-' || value,
        'large-search-folder',
        'session',
        'large-session-' || value,
        '{}',
        NOW() - make_interval(secs => value)
      FROM generate_series(1, 2005) AS value
    `;
    const db = new SessionDB();
    configureTestBoardProjectionReadHost(db, sql);
    db.configureFolderHost(
      new FolderControlPlaneService(sql as never) as unknown as FolderHostClient,
    );
    service = new FolderBrowseService(createFolderBrowseStore(db));
  }, 45_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 15_000);

  it("pages hundreds of folder items", async () => {
    const result = await service.browse({
      folderId: "container-folder",
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
    expect(result).not.toHaveProperty("search");
  });

  it("searches only session display names and markdown title/body in the folder", async () => {
    const markdown = await service.search({
      folderId: "container-folder",
      query: "searchable details",
      limit: 999,
    });
    expect(markdown.page.limit).toBe(50);
    expect(markdown.items).toEqual([
      expect.objectContaining({ type: "markdown", id: "doc-spec", title: "Spec Document" }),
    ]);
    expect(markdown.search).toEqual({
      scanLimit: 2_000,
      scannedItems: 2,
      truncated: false,
    });

    const session = await service.search({
      folderId: "container-folder",
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

  it("caps a large zero-match search and reports the truncation explicitly", async () => {
    const result = await service.search({
      folderId: "large-search-folder",
      query: "존재하지 않는 검색어",
    });

    expect(result.items).toEqual([]);
    expect(result.search).toEqual({
      scanLimit: 2_000,
      scannedItems: 2_000,
      truncated: true,
    });
  });
});
