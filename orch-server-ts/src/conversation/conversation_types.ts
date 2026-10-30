export type EnsureRequest = {
  title: string; selected_model: string; model_order: string[]; profile: string;
  collection: string; initial_instruction: string; instructions: string;
};
export type PatchRequest = {
  title?: string; archived?: boolean; model?: string; model_order?: string[]; instructions?: string;
};
export type ExecutionRequest = EnsureRequest & { expected_execution_id: string };
export type Execution = {
  thread_id: string; session_id: string; predecessor_session_id: string | null; ordinal: number;
  first_input_is_initial_instruction: boolean; notice: string | null; request: EnsureRequest | null;
  selected_model: string | null; phase: string; instruction_id: string | null;
  notices: ConversationNotice[]; release_pending: boolean;
};
export type Binding = {
  account_id: string; namespace: string; external_key: string; session_id: string;
  active_session_id: string | null;
  selected_model: string; creation_request: EnsureRequest | null; phase: string;
  instruction_id: string | null; notices: ConversationNotice[]; archived: boolean;
  first_input_is_initial_instruction: boolean;
};
export type ConversationNotice = { id: string; text: string; at: string };
export type Thread = {
  id: string; external: { namespace: string; key: string }; title: string;
  model: { id: string; label: string; group?: { id: string; label: string } };
  profile?: { id: string; label: string }; execution_id?: string;
  created_at: string; archived: boolean;
};
export class ConversationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly threadId?: string) { super(message); }
}
