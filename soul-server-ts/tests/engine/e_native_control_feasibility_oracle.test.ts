import { describe, expect, it } from "vitest";

import {
  evaluateTrial,
  type TrialEvidence,
} from "../../scripts/e_native_control_feasibility_spike.js";

function passingEvidence(): TrialEvidence {
  return {
    order: "queue_then_interrupt",
    ownerUuid: "owner-1",
    deliveryUuid: "delivery-1",
    sdkVersion: "0.3.218",
    claudeCodeVersions: ["2.1.238"],
    executableOverride: "/installed/claude",
    spawnCommands: ["/installed/claude"],
    queryCreateCount: 1,
    nativeInterruptCount: 1,
    deliveryRegisterCount: 1,
    inputEmitCount: 1,
    inputCloseCountAtProof: 0,
    inputCloseCountAfterCleanup: 1,
    querySettledAtProof: false,
    sessionIds: ["session-1"],
    oldResultCount: 1,
    oldResultSubtypes: ["error_during_execution"],
    oldResultRawOwnerUuids: [null],
    oldResultClassifiedOwnerUuid: "owner-1",
    oldResultClassification: "active_owner_at_interrupt",
    consumeCount: 1,
    completeCount: 1,
    parentStatusOverwriteCount: 0,
    naturalReleaseLatchEntered: true,
    naturalReleaseLatchEnteredMs: 1_000,
    naturalReleaseWriterCount: 0,
    naturalReleaseMarkerObserved: false,
    newInputProofMs: 2_000,
    newInputAssistantText: "NATIVE_INPUT_CONSUMED",
    interruptReceipt: { still_queued: [] },
  };
}

describe("E native-control feasibility oracle", () => {
  it("keeps the raw interrupted error visible while fencing it to the old owner", () => {
    const checks = evaluateTrial(passingEvidence());
    expect(checks.every((check) => check.passed)).toBe(true);
    expect(passingEvidence().oldResultSubtypes).toEqual(["error_during_execution"]);
  });

  it.each([
    ["natural release won", { naturalReleaseMarkerObserved: true }, "a-natural-release-latch-closed"],
    ["latch was never entered", { naturalReleaseLatchEntered: false }, "a-natural-release-latch-closed"],
    ["delivery registered twice", { deliveryRegisterCount: 2 }, "b-stable-delivery-registered-once"],
    ["interrupt called twice", { nativeInterruptCount: 2 }, "c-native-interrupt-exactly-once"],
    ["old Result unclassified", { oldResultClassifiedOwnerUuid: null }, "d-old-result-owner-fenced"],
    ["process respawned", { spawnCommands: ["/installed/claude", "/installed/claude"] }, "e-same-query-session-no-respawn"],
    ["input proof predates latch entry", { newInputProofMs: 999 }, "f-new-input-before-natural-release"],
    ["delivery consumed twice", { consumeCount: 2 }, "g-exactly-once-and-parent-clean"],
    ["old error overwrote parent", { parentStatusOverwriteCount: 1 }, "g-exactly-once-and-parent-clean"],
  ])("rejects %s", (_label, mutation, expectedFailure) => {
    const checks = evaluateTrial({ ...passingEvidence(), ...mutation });
    expect(checks.find((check) => check.id === expectedFailure)?.passed).toBe(false);
  });
});
