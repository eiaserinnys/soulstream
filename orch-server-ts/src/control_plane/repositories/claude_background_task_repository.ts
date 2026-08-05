import type {
  RegisterSessionDeliveryParams,
  SessionDeliveryRow,
  SqlClient,
} from "../control_plane_types.js";
import { SessionDeliveryRepository } from "./session_delivery_repository.js";

export type ClaudeBackgroundTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "killed";

export type ClaudeBackgroundTerminalStatus = Exclude<
  ClaudeBackgroundTaskStatus,
  "pending" | "running"
>;

export interface ClaudeBackgroundTaskRow {
  source_node: string;
  session_id: string;
  task_id: string;
  sdk_session_id: string | null;
  status: ClaudeBackgroundTaskStatus;
  close_reason: string | null;
  description: string | null;
  summary: string | null;
  output_file: string | null;
  tool_use_id: string | null;
  terminal_revision: string | null;
  notification_delivery_id: string | null;
  created_at: Date;
  updated_at: Date;
  terminal_at: Date | null;
}
export interface ObserveClaudeBackgroundTaskParams {
  sourceNode: string;
  sessionId: string;
  taskId: string;
  sdkSessionId?: string;
  status?: "pending" | "running";
  description?: string;
  summary?: string;
  outputFile?: string;
  toolUseId?: string;
  observedAt?: Date;
}

export interface TerminalizeClaudeBackgroundTaskParams
  extends Omit<ObserveClaudeBackgroundTaskParams, "status"> {
  status: ClaudeBackgroundTerminalStatus;
  closeReason: string;
  terminalRevision: string;
  delivery: RegisterSessionDeliveryParams;
}

export type TerminalizeClaudeBackgroundTaskResult =
  | {
      accepted: true;
      row: ClaudeBackgroundTaskRow;
      delivery: SessionDeliveryRow;
    }
  | {
      accepted: false;
      row: ClaudeBackgroundTaskRow;
    };

/** PostgreSQL CAS owner for background state and its semantic delivery outbox. */
export class ClaudeBackgroundTaskRepository {
  constructor(private readonly sql: SqlClient) {}

  async observe(
    params: ObserveClaudeBackgroundTaskParams,
  ): Promise<ClaudeBackgroundTaskRow> {
    const observedAt = params.observedAt ?? new Date();
    const rows = await this.sql<ClaudeBackgroundTaskRow[]>`
      INSERT INTO claude_background_tasks (
        source_node, session_id, task_id, sdk_session_id, status,
        description, summary, output_file, tool_use_id, created_at, updated_at
      ) VALUES (
        ${params.sourceNode}, ${params.sessionId}, ${params.taskId},
        ${params.sdkSessionId ?? null}, ${params.status ?? "running"},
        ${params.description ?? null}, ${params.summary ?? null},
        ${params.outputFile ?? null}, ${params.toolUseId ?? null},
        ${observedAt}, ${observedAt}
      )
      ON CONFLICT (source_node, session_id, task_id) DO UPDATE
      SET
        sdk_session_id = COALESCE(EXCLUDED.sdk_session_id, claude_background_tasks.sdk_session_id),
        status = EXCLUDED.status,
        description = COALESCE(EXCLUDED.description, claude_background_tasks.description),
        summary = COALESCE(EXCLUDED.summary, claude_background_tasks.summary),
        output_file = COALESCE(EXCLUDED.output_file, claude_background_tasks.output_file),
        tool_use_id = COALESCE(EXCLUDED.tool_use_id, claude_background_tasks.tool_use_id),
        updated_at = EXCLUDED.updated_at
      WHERE claude_background_tasks.status IN ('pending', 'running')
      RETURNING *
    `;
    if (rows[0]) return rows[0];
    const existing = await this.get(params.sourceNode, params.sessionId, params.taskId);
    if (!existing) throw new Error(`Claude background task disappeared: ${params.taskId}`);
    return existing;
  }

  async terminalize(
    params: TerminalizeClaudeBackgroundTaskParams,
  ): Promise<TerminalizeClaudeBackgroundTaskResult> {
    return await this.sql.begin(async (transaction) => {
      const observedAt = params.observedAt ?? new Date();
      await transaction`
        INSERT INTO claude_background_tasks (
          source_node, session_id, task_id, sdk_session_id, status,
          description, summary, output_file, tool_use_id, created_at, updated_at
        ) VALUES (
          ${params.sourceNode}, ${params.sessionId}, ${params.taskId},
          ${params.sdkSessionId ?? null}, 'running',
          ${params.description ?? null}, ${params.summary ?? null},
          ${params.outputFile ?? null}, ${params.toolUseId ?? null},
          ${observedAt}, ${observedAt}
        )
        ON CONFLICT (source_node, session_id, task_id) DO NOTHING
      `;
      const transitioned = await transaction<ClaudeBackgroundTaskRow[]>`
        UPDATE claude_background_tasks
        SET
          sdk_session_id = COALESCE(${params.sdkSessionId ?? null}, sdk_session_id),
          status = ${params.status},
          close_reason = ${params.closeReason},
          description = COALESCE(${params.description ?? null}, description),
          summary = COALESCE(${params.summary ?? null}, summary),
          output_file = COALESCE(${params.outputFile ?? null}, output_file),
          tool_use_id = COALESCE(${params.toolUseId ?? null}, tool_use_id),
          terminal_revision = ${params.terminalRevision},
          terminal_at = ${observedAt},
          updated_at = ${observedAt}
        WHERE source_node = ${params.sourceNode}
          AND session_id = ${params.sessionId}
          AND task_id = ${params.taskId}
          AND status IN ('pending', 'running')
        RETURNING *
      `;
      if (!transitioned[0]) {
        const rows = await transaction<ClaudeBackgroundTaskRow[]>`
          SELECT * FROM claude_background_tasks
          WHERE source_node = ${params.sourceNode}
            AND session_id = ${params.sessionId}
            AND task_id = ${params.taskId}
        `;
        if (!rows[0]) throw new Error(`Claude background task disappeared: ${params.taskId}`);
        return { accepted: false, row: rows[0] };
      }

      const deliveries = new SessionDeliveryRepository(
        transaction as unknown as SqlClient,
      );
      const targetExists = params.delivery.targetSessionId
        ? await transaction<Array<{ present: number }>>`
            SELECT 1 AS present
            FROM sessions
            WHERE session_id = ${params.delivery.targetSessionId}
            FOR KEY SHARE
          `
        : [];
      const registered = await deliveries.register({
        ...params.delivery,
        targetSessionId: targetExists[0]
          ? params.delivery.targetSessionId
          : undefined,
      });
      if (registered.conflict) {
        throw new Error(`Claude background delivery identity conflict: ${params.delivery.deliveryId}`);
      }
      const rows = await transaction<ClaudeBackgroundTaskRow[]>`
        UPDATE claude_background_tasks
        SET notification_delivery_id = ${registered.row.delivery_id}
        WHERE source_node = ${params.sourceNode}
          AND session_id = ${params.sessionId}
          AND task_id = ${params.taskId}
        RETURNING *
      `;
      return {
        accepted: true,
        row: rows[0]!,
        delivery: registered.row,
      };
    });
  }

  async get(
    sourceNode: string,
    sessionId: string,
    taskId: string,
  ): Promise<ClaudeBackgroundTaskRow | null> {
    const rows = await this.sql<ClaudeBackgroundTaskRow[]>`
      SELECT * FROM claude_background_tasks
      WHERE source_node = ${sourceNode}
        AND session_id = ${sessionId}
        AND task_id = ${taskId}
    `;
    return rows[0] ?? null;
  }

  async activeForNode(
    sourceNode: string,
    limit = 1_000,
  ): Promise<ClaudeBackgroundTaskRow[]> {
    return await this.sql<ClaudeBackgroundTaskRow[]>`
      SELECT * FROM claude_background_tasks
      WHERE source_node = ${sourceNode}
        AND status IN ('pending', 'running')
      ORDER BY updated_at, session_id, task_id
      LIMIT ${limit}
    `;
  }
}
