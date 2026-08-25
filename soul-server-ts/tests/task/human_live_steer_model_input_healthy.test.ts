import { describe, expect, it } from "vitest";

import { HumanLiveSteerModelInputHarness } from
  "./human_live_steer_model_input_fixture.js";

describe("C2 healthy foreground protection", () => {
  it("c: one accepted input completes once, consumes once, and blocks metadata recovery replay", async () => {
    const harness = new HumanLiveSteerModelInputHarness("c2-healthy-foreground");

    await harness.execute("accepted_complete");
    await harness.replayMetadataAndRecoverOnce();

    expect(harness.rawCount("model_input")).toBe(1);
    expect(harness.rawCount("metadata")).toBe(2);
    expect(harness.rawCount("assistant")).toBe(1);
    expect(harness.rawCount("result")).toBe(1);
    expect(harness.rawCount("complete")).toBe(1);
    expect(harness.rawCount("consume")).toBe(1);
    expect(harness.consumeBeforeProofCount()).toBe(0);
    expect(harness.rawCount("recovery_attempt")).toBe(1);
    expect(harness.rawCount("recovery_injection")).toBe(0);
    expect(harness.rawCount("turn")).toBe(1);
  });
});
