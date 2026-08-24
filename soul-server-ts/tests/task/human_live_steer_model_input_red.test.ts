import { describe, expect, it } from "vitest";

import { HumanLiveSteerModelInputHarness } from
  "./human_live_steer_model_input_fixture.js";

describe("C2 authoritative model-input consumption RED", () => {
  it("a: ownership metadata followed by error stays unconsumed and replayable", async () => {
    const harness = new HumanLiveSteerModelInputHarness("c2-metadata-only");

    await harness.execute("metadata_then_error");

    expect(harness.rawCount("metadata")).toBe(1);
    expect(harness.visibleAuthoritativeInputProofCount()).toBe(0);
    expect(harness.recordConsumed).not.toHaveBeenCalled();
    expect(harness.row.consumedAt).toBeNull();
    expect(harness.row.state).not.toBe("consumed");
    expect(harness.rawCount("stream_closed")).toBe(1);
  });

  it("b: recovery injects the replayable delivery once and consumes once after its stable input UUID", async () => {
    const harness = new HumanLiveSteerModelInputHarness("c2-recovery-once");

    await harness.execute("metadata_then_error");
    await harness.recoverOnce();

    expect(harness.rawCount("recovery_attempt")).toBe(1);
    expect(harness.rawCount("recovery_injection")).toBe(1);
    expect(harness.rawCount("model_input")).toBe(1);
    expect(harness.visibleAuthoritativeInputProofCount()).toBe(1);
    expect(harness.consumeBeforeProofCount()).toBe(0);
    expect(harness.rawCount("consume")).toBe(1);
    expect(harness.row.state).toBe("consumed");
    expect(harness.row.consumedAt).not.toBeNull();
  });
});
