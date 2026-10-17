import postgres from "postgres";

import { createLiveAttachmentReadOptions } from "../../src/runtime/live_attachment_read_provider.js";
import { createLiveAttachmentReadRepository } from "../../src/runtime/live_attachment_read_repository.js";
import {
  createLiveDashboardAccessProvider,
  createPostgresDashboardUserRepository,
} from "../../src/runtime/live_dashboard_access_provider.js";
import { createLiveDbSqlResolver } from "../../src/runtime/live_db_sql.js";
import { createSessionResourceAccessProvider } from "../../src/session/session_resource_access.js";
import type { LivePostgresSql } from "../../src/runtime/live_db_sql.js";

export async function createLiveTestAttachmentService(
  sql: LivePostgresSql,
  allowedFolders: Readonly<Record<string, readonly string[]>>,
) {
  const pgSql = sql as unknown as ReturnType<typeof postgres>;
  await pgSql.unsafe(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      allowed_folder_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
    )
  `);
  for (const [email, folderIds] of Object.entries(allowedFolders)) {
    await pgSql`
      INSERT INTO users (email, is_admin, allowed_folder_ids)
      VALUES (${email}, FALSE, ${pgSql.array([...folderIds])}::TEXT[])
      ON CONFLICT (email) DO UPDATE SET is_admin=FALSE, allowed_folder_ids=EXCLUDED.allowed_folder_ids
    `;
  }
  const resolver = createLiveDbSqlResolver({ sql });
  const dashboardAccessProvider = createLiveDashboardAccessProvider({
    configProvider: {
      getConfig: () => ({}),
      requireConfig: (key: string) => { throw new Error(`unexpected config lookup for ${key}`); },
    },
    jwt: { issueToken: () => "unused", verifyToken: () => null },
    repository: createPostgresDashboardUserRepository({ sql: pgSql as never }),
  });
  const sessionResourceAccessProvider = createSessionResourceAccessProvider({
    accessProvider: dashboardAccessProvider,
    repository: {
      async getSessionAccessRecord(sessionId: string) {
        const rows = await sql<{ session_id: string; folder_id: string | null }[]>`
          SELECT session_id, folder_id FROM sessions WHERE session_id=${sessionId}
        `;
        const row = rows[0];
        return row ? { sessionId: row.session_id, folderId: row.folder_id } : null;
      },
      async listFoldersForAccess() {
        const rows = await sql<{ id: string; parent_folder_id: string | null; settings: unknown }[]>`
          SELECT id, parent_folder_id, settings FROM folders
        `;
        return rows.map((row) => ({ id: row.id, parentFolderId: row.parent_folder_id, settings: row.settings }));
      },
    },
  });
  return createLiveAttachmentReadOptions({
    repository: createLiveAttachmentReadRepository(resolver),
    resolveEmail: async () => null,
    resolveReadStorage: async () => ({
      storage: { openObject: async () => new Response(new Uint8Array([1, 2, 3])) },
      identity: "live-attachment-acl-test",
      location: { endpoint: "https://r2.example.test", bucket: "private-attachments" },
    }),
    readPageAttachmentEvidence: async () => null,
    dashboardAccessProvider,
    sessionResourceAccessProvider,
    folderProvider: {
      async listFolders() {
        const rows = await sql<{ id: string; parent_folder_id: string | null; settings: unknown; name: string }[]>`
          SELECT id, parent_folder_id, settings, name FROM folders
        `;
        return rows.map((row) => ({ id: row.id, parentFolderId: row.parent_folder_id, settings: row.settings, name: row.name }));
      },
      async listSessionAssignments() { return {}; },
    },
  }).service;
}
