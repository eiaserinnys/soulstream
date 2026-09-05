import type {
  ClaudeBackgroundTaskGenerationRow,
  ObserveClaudeBackgroundTaskGenerationParams,
  ResolveClaudeBackgroundTaskGenerationResult,
  TerminalizeClaudeBackgroundTaskGenerationParams,
  TerminalizeClaudeBackgroundTaskGenerationResult,
} from "./claude_background_task_repository.js";
import type { SqlClient } from "../control_plane_types.js";
import { runIdempotentSessionMutation } from "./idempotent_session_mutation.js";
import { SessionDeliveryRepository } from "./session_delivery_repository.js";

/** Generation-aware sidecar owner. The legacy repository delegates here. */
export class ClaudeBackgroundTaskGenerationRepository {
  constructor(private readonly sql: SqlClient) {}

  async observe(
    params: ObserveClaudeBackgroundTaskGenerationParams,
  ): Promise<ClaudeBackgroundTaskGenerationRow> {
    const operation = async (sql: SqlClient) =>
      await this.observeWithSql(sql, params);
    if (params.idempotencyKey) {
      return await runIdempotentSessionMutation(
        this.sql,
        "runner_claude_background_generation_observe",
        { ...params, idempotencyKey: params.idempotencyKey },
        operation,
      );
    }
    return await this.withTransaction(operation);
  }

  async terminalize(
    params: TerminalizeClaudeBackgroundTaskGenerationParams,
  ): Promise<TerminalizeClaudeBackgroundTaskGenerationResult> {
    const operation = async (sql: SqlClient) =>
      await this.terminalizeWithSql(sql, params);
    if (params.idempotencyKey) {
      return await runIdempotentSessionMutation(
        this.sql,
        "runner_claude_background_generation_terminalize",
        { ...params, idempotencyKey: params.idempotencyKey },
        operation,
      );
    }
    return await this.withTransaction(operation);
  }

  async get(
    sourceNode: string,
    sessionId: string,
    sdkSessionId: string,
    taskId: string,
    initiatingToolUseId: string,
  ): Promise<ClaudeBackgroundTaskGenerationRow | null> {
    const rows = await this.sql<ClaudeBackgroundTaskGenerationRow[]>`
      SELECT * FROM claude_background_task_generations
      WHERE source_node = ${sourceNode}
        AND session_id = ${sessionId}
        AND sdk_session_id = ${sdkSessionId}
        AND task_id = ${taskId}
        AND initiating_tool_use_id = ${initiatingToolUseId}
    `;
    return rows[0] ?? null;
  }

  async activeForNode(
    sourceNode: string,
    limit = 1_000,
  ): Promise<ClaudeBackgroundTaskGenerationRow[]> {
    return await this.sql<ClaudeBackgroundTaskGenerationRow[]>`
      SELECT * FROM claude_background_task_generations
      WHERE source_node = ${sourceNode}
        AND status IN ('pending', 'running')
      ORDER BY generation_sequence
      LIMIT ${limit}
    `;
  }

  async activeForSession(
    sourceNode: string,
    sessionId: string,
    limit = 1_000,
  ): Promise<ClaudeBackgroundTaskGenerationRow[]> {
    return await this.sql<ClaudeBackgroundTaskGenerationRow[]>`
      SELECT * FROM claude_background_task_generations
      WHERE source_node = ${sourceNode}
        AND session_id = ${sessionId}
        AND status IN ('pending', 'running')
      ORDER BY generation_sequence
      LIMIT ${limit}
    `;
  }

  async resolve(
    sourceNode: string,
    sessionId: string,
    sdkSessionId: string,
    taskId: string,
  ): Promise<ResolveClaudeBackgroundTaskGenerationResult> {
    const rows = await this.sql<ClaudeBackgroundTaskGenerationRow[]>`
      SELECT generation.*
      FROM claude_background_task_generations AS generation
      LEFT JOIN session_delivery_relation_consumptions AS consumption
        ON consumption.relation_key = generation.relation_key
      WHERE generation.source_node = ${sourceNode}
        AND generation.session_id = ${sessionId}
        AND generation.sdk_session_id = ${sdkSessionId}
        AND generation.task_id = ${taskId}
        AND consumption.relation_key IS NULL
      ORDER BY generation.generation_sequence
      LIMIT 2
    `;
    if (rows.length === 0) return { status: "absent" };
    if (rows.length > 1) return { status: "ambiguous" };
    return { status: "resolved", row: rows[0]! };
  }

  private async observeWithSql(
    transaction: SqlClient,
    params: ObserveClaudeBackgroundTaskGenerationParams,
  ): Promise<ClaudeBackgroundTaskGenerationRow> {
    await transaction`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${`claude_background_generation:${params.sourceNode}:${params.sessionId}:${params.taskId}`},
          0
        )
      )
    `;
    const observedAt = params.observedAt ?? new Date();
    const rows = await transaction<ClaudeBackgroundTaskGenerationRow[]>`
      INSERT INTO claude_background_task_generations (
        source_node, session_id, sdk_session_id, task_id,
        initiating_tool_use_id, generation_key, relation_key, completion_id,
        status, description, summary, output_file, created_at, updated_at
      ) VALUES (
        ${params.sourceNode}, ${params.sessionId}, ${params.sdkSessionId},
        ${params.taskId}, ${params.initiatingToolUseId}, ${params.generationKey},
        ${params.relationKey}, ${params.completionId},
        ${params.status ?? "running"}, ${params.description ?? null},
        ${params.summary ?? null}, ${params.outputFile ?? null},
        ${observedAt}, ${observedAt}
      )
      ON CONFLICT (
        source_node, session_id, sdk_session_id, task_id, initiating_tool_use_id
      ) DO UPDATE SET
        status = EXCLUDED.status,
        description = COALESCE(EXCLUDED.description, claude_background_task_generations.description),
        summary = COALESCE(EXCLUDED.summary, claude_background_task_generations.summary),
        output_file = COALESCE(EXCLUDED.output_file, claude_background_task_generations.output_file),
        updated_at = EXCLUDED.updated_at
      WHERE claude_background_task_generations.status IN ('pending', 'running')
        AND claude_background_task_generations.generation_key = EXCLUDED.generation_key
        AND claude_background_task_generations.relation_key = EXCLUDED.relation_key
        AND claude_background_task_generations.completion_id = EXCLUDED.completion_id
      RETURNING *
    `;
    const row = rows[0] ?? await this.require(transaction, params);
    this.assertIdentity(row, params);
    await this.projectLegacy(transaction, row);
    return row;
  }

  private async terminalizeWithSql(
    transaction: SqlClient,
    params: TerminalizeClaudeBackgroundTaskGenerationParams,
  ): Promise<TerminalizeClaudeBackgroundTaskGenerationResult> {
    const observedAt = params.observedAt ?? new Date();
    await this.observeWithSql(transaction, {
      ...params,
      status: "running",
      observedAt,
    });
    const transitioned = await transaction<ClaudeBackgroundTaskGenerationRow[]>`
      UPDATE claude_background_task_generations
      SET
        status = ${params.status},
        close_reason = ${params.closeReason},
        description = COALESCE(${params.description ?? null}, description),
        summary = COALESCE(${params.summary ?? null}, summary),
        output_file = COALESCE(${params.outputFile ?? null}, output_file),
        terminal_revision = ${params.terminalRevision},
        terminal_at = ${observedAt},
        updated_at = ${observedAt}
      WHERE source_node = ${params.sourceNode}
        AND session_id = ${params.sessionId}
        AND sdk_session_id = ${params.sdkSessionId}
        AND task_id = ${params.taskId}
        AND initiating_tool_use_id = ${params.initiatingToolUseId}
        AND status IN ('pending', 'running')
      RETURNING *
    `;
    if (!transitioned[0]) {
      return { accepted: false, row: await this.require(transaction, params) };
    }

    const targetExists = params.delivery.targetSessionId
      ? await transaction<Array<{ present: number }>>`
          SELECT 1 AS present FROM sessions
          WHERE session_id = ${params.delivery.targetSessionId}
          FOR KEY SHARE
        `
      : [];
    const registered = await new SessionDeliveryRepository(transaction).register({
      ...params.delivery,
      targetSessionId: targetExists[0]
        ? params.delivery.targetSessionId
        : undefined,
    });
    if (registered.conflict) {
      throw new Error(
        `Claude background generation delivery identity conflict: ${params.delivery.deliveryId}`,
      );
    }
    const rows = await transaction<ClaudeBackgroundTaskGenerationRow[]>`
      UPDATE claude_background_task_generations
      SET notification_delivery_id = ${registered.row.delivery_id}
      WHERE source_node = ${params.sourceNode}
        AND session_id = ${params.sessionId}
        AND sdk_session_id = ${params.sdkSessionId}
        AND task_id = ${params.taskId}
        AND initiating_tool_use_id = ${params.initiatingToolUseId}
      RETURNING *
    `;
    const row = rows[0]!;
    await this.projectLegacy(transaction, row);
    return { accepted: true, row, delivery: registered.row };
  }

  private async require(
    sql: SqlClient,
    params: Pick<
      ObserveClaudeBackgroundTaskGenerationParams,
      "sourceNode" | "sessionId" | "sdkSessionId" | "taskId" | "initiatingToolUseId"
    >,
  ): Promise<ClaudeBackgroundTaskGenerationRow> {
    const rows = await sql<ClaudeBackgroundTaskGenerationRow[]>`
      SELECT * FROM claude_background_task_generations
      WHERE source_node = ${params.sourceNode}
        AND session_id = ${params.sessionId}
        AND sdk_session_id = ${params.sdkSessionId}
        AND task_id = ${params.taskId}
        AND initiating_tool_use_id = ${params.initiatingToolUseId}
    `;
    const row = rows[0];
    if (!row) {
      throw new Error(`Claude background generation disappeared: ${params.taskId}`);
    }
    return row;
  }

  private assertIdentity(
    row: ClaudeBackgroundTaskGenerationRow,
    params: Pick<
      ObserveClaudeBackgroundTaskGenerationParams,
      "generationKey" | "relationKey" | "completionId"
    >,
  ): void {
    if (
      row.generation_key !== params.generationKey
      || row.relation_key !== params.relationKey
      || row.completion_id !== params.completionId
    ) {
      throw new Error(
        `Claude background generation identity conflict: ${params.generationKey}`,
      );
    }
  }

  private async projectLegacy(
    transaction: SqlClient,
    row: ClaudeBackgroundTaskGenerationRow,
  ): Promise<void> {
    const latestRows = await transaction<Array<{ generation_key: string }>>`
      SELECT generation_key
      FROM claude_background_task_generations
      WHERE source_node = ${row.source_node}
        AND session_id = ${row.session_id}
        AND task_id = ${row.task_id}
      ORDER BY generation_sequence DESC
      LIMIT 1
    `;
    if (latestRows[0]?.generation_key !== row.generation_key) return;
    await transaction`
      INSERT INTO claude_background_tasks (
        source_node, session_id, task_id, sdk_session_id, status,
        close_reason, description, summary, output_file, tool_use_id,
        terminal_revision, notification_delivery_id,
        created_at, updated_at, terminal_at
      ) VALUES (
        ${row.source_node}, ${row.session_id}, ${row.task_id}, ${row.sdk_session_id},
        ${row.status}, ${row.close_reason}, ${row.description}, ${row.summary},
        ${row.output_file}, ${row.initiating_tool_use_id}, ${row.terminal_revision},
        ${row.notification_delivery_id}, ${row.created_at}, ${row.updated_at},
        ${row.terminal_at}
      )
      ON CONFLICT (source_node, session_id, task_id) DO UPDATE SET
        sdk_session_id = EXCLUDED.sdk_session_id,
        status = EXCLUDED.status,
        close_reason = EXCLUDED.close_reason,
        description = COALESCE(EXCLUDED.description, claude_background_tasks.description),
        summary = COALESCE(EXCLUDED.summary, claude_background_tasks.summary),
        output_file = COALESCE(EXCLUDED.output_file, claude_background_tasks.output_file),
        tool_use_id = EXCLUDED.tool_use_id,
        terminal_revision = EXCLUDED.terminal_revision,
        notification_delivery_id = EXCLUDED.notification_delivery_id,
        updated_at = EXCLUDED.updated_at,
        terminal_at = EXCLUDED.terminal_at
      WHERE claude_background_tasks.status IN ('pending', 'running')
    `;
  }

  private async withTransaction<T>(
    operation: (transaction: SqlClient) => Promise<T>,
  ): Promise<T> {
    return await this.sql.begin(async (transaction) =>
      await operation(transaction as unknown as SqlClient)) as T;
  }
}
