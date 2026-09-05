import type {
  RegisterSessionDeliveryParams,
  SessionDeliveryRow,
} from "../db/session_db_types.js";
import type { PersistenceHostTransport } from "./persistence_host_transport.js";

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

export class ClaudeBackgroundGenerationHostClient {
  constructor(private readonly transport: PersistenceHostTransport) {}

  observe(params: ObserveClaudeBackgroundTaskGenerationParams) {
    return this.transport.request<ClaudeBackgroundTaskGenerationRow>(
      "claude-runtime", "observe_background_generation", [params],
    );
  }

  terminalize(params: TerminalizeClaudeBackgroundTaskGenerationParams) {
    return this.transport.request<TerminalizeClaudeBackgroundTaskGenerationResult>(
      "claude-runtime", "terminalize_background_generation", [params],
    );
  }

  get(sourceNode: string, sessionId: string, sdkSessionId: string, taskId: string,
    initiatingToolUseId: string) {
    return this.transport.request<ClaudeBackgroundTaskGenerationRow | null>(
      "claude-runtime", "get_background_generation",
      [sourceNode, sessionId, sdkSessionId, taskId, initiatingToolUseId],
    );
  }

  activeForNode(sourceNode: string, limit = 1_000) {
    return this.transport.request<ClaudeBackgroundTaskGenerationRow[]>(
      "claude-runtime", "active_background_generations_for_node", [sourceNode, limit],
    );
  }

  activeForSession(sourceNode: string, sessionId: string, limit = 1_000) {
    return this.transport.request<ClaudeBackgroundTaskGenerationRow[]>(
      "claude-runtime", "active_background_generations_for_session",
      [sourceNode, sessionId, limit],
    );
  }

  resolve(sourceNode: string, sessionId: string, sdkSessionId: string, taskId: string) {
    return this.transport.request<ResolveClaudeBackgroundTaskGenerationResult>(
      "claude-runtime", "resolve_background_generation",
      [sourceNode, sessionId, sdkSessionId, taskId],
    );
  }
}
