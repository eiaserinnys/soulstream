import postgres from "postgres";
import { createBoardYjsSqlAdapter } from "../board-yjs/board_yjs_sql.js";
import type { LivePostgresSql } from "../runtime/live_db_sql.js";
import { migrateFolderStorageDocuments } from "./folder_storage_migration_runner.js";

export async function runFolderStorageMigration(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    return await migrateFolderStorageDocuments(createBoardYjsSqlAdapter(sql as unknown as LivePostgresSql));
  } finally {
    await sql.end();
  }
}
