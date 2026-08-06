import type { SqlClient } from "../session_db_types.js";

export class SessionRepository {
  constructor(private readonly sql: SqlClient) {}

  async ensureStableSessionOrderIndex(): Promise<void> {
    const existing = await this.sql<Array<{ indisvalid: boolean; indisready: boolean }>>`
      SELECT i.indisvalid, i.indisready
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.oid = to_regclass('idx_sessions_updated_at_session_id')
    `;
    const state = existing[0];
    if (state && (!state.indisvalid || !state.indisready)) {
      await this.sql`
        DROP INDEX CONCURRENTLY idx_sessions_updated_at_session_id
      `;
    }

    await this.sql`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_updated_at_session_id
      ON sessions (updated_at DESC, session_id DESC)
    `;
  }
}
