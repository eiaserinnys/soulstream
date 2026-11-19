import type { EventAppendBatch } from "@soulstream/wire-schema";

export type SessionLastMessage = {
  type: string;
  preview: string;
  timestamp: string;
};

export type EventOutboxSessionEffect = NonNullable<EventAppendBatch["events"][number]["session_effect"]>;
