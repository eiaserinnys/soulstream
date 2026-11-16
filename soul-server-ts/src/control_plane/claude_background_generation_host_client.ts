import type {
  RegisterSessionDeliveryParams,
  SessionDeliveryRow,
} from "../db/session_db_types.js";
import {
  ORCH_HOST_REQUEST_TIMEOUT_MS,
  requestHostOperationWithRetry,
  type PersistenceHostTransport,
} from "./persistence_host_transport.js";

export type ClaudeBackgroundGenerationStatus =
  | "pending" | "running" | "completed" | "failed" | "stopped" | "killed";
export type ClaudeBackgroundGenerationTerminalStatus = Exclude<
  ClaudeBackgroundGenerationStatus,
  "pending" | "running"
>;

export interface ClaudeBackgroundTaskGenerationRow {
  source_node: string; session_id: string; sdk_session_id: string; task_id: string;
  initiating_tool_use_id: string; generation_sequence: string | number;
  generation_key: string; relation_key: string; completion_id: string;
  runner_registration_id: string | null; execution_command_id: string | null;
  status: ClaudeBackgroundGenerationStatus; close_reason: string | null;
  description: string | null; summary: string | null; output_file: string | null;
  terminal_revision: string | null; notification_delivery_id: string | null;
  created_at: Date; updated_at: Date; terminal_at: Date | null;
}

export interface ObserveClaudeBackgroundTaskGenerationParams {
  idempotencyKey?: string;
  sourceNode: string; sessionId: string; taskId: string; sdkSessionId: string;
  initiatingToolUseId: string; generationKey: string; relationKey: string;
  completionId: string; status?: "pending" | "running"; description?: string;
  runnerRegistrationId?: string; executionCommandId?: string;
  summary?: string; outputFile?: string; observedAt?: Date;
}

export interface TerminalizeClaudeBackgroundTaskGenerationParams
  extends Omit<ObserveClaudeBackgroundTaskGenerationParams, "status"> {
  status: ClaudeBackgroundGenerationTerminalStatus;
  closeReason: string;
  terminalRevision: string;
  delivery: RegisterSessionDeliveryParams;
}

export type TerminalizeClaudeBackgroundTaskGenerationResult =
  | { accepted: true; row: ClaudeBackgroundTaskGenerationRow; delivery: SessionDeliveryRow }
  | { accepted: false; row: ClaudeBackgroundTaskGenerationRow };
export type ResolveClaudeBackgroundTaskGenerationResult =
  | { status: "absent" }
  | { status: "resolved"; row: ClaudeBackgroundTaskGenerationRow }
  | { status: "ambiguous" };

/**
 * Covers a ~66s core restart (nginx answers 502 while the orchestrator is
 * down) with about 20s of headroom. The retry helper makes one more attempt
 * than there are delays.
 */
export const CLAUDE_BACKGROUND_GENERATION_RETRY_DELAYS_MS = [
  500, 1_000, 2_000, 4_000, 8_000, 12_000, 15_000, 15_000, 15_000, 15_000,
] as const;

export class ClaudeBackgroundGenerationHostClient {
  constructor(
    private readonly transport: PersistenceHostTransport,
    private readonly retryDelaysMs: readonly number[] =
      CLAUDE_BACKGROUND_GENERATION_RETRY_DELAYS_MS,
  ) {}

  /** A failed observation is swallowed by the caller, but the turn still waits for it. */
  observe(params: ObserveClaudeBackgroundTaskGenerationParams) {
    return requestHostOperationWithRetry<ClaudeBackgroundTaskGenerationRow>(
      this.transport, "claude-runtime", "observe_background_generation", [params],
      {
        timeoutMs: 2_000,
        attempts: this.retryDelaysMs.length + 1,
        retryDelaysMs: this.retryDelaysMs,
      },
    );
  }

  terminalize(params: TerminalizeClaudeBackgroundTaskGenerationParams) {
    return requestHostOperationWithRetry<TerminalizeClaudeBackgroundTaskGenerationResult>(
      this.transport, "claude-runtime", "terminalize_background_generation", [params],
      {
        timeoutMs: ORCH_HOST_REQUEST_TIMEOUT_MS,
        attempts: this.retryDelaysMs.length + 1,
        retryDelaysMs: this.retryDelaysMs,
      },
    );
  }

  get(sourceNode: string, sessionId: string, sdkSessionId: string, taskId: string,
    initiatingToolUseId: string) {
    return this.transport.request<ClaudeBackgroundTaskGenerationRow | null>(
      "claude-runtime", "get_background_generation",
      [sourceNode, sessionId, sdkSessionId, taskId, initiatingToolUseId],
    );
  }

  activeForExecution(sourceNode: string, sessionId: string,
    runnerRegistrationId: string, executionCommandId: string, limit = 1_000) {
    return this.transport.request<ClaudeBackgroundTaskGenerationRow[]>(
      "claude-runtime", "active_background_generations_for_execution",
      [sourceNode, sessionId, runnerRegistrationId, executionCommandId, limit],
    );
  }

  /** The resolve read has no side effects, so a lost response is safe to retry. */
  resolve(sourceNode: string, sessionId: string, sdkSessionId: string, taskId: string) {
    return requestHostOperationWithRetry<ResolveClaudeBackgroundTaskGenerationResult>(
      this.transport, "claude-runtime", "resolve_background_generation",
      [sourceNode, sessionId, sdkSessionId, taskId],
      {
        timeoutMs: ORCH_HOST_REQUEST_TIMEOUT_MS,
        attempts: this.retryDelaysMs.length + 1,
        retryDelaysMs: this.retryDelaysMs,
      },
    );
  }
}
