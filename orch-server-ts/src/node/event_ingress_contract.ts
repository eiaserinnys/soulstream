export type EventSessionEffect =
  | {
      kind: "last_message";
      last_message: { type: string; preview: string; timestamp: string };
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
      kind: "execution_reserve";
      ownership_generation: number;
      owner_kind: "runner_process" | "adopted_runner" | "in_process";
      manifest_id: string;
      runtime_env_identity?: string;
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
      runtime_env_identity?: string;
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
      kind: "execution_expire_dead_owner";
      ownership_generation: number;
      pid: number;
      start_identity: string;
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
      first_runtime_env_identity?: string | null;
      first_registration_id: string | null;
      first_pid: number | null;
      first_start_identity: string | null;
      first_execution_command_id: string | null;
      first_observed_at: string;
      second_manifest_id: string | null;
      second_runtime_env_identity?: string | null;
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

export type EventIngressEnvelope = {
  stream_id: string;
  source_seq: number;
  session_id: string;
  execution_generation?: number | null;
  event_type: string;
  payload: unknown;
  searchable_text: string | null;
  created_at: string;
  semantic_dedupe_key: string | null;
  session_effect: EventSessionEffect | null;
  payload_hash: string;
};

export type EventAppendBatch = {
  type: "event_append_batch";
  protocol_version: 1;
  stream_id: string;
  first_seq: number;
  events: EventIngressEnvelope[];
};

export type EventAppendAck = {
  type: "event_append_ack";
  stream_id: string;
  acked_through: number;
  events: EventAppendAcknowledgement[];
};

export type EventAppendAcknowledgement =
  | {
      source_seq: number;
      event_id: number;
      effect_application?: EventSessionEffectApplicationWire;
    }
  | {
      source_seq: number;
      dead_letter: {
        code: string;
        reason: string;
        rejected_at: string;
      };
    };

export type EventCanonicalSessionProjection = {
  status: string;
  termination_reason: string | null;
  termination_detail: string | null;
  review_state: string;
  last_assistant_text: string | null;
  termination_event_id: number | null;
  updated_at: string;
  last_event_id: number | null;
};

export type EventCanonicalExecutionOwnershipProjection = {
  ownership_generation: number;
  owner_kind: "runner_process" | "adopted_runner" | "in_process";
  manifest_id: string;
  runtime_env_identity?: string;
  registration_id: string | null;
  pid: number | null;
  start_identity: string | null;
  execution_command_id: string | null;
  phase: "reserved" | "identity_proven" | "active" | "terminal" | "failed";
  failure_reason: string | null;
};

export type EventSessionEffectApplication = {
  applied: boolean;
  canonicalSession: EventCanonicalSessionProjection | null;
  canonicalExecutionOwnership?: EventCanonicalExecutionOwnershipProjection | null;
};

export type EventSessionEffectApplicationWire = {
  applied: boolean;
  canonical_session: EventCanonicalSessionProjection;
  canonical_execution_ownership?: EventCanonicalExecutionOwnershipProjection | null;
};

export type CommittedIngressEvent = {
  outcome?: "committed";
  envelope: EventIngressEnvelope;
  eventId: number;
  duplicateReceipt: boolean;
  sessionEffectApplication?: EventSessionEffectApplication;
};

export type DeadLetteredIngressEvent = {
  outcome: "dead_lettered";
  envelope: EventIngressEnvelope;
  deadLetter: {
    code: string;
    reason: string;
    rejectedAt: string;
    path: string;
  };
};

export type EventIngressResult = CommittedIngressEvent | DeadLetteredIngressEvent;

export function isEventAppendBatchFrame(frame: Record<string, unknown>): boolean {
  return frame.type === "event_append_batch";
}
