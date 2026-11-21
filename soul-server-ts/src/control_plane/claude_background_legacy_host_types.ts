import type {
  SessionDeliveryRow,
} from "@soulstream/wire-schema/session-delivery";
import type { ClaudeBackgroundTaskStatus } from "@soulstream/mcp-contract";

export interface ClaudeBackgroundTaskRow {
  source_node: string; session_id: string; task_id: string; sdk_session_id: string | null;
  status: ClaudeBackgroundTaskStatus; close_reason: string | null; description: string | null;
  summary: string | null; output_file: string | null; tool_use_id: string | null;
  terminal_revision: string | null; notification_delivery_id: string | null;
  created_at: Date; updated_at: Date; terminal_at: Date | null;
}

export type TerminalizeClaudeBackgroundTaskResult =
  | { accepted: true; row: ClaudeBackgroundTaskRow; delivery: SessionDeliveryRow }
  | { accepted: false; row: ClaudeBackgroundTaskRow };
