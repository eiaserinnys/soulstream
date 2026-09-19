export type SessionConversationContextQuery = {
  readonly eventId: number | null;
  readonly beforeTurns: number;
  readonly afterTurns: number;
};

export type SessionConversationMessage = {
  readonly event_id: number;
  readonly event_type: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly created_at: string;
};

export type SessionConversationTurn = {
  readonly turn_number: number | null;
  readonly turn_start_event_id: number;
  readonly final_response_event_id: number | null;
  readonly is_match: boolean;
  readonly messages: SessionConversationMessage[];
};

export type SessionConversationContextResponse = {
  readonly session_id: string;
  readonly anchor: "match" | "latest_conversation";
  readonly match_event_id: number | null;
  readonly match_turn_number: number | null;
  readonly turns: SessionConversationTurn[];
};

