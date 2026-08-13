import { open } from "node:fs/promises";
import { join } from "node:path";

import type { EventOutboxRecord } from "./event_outbox.js";

export type EventOutboxQuarantineInput = {
  record: EventOutboxRecord;
  rejection: {
    code: string;
    reason: string;
  };
  attempts: number;
  quarantinedAt: string;
};

export type EventOutboxQuarantineResult = {
  path: string;
  sourceSeq: number;
  sessionId: string;
  code: string;
  attempts: number;
  quarantinedAt: string;
};

export async function appendEventOutboxQuarantine(
  directory: string,
  input: EventOutboxQuarantineInput,
): Promise<EventOutboxQuarantineResult> {
  if (!Number.isSafeInteger(input.attempts) || input.attempts <= 0) {
    throw new Error("event outbox quarantine attempts must be a positive integer");
  }
  if (!Number.isFinite(Date.parse(input.quarantinedAt))) {
    throw new Error("event outbox quarantine timestamp must be ISO-8601");
  }
  const date = input.quarantinedAt.slice(0, 10).replaceAll("-", "");
  const sessionPrefix = input.record.session_id
    .slice(0, 4)
    .replace(/[^a-z0-9]/gi, "_")
    .padEnd(4, "_")
    .toLowerCase();
  const path = join(directory, `quarantine-${date}-${sessionPrefix}.jsonl`);
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({
      quarantined_at: input.quarantinedAt,
      rejection: {
        code: input.rejection.code,
        reason: input.rejection.reason,
        attempts: input.attempts,
      },
      event: input.record,
    })}\n`, "utf8");
    await handle.datasync();
  } finally {
    await handle.close();
  }
  return {
    path,
    sourceSeq: input.record.source_seq,
    sessionId: input.record.session_id,
    code: input.rejection.code,
    attempts: input.attempts,
    quarantinedAt: input.quarantinedAt,
  };
}
