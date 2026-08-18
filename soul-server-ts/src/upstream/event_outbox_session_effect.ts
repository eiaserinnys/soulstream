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
      kind: "execution_reserve";
      ownership_generation: number;
      owner_kind: "runner_process" | "adopted_runner" | "in_process";
      manifest_id: string;
      updated_at: string;
    }
  | {
      kind: "execution_prove";
      ownership_generation: number;
      registration_id: string;
      pid: number;
      start_identity: string;
      execution_command_id: string;
      updated_at: string;
    }
  | {
      kind: "execution_adopt_reserve";
      ownership_generation: number;
      manifest_id: string;
      previous_registration_id: string;
      pid: number;
      start_identity: string;
      execution_command_id: string;
      updated_at: string;
    }
  | {
      kind: "execution_activate";
      ownership_generation: number;
      review_state: string;
      expected_terminal_event_id?: number | null;
      updated_at: string;
    }
  | {
      kind: "execution_fail";
      ownership_generation: number;
      failure_reason: string;
      updated_at: string;
    }
  | {
      kind: "execution_orphaned_spawn";
      ownership_generation: number;
      registration_id: string;
      pid: number;
      start_identity: string;
      execution_command_id: string;
      updated_at: string;
    }
  | {
      kind: "execution_backfill";
      first_manifest_id: string | null;
      first_registration_id: string | null;
      first_pid: number | null;
      first_start_identity: string | null;
      first_execution_command_id: string | null;
      first_observed_at: string;
      second_manifest_id: string | null;
      second_registration_id: string | null;
      second_pid: number | null;
      second_start_identity: string | null;
      second_execution_command_id: string | null;
      second_observed_at: string;
      evidence_hash: string;
      minimum_lease_interval_ms: number;
      probe_only: boolean;
      updated_at: string;
    }
  | {
      kind: "runner_terminal_fact";
      ownership_generation: number;
      execution_command_id: string;
      runner_fact: "completed" | "failed" | "reaped" | "closed";
      termination_detail: string | null;
      review_state: string;
      last_assistant_text?: string | null;
      updated_at: string;
    }
  | {
      kind: "recovered_runner_terminal_fact";
      manifest_id: string;
      registration_id: string;
      pid: number;
      start_identity: string;
      execution_command_id: string;
      runner_fact: "completed" | "failed" | "reaped" | "closed";
      termination_detail: string | null;
      review_state: string;
      last_assistant_text?: string | null;
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
