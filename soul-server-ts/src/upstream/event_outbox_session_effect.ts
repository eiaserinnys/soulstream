export type SessionLastMessage = {
  type: string;
  preview: string;
  timestamp: string;
};

export type EventOutboxSessionEffect =
  | {
      kind: "last_message";
      last_message: SessionLastMessage;
      updated_at: string;
    }
  | { kind: "set_backend_session_id"; backend_session_id: string }
  | {
      kind: "rotate_backend_session_id";
      expected_backend_session_id: string;
      backend_session_id: string;
    }
  | {
      kind: "running_transition";
      review_state: string;
      expected_terminal_event_id?: number | null;
      updated_at: string;
    }
  | {
      kind: "execution_registration";
      registration_id: string;
      execution_command_id: string;
      review_state: string;
      expected_terminal_event_id?: number | null;
      updated_at: string;
    }
  | {
      /** One-release replay compatibility for pre-Wave-3 durable outboxes. */
      kind: "execution_acquire";
      owner_kind: "runner_process" | "adopted_runner" | "in_process";
      manifest_id: string;
      runtime_env_identity: string;
      registration_id: string;
      pid: number;
      start_identity: string;
      execution_command_id: string;
      lease_expires_at: string;
      review_state: string;
      expected_terminal_event_id?: number | null;
      updated_at: string;
    }
  | {
      kind: "terminal_transition";
      status: string;
      termination_reason: string;
      termination_detail: string | null;
      review_state: string;
      last_assistant_text?: string | null;
      updated_at: string;
    }
  | {
      kind: "append_metadata";
      entry: Record<string, unknown>;
      updated_at: string;
      replace_existing_type?: string;
    };
