import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";

export type PublicDatabaseSchema = {
  migration_id: string;
  checksum: string;
  ordinal: number;
};

export type PublicDatabaseSchemaProvider = {
  getDatabaseSchema: () => PublicDatabaseSchema | Promise<PublicDatabaseSchema>;
};

type DatabaseSchemaRow = {
  migration_id: string;
  checksum: string;
  ordinal: number;
};

export class LiveDatabaseSchemaProvider implements PublicDatabaseSchemaProvider {
  constructor(private readonly sqlResolver: LiveDbSqlResolver) {}

  async getDatabaseSchema(): Promise<PublicDatabaseSchema> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<DatabaseSchemaRow[]>`
      SELECT migration_id, checksum, ordinal::int AS ordinal
      FROM schema_migrations
      ORDER BY ordinal DESC
      LIMIT 1
    `;
    const head = rows[0];
    if (head === undefined) {
      throw new Error("database migration ledger is empty");
    }
    return head;
  }
}
