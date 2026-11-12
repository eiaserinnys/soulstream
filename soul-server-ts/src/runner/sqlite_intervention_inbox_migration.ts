import { withRunnerSqliteTransactionSync } from "./runner_sqlite_connection.js";

type SqliteDatabase = InstanceType<typeof import("node:sqlite").DatabaseSync>;

/**
 * 옛 러너 db 파일을 그대로 열기 위한 v9 마이그레이션만 남긴다.
 * 표는 더 이상 읽거나 쓰지 않지만, 정의와 압축의 NOT EXISTS 방어는
 * 은퇴한 러너가 남긴 파일과 이어 쓰기 위해 그대로 둔다.
 */
export function migrateRunnerInterventionInboxV9(
  database: SqliteDatabase,
  previousVersion: number,
): void {
  withRunnerSqliteTransactionSync(database, () => {
    const columns = database.prepare(
      "PRAGMA table_info(runner_intervention_inbox)",
    ).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "application_state")) {
      database.exec(`
        ALTER TABLE runner_intervention_inbox
        ADD COLUMN application_state TEXT NOT NULL DEFAULT 'pending' CHECK (
          application_state IN ('pending', 'claimed', 'ambiguous')
        )
      `);
    }
    if (previousVersion < 9) {
      // Always repair the intermediate state left by the former split migration:
      // ALTER may already exist while backfill and user_version are still v8.
      database.prepare(`
        UPDATE runner_intervention_inbox SET application_state = 'claimed'
        WHERE application_state = 'pending'
          AND claimed_execution_command_id IS NOT NULL
      `).run();
    }
    if (previousVersion < 9) database.exec("PRAGMA user_version = 9");
  }, { transactionLabel: "intervention_inbox.migrate_v9" });
}
