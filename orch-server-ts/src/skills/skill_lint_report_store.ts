import type { SqlClient } from "../control_plane/control_plane_types.js";

export const SKILL_LINT_REPORT_SETTING_KEY = "skill_lint_report";

export type StoredSkillLintReport = {
  report: Record<string, unknown>;
  uploaded_at: string;
  uploaded_by_session_id: string | null;
  uploaded_by_node_id: string | null;
  /** 이 보고를 만드는 반복 예약 작업. 예약 실행이 올릴 때 잇고, 아니면 이전 값을 유지한다. */
  verify_job_id: string | null;
};

export type PutSkillLintReportInput = {
  report: Record<string, unknown>;
  sessionId: string | null;
  nodeId: string;
  /** 부른 세션이 반복 예약 실행이면 그 job_id. */
  verifyJobId: string | null;
};

type Row = { value: StoredSkillLintReport };

/** system_settings 키 하나에 마지막 보고 한 건만 덮어쓴다. 이력과 새 테이블은 없다. */
export class SkillLintReportStore {
  constructor(private readonly sql: () => Promise<SqlClient>) {}

  async get(): Promise<StoredSkillLintReport | null> {
    const sql = await this.sql();
    const rows = await sql<Row[]>`SELECT value FROM system_settings WHERE setting_key = ${SKILL_LINT_REPORT_SETTING_KEY}`;
    return rows[0]?.value ?? null;
  }

  async put(input: PutSkillLintReportInput): Promise<StoredSkillLintReport> {
    const previous = await this.get();
    const value: StoredSkillLintReport = {
      report: input.report,
      uploaded_at: new Date().toISOString(),
      uploaded_by_session_id: input.sessionId,
      uploaded_by_node_id: input.nodeId,
      verify_job_id: input.verifyJobId ?? previous?.verify_job_id ?? null,
    };
    const sql = await this.sql();
    const updatedBy = input.sessionId ?? input.nodeId;
    await sql`INSERT INTO system_settings (setting_key, value, version, updated_at, updated_by)
      VALUES (${SKILL_LINT_REPORT_SETTING_KEY}, ${sql.json(value as never)}, 1, NOW(), ${updatedBy})
      ON CONFLICT (setting_key) DO UPDATE
      SET value = EXCLUDED.value, version = system_settings.version + 1, updated_at = NOW(), updated_by = EXCLUDED.updated_by`;
    return value;
  }
}

export type SkillLintReportStorePort = Pick<SkillLintReportStore, "get" | "put">;
