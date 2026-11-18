export const OUTBOUND_EVENT_TYPES = [
  "session.reply",
  "session.question",
  "session.failed",
  "session.ended",
] as const;

export type OutboundEventType = (typeof OUTBOUND_EVENT_TYPES)[number];
export type DeliveryState = "pending" | "delivered" | "dead";

export type OutboundNotification = {
  id: string;
  type: OutboundEventType;
  timestamp: string;
  data: Record<string, unknown>;
};

export type WebhookSubscriptionRow = {
  id: string;
  owner_email: string;
  label: string;
  target_session_id: string;
  event_types: OutboundEventType[];
  url: string;
  signing_secret: string;
  cursor_event_id: number;
  active: boolean;
  disabled_reason: string | null;
  consecutive_failures: number;
  created_at: Date;
  updated_at: Date;
};

export type WebhookSubscriptionSummary = Omit<WebhookSubscriptionRow, "signing_secret"> & {
  recent_failures?: number;
};

export type WebhookDeliveryRow = {
  id: string;
  subscription_id: string;
  session_id: string;
  event_id: number;
  event_type: OutboundEventType;
  payload: OutboundNotification;
  state: DeliveryState;
  attempt_count: number;
  next_attempt_at: Date;
  window_started_at: Date;
  last_status: number | null;
  last_error: string | null;
  created_at: Date;
  delivered_at: Date | null;
};

export type SourceEventRow = {
  id: number;
  event_type: string;
  payload: Record<string, unknown> | null;
  created_at: Date | null;
};

export type CreateSubscriptionInput = {
  ownerEmail: string;
  label: string;
  targetSessionId: string;
  url: string;
  eventTypes: readonly OutboundEventType[];
  signingSecret: string;
};

export type RedeliverResult =
  | { ok: true; outcome: "delivered" | "retrying" | "dead" | "skipped" }
  | { ok: false; reason: "not_found" | "subscription_inactive" };
