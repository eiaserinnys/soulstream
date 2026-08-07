import type { LiveDbSqlResolver } from "./live_db_sql.js";

const INDEX_NAME = "idx_sessions_updated_at_session_id";

export class StableSessionOrderIndexMaintenance {
  constructor(private readonly sqlResolver: LiveDbSqlResolver) {}

  async ensure(): Promise<void> {
    const sql = await this.sqlResolver.resolveSql();
    const existing = await sql<Array<{
      readonly indisvalid: boolean;
      readonly indisready: boolean;
    }>>`
      SELECT i.indisvalid, i.indisready
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.oid = to_regclass(${INDEX_NAME})
    `;
    if (existing[0] && (!existing[0].indisvalid || !existing[0].indisready)) {
      await sql`DROP INDEX CONCURRENTLY idx_sessions_updated_at_session_id`;
    }
    await sql`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_updated_at_session_id
      ON sessions (updated_at DESC, session_id DESC)
    `;
  }
}

type MaintenanceLogger = {
  readonly info: (bindings: object, message: string) => void;
  readonly error: (bindings: object, message: string) => void;
};

export function startStableSessionOrderIndexMaintenance(
  maintenance: Pick<StableSessionOrderIndexMaintenance, "ensure">,
  logger: MaintenanceLogger,
): void {
  void maintenance.ensure()
    .then(() => logger.info({}, "Stable session order index ensured"))
    .catch((err: unknown) => logger.error(
      { err },
      "Stable session order index ensure failed; continuing without index",
    ));
}
