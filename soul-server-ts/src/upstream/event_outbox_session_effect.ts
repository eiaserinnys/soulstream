import type { EventAppendBatch } from "@soulstream/wire-schema";

export type EventOutboxSessionEffect = NonNullable<EventAppendBatch["events"][number]["session_effect"]>;
