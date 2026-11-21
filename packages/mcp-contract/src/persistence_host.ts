import type { RegisterSessionDeliveryParams } from "@soulstream/wire-schema/session-delivery";

export type BindingStepState = "pending" | "bound" | "completed" | "manual_repair";

export interface SessionPageBindingRow {
  session_id: string;
  node_id: string;
  target_page_id: string | null;
  target_block_id: string | null;
  target_expected_version: number | null;
  daily_date: string;
  session_type: string;
  legacy_folder_id: string | null;
  page_state: "pending" | "bound" | "manual_repair";
  legacy_state: "pending" | "completed" | "manual_repair";
  attempts: number;
  last_error: string | null;
  next_retry_at: Date;
}

export interface ClaudeBackgroundTaskKey {
  sessionId: string;
  taskId: string;
}

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

export interface ObserveClaudeBackgroundTaskParams {
  idempotencyKey?: string;
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

export interface ClaudeBackgroundTaskGenerationRow {
  source_node: string;
  session_id: string;
  sdk_session_id: string;
  task_id: string;
  initiating_tool_use_id: string;
  generation_sequence: string | number;
  generation_key: string;
  relation_key: string;
  completion_id: string;
  runner_registration_id: string | null;
  execution_command_id: string | null;
  status: ClaudeBackgroundTaskStatus;
  close_reason: string | null;
  description: string | null;
  summary: string | null;
  output_file: string | null;
  terminal_revision: string | null;
  notification_delivery_id: string | null;
  created_at: Date;
  updated_at: Date;
  terminal_at: Date | null;
}

export type ResolveClaudeBackgroundTaskGenerationResult =
  | { status: "absent" }
  | { status: "resolved"; row: ClaudeBackgroundTaskGenerationRow }
  | { status: "ambiguous" };

export type RegisterSessionDeliveryRequest = RegisterSessionDeliveryParams & {
  reviveDeadLetter?: boolean;
};
