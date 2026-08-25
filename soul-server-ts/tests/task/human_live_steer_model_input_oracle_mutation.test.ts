import { describe, expect, it } from "vitest";

import { HumanLiveSteerModelInputHarness } from
  "./human_live_steer_model_input_fixture.js";

describe("C2 oracle mutation self-audit", () => {
  it("rejects metadata promoted to an authoritative input proof", async () => {
    const harness = new HumanLiveSteerModelInputHarness("c2-oracle-metadata");

    await harness.execute("metadata_then_error");

    expect(harness.rawCount("model_input")).toBe(0);
    expect(harness.visibleAuthoritativeInputProofCount()).toBe(0);
  });

  it("rejects an acceptance claim that hides a missing stable input UUID", () => {
    const harness = new HumanLiveSteerModelInputHarness("c2-oracle-missing-input");
    harness.claimAcceptanceWithoutTranscriptForOracleAudit();

    expect(harness.hasRawAuthoritativeInputProof()).toBe(false);
    expect(harness.visibleAuthoritativeInputProofCount()).toBe(0);
  });

  it("keeps the second consume and replay visible", () => {
    const harness = new HumanLiveSteerModelInputHarness("c2-oracle-duplicates");
    harness.appendDuplicateConsumeAndReplayForOracleAudit();

    expect(harness.rawCount("consume")).toBe(2);
    expect(harness.visibleCount("consume")).toBe(2);
    expect(harness.rawCount("recovery_attempt")).toBe(2);
    expect(harness.visibleCount("recovery_attempt")).toBe(2);
  });
});
