import type {
  EnqueueSessionPageBinding,
  SessionPageBindingRow,
} from "@soulstream/mcp-contract";
import type { SqlClient } from "../control_plane_types.js";

export class SessionPageBindingRepository {
  constructor(private readonly sql: SqlClient) {}

  async enqueue(input: EnqueueSessionPageBinding): Promise<SessionPageBindingRow> {
    const rows = await this.sql<SessionPageBindingRow[]>`
      INSERT INTO session_page_bindings (
        session_id, node_id, target_page_id, target_block_id, target_expected_version,
        session_type, legacy_folder_id, page_state
      ) VALUES (
        ${input.sessionId}, ${input.nodeId}, ${input.targetPageId}, ${input.targetBlockId},
        ${input.targetExpectedVersion}, ${input.sessionType},
        ${input.legacyFolderId},
        ${input.initialPageState}
      )
      ON CONFLICT (session_id) DO NOTHING
      RETURNING *
    `;
    if (rows[0]) return rows[0];
    const existing = await this.get(input.sessionId);
    if (!existing) throw new Error(`session page binding enqueue lost: ${input.sessionId}`);
    return existing;
  }

  async get(sessionId: string): Promise<SessionPageBindingRow | null> {
    const rows = await this.sql<SessionPageBindingRow[]>`
      SELECT * FROM session_page_bindings WHERE session_id = ${sessionId}
    `;
    return rows[0] ?? null;
  }

  async listForSessions(sessionIds: string[]): Promise<SessionPageBindingRow[]> {
    if (sessionIds.length === 0) return [];
    const rows = await this.sql<SessionPageBindingRow[]>`
      SELECT * FROM session_page_bindings
      WHERE session_id = ANY(${this.sql.array(sessionIds)}::text[])
    `;
    return rows;
  }

  async listDue(nodeId: string, limit = 50): Promise<SessionPageBindingRow[]> {
    const rows = await this.sql<SessionPageBindingRow[]>`
      SELECT * FROM session_page_bindings
      WHERE node_id = ${nodeId}
        AND next_retry_at <= NOW()
        AND (page_state = 'pending' OR (page_state = 'bound' AND legacy_state = 'pending'))
      ORDER BY next_retry_at, created_at
      LIMIT ${limit}
    `;
    return rows;
  }

  async markPageBound(sessionId: string): Promise<void> {
    await this.sql`
      UPDATE session_page_bindings
      SET page_state = 'bound', last_error = NULL,
          next_retry_at = NOW() + INTERVAL '30 seconds', updated_at = NOW()
      WHERE session_id = ${sessionId}
    `;
  }

  async markLegacyCompleted(sessionId: string): Promise<void> {
    await this.sql`
      UPDATE session_page_bindings
      SET legacy_state = 'completed', last_error = NULL, updated_at = NOW()
      WHERE session_id = ${sessionId}
    `;
  }

  async markFailure(
    sessionId: string,
    step: "page" | "legacy",
    error: string,
    manualRepair: boolean,
  ): Promise<void> {
    const row = await this.get(sessionId);
    const attempts = (row?.attempts ?? 0) + 1;
    const nextRetryAt = new Date(Date.now() + Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8)));
    if (step === "page") {
      await this.sql`
        UPDATE session_page_bindings
        SET page_state = ${manualRepair ? "manual_repair" : "pending"}, attempts = ${attempts},
            last_error = ${error}, next_retry_at = ${nextRetryAt}, updated_at = NOW()
        WHERE session_id = ${sessionId}
      `;
    } else {
      await this.sql`
        UPDATE session_page_bindings
        SET legacy_state = ${manualRepair ? "manual_repair" : "pending"}, attempts = ${attempts},
            last_error = ${error}, next_retry_at = ${nextRetryAt}, updated_at = NOW()
        WHERE session_id = ${sessionId}
      `;
    }
  }
}
