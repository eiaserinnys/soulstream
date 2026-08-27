import assert from "node:assert/strict";
import test from "node:test";

import { LabRuntime } from "./fault-harness-runtime.mjs";

const INPUT = Object.freeze({
  sessionId: "session-evidence",
  expectedGeneration: 5,
  registrationId: "registration-followup",
  pid: 202,
});

function application(applied = true, patch = {}) {
  return {
    applied,
    canonical_session: {
      status: "completed",
      termination_reason: null,
      termination_detail: null,
      review_state: "none",
    },
    canonical_execution_ownership: applied ? {
      ownership_generation: 5,
      owner_kind: "runner_process",
      manifest_id: "manifest-a",
      registration_id: INPUT.registrationId,
      pid: INPUT.pid,
      start_identity: "start-a",
      execution_command_id: "command-followup",
      phase: "active",
      failure_reason: null,
      ...patch,
    } : null,
  };
}

function row({
  eventId = 81,
  sourceSeq = 8,
  effectApplication = application(),
} = {}) {
  return {
    eventId,
    sessionId: INPUT.sessionId,
    phase: "execution_acquire",
    transitionId: "acquire:command-followup",
    dedupeKey: "execution_ownership:session-evidence:acquire:command-followup",
    nodeId: "node-a",
    streamId: "00000000-0000-4000-8000-000000000001",
    sourceSeq,
    payloadHash: "a".repeat(64),
    effectApplication,
  };
}

async function classify(snapshot) {
  const runtime = {
    async psqlOne(sql) {
      assert.match(sql, /events AS event/);
      assert.match(sql, /event_ingress_receipts AS receipt/);
      assert.match(sql, /receipt\.event_id = event\.id/);
      assert.match(sql, /finalOwnership/);
      return snapshot;
    },
  };
  return await LabRuntime.prototype.executionAcquireApplicationEvidence.call(runtime, INPUT);
}

test("central acquire evidence collapses semantic transport retries", async () => {
  const first = row();
  const second = row({ sourceSeq: 9 });
  const evidence = await classify({
    rows: [first, second],
    finalOwnership: { executionGeneration: 5, owner: null },
  });
  assert.deepEqual(evidence, {
    classification: "applied",
    logicalAcquireEventCount: 1,
    transportReceiptCount: 2,
    event: {
      eventId: 81,
      sessionId: INPUT.sessionId,
      phase: "execution_acquire",
      transitionId: "acquire:command-followup",
    },
    application: {
      applied: true,
      sessionId: INPUT.sessionId,
      ownershipGeneration: 5,
      registrationId: INPUT.registrationId,
      pid: INPUT.pid,
      executionCommandId: "command-followup",
    },
  });
});

test("an unapplied acquire receipt and unchanged ownerless snapshot are no-transition", async () => {
  const evidence = await classify({
    rows: [row({ effectApplication: application(false) })],
    finalOwnership: { executionGeneration: 4, owner: null },
  });
  assert.equal(evidence.classification, "no_transition");
  assert.equal(evidence.logicalAcquireEventCount, 1);
  assert.equal(evidence.application.applied, false);
  assert.equal(evidence.application.executionCommandId, "command-followup");
});

test("partial, mixed, and duplicate logical evidence remain conflicts", async () => {
  const cases = [
    [row({ sourceSeq: null, effectApplication: null }), "partial_evidence"],
    [
      row(),
      row({ sourceSeq: 9, effectApplication: application(true, { pid: 303 }) }),
      "mixed_application",
    ],
    [row(), row({ eventId: 82, sourceSeq: 9 }), "logical_event_duplicate"],
  ];
  for (const fixture of cases) {
    const conflict = fixture.pop();
    const evidence = await classify({
      rows: fixture,
      finalOwnership: { executionGeneration: 5, owner: null },
    });
    assert.equal(evidence.classification, "conflict");
    assert.equal(evidence.conflict, conflict);
  }
});
