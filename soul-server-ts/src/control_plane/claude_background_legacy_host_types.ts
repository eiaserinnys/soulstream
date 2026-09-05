import type {
  RegisterSessionDeliveryParams,
  SessionDeliveryRow,
} from "../db/session_db_types.js";

export type ClaudeBackgroundTaskStatus =
  | "pending" | "running" | "completed" | "failed" | "stopped" | "killed";
export type ClaudeBackgroundTerminalStatus = Exclude<
  ClaudeBackgroundTaskStatus,
  "pending" | "running"
>;

export interface ClaudeBackgroundTaskRow {
  source_node: string; session_id: string; task_id: string; sdk_session_id: string | null;
  status: ClaudeBackgroundTaskStatus; close_reason: string | null; description: string | null;
  summary: string | null; output_file: string | null; tool_use_id: string | null;
  terminal_revision: string | null; notification_delivery_id: string | null;
  created_at: Date; updated_at: Date; terminal_at: Date | null;
}

export interface ObserveClaudeBackgroundTaskParams {
  idempotencyKey?: string;
  sourceNode: string; sessionId: string; taskId: string; sdkSessionId?: string;
  status?: "pending" | "running"; description?: string; summary?: string;
  outputFile?: string; toolUseId?: string; observedAt?: Date;
}

export interface TerminalizeClaudeBackgroundTaskParams
  extends Omit<ObserveClaudeBackgroundTaskParams, "status"> {
  status: ClaudeBackgroundTerminalStatus; closeReason: string; terminalRevision: string;
  delivery: RegisterSessionDeliveryParams;
}

export type TerminalizeClaudeBackgroundTaskResult =
  | { accepted: true; row: ClaudeBackgroundTaskRow; delivery: SessionDeliveryRow }
  | { accepted: false; row: ClaudeBackgroundTaskRow };
