import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EventOutbox,
  type EventOutboxAppendInput,
} from "../src/upstream/event_outbox.js";
import {
  isValidEventAppendAck,
  type EventAppendAck,
} from "../src/upstream/event_outbox_pump_protocol.js";
import { parseEventAppendBatch } from "../../orch-server-ts/src/node/event_ingress_types.js";

type RuntimeEventContractFixture = {
  eventAppendInputs: EventOutboxAppendInput[];
  eventAppendAck: Omit<EventAppendAck, "stream_id">;
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../../packages/wire-schema/fixtures/runtime_event_contract.json", import.meta.url),
    "utf8",
  ),
) as RuntimeEventContractFixture;

describe("shared upstream event contract fixture", () => {
  it("generates an outbox batch, receives it in orch, and validates its ACK", async () => {
    const directory = await mkdtemp(join(tmpdir(), "upstream-contract-fixture-"));
    try {
      const outbox = await EventOutbox.open(directory);
      for (const input of fixture.eventAppendInputs) {
        await outbox.append(input);
      }
      const batch = await outbox.readBatch();

      expect(batch).not.toBeNull();
      const parsed = parseEventAppendBatch(batch! as unknown as Record<string, unknown>);
      expect(parsed.events.map((event) => event.session_effect))
        .toEqual(fixture.eventAppendInputs.map((event) => event.session_effect));

      const acknowledgement = {
        ...fixture.eventAppendAck,
        stream_id: batch!.stream_id,
      } as EventAppendAck;
      expect(isValidEventAppendAck(acknowledgement)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
