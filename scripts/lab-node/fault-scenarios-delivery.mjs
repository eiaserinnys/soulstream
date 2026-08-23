import { randomUUID } from "node:crypto";

import { buildDurableDeliverySeed } from "./fault-harness-contract.mjs";
import { waitFor } from "./fault-harness-runtime.mjs";
import { settle, shortId } from "./fault-scenario-result.mjs";
import {
  buildDeliveryObservation,
  expectedDeliveryObservation,
  transparencyDifferences,
} from "./fault-transparency-oracle.mjs";

const SINGLE_LABEL = Object.freeze(["only"]);
const FIFO_LABELS = Object.freeze(["first", "second"]);

export const DELIVERY_LOG_TERMS = Object.freeze({
  "delivery-revival": ["DELIVERY_REVIVAL_", "delivery", "uncertain"],
  "delivery-exact-once": ["DELIVERY_EXACT_ONCE_", "delivery", "consumed"],
  "delivery-fifo": ["DELIVERY_FIFO_", "delivery", "enqueue_sequence"],
  "delivery-accepted-cas": ["DELIVERY_ACCEPTED_CAS_", "durable acceptance", "delivery"],
});

export const DELIVERY_SCENARIOS = Object.freeze({
  async "delivery-revival"(runtime, recorder) {
    const baseline = await steadyDeliveryBaseline(runtime, recorder, SINGLE_LABEL);
    const seed = shortId();
    const marker = `DELIVERY_REVIVAL_OK_${seed}`;
    const text = `Reply with exactly ${marker}.`;
    const spec = [{ label: "only", text, marker }];
    const delivery = buildDurableDeliverySeed(randomUUID(), baseline.sessionId, text);
    await runtime.deliveries.seed(delivery, {
      state: "uncertain",
      attemptCount: 16,
      nextAttemptDelaySeconds: 3_600,
    });
    await recorder.event("fault_injected", {
      id: "delivery-revival",
      sessionId: baseline.sessionId,
      deliveryId: delivery.deliveryId,
      state: "uncertain",
      attemptCount: 16,
    });
    await runtime.deliveries.forceDue(delivery.deliveryId);

    let result;
    let cleanup;
    try {
      const [markerOutcome, consumptionOutcome] = await Promise.all([
        settle(runtime.waitForMarker(baseline.sessionId, marker, 45_000)),
        settle(waitForConsumed(runtime, delivery.deliveryId, "revived delivery", 45_000)),
      ]);
      const deliveryRow = await runtime.deliveries.byId(delivery.deliveryId);
      const candidate = await captureDeliveryObservation(
        runtime,
        baseline.sessionId,
        baseline.afterEventId,
        spec,
      );
      const structuralFailures = deliveryRow?.aggregate_state === "consumed"
        ? []
        : [`delivery state was ${deliveryRow?.aggregate_state ?? "missing"}`];
      result = deliveryVerdict({
        id: "delivery-revival",
        baseline,
        candidate,
        labels: SINGLE_LABEL,
        structuralFailures,
        evidence: { delivery: deliveryRow, markerOutcome, consumptionOutcome },
      });
    } finally {
      cleanup = await runtime.deliveries.removeSeed(delivery.deliveryId);
    }
    result.cleanup = { delivery: cleanup };
    return result;
  },

  async "delivery-exact-once"(runtime, recorder) {
    const baseline = await steadyDeliveryBaseline(runtime, recorder, SINGLE_LABEL);
    const seed = shortId();
    const marker = `DELIVERY_EXACT_ONCE_OK_${seed}`;
    const text = `Reply with exactly ${marker}.`;
    const spec = [{ label: "only", text, marker }];
    const logicalMessageId = `client-message-${seed}`;
    const first = buildDurableDeliverySeed(
      randomUUID(), baseline.sessionId, text, undefined, logicalMessageId,
    );
    const retry = buildDurableDeliverySeed(
      randomUUID(), baseline.sessionId, text, undefined, logicalMessageId,
    );
    const firstSeed = await runtime.deliveries.seed(first, { nextAttemptDelaySeconds: 10 });
    const retrySeed = await runtime.deliveries.seed(retry);
    await recorder.event("fault_injected", {
      id: "delivery-exact-once",
      sessionId: baseline.sessionId,
      logicalMessageId,
      firstDeliveryId: first.deliveryId,
      retryDeliveryId: retry.deliveryId,
      firstEnqueueSequence: firstSeed.enqueue_sequence,
      retryEnqueueSequence: retrySeed.enqueue_sequence,
    });

    let result;
    const cleanup = [];
    try {
      const [markerOutcome, settlementOutcome] = await Promise.all([
        settle(runtime.waitForMarker(baseline.sessionId, marker, 180_000)),
        settle(waitForLogicalMessageSettled(
          runtime,
          [first.deliveryId, retry.deliveryId],
          180_000,
        )),
      ]);
      const deliveries = await Promise.all([
        runtime.deliveries.byId(first.deliveryId),
        runtime.deliveries.byId(retry.deliveryId),
      ]);
      const candidate = await captureDeliveryObservation(
        runtime,
        baseline.sessionId,
        baseline.afterEventId,
        spec,
      );
      const consumedCount = deliveries.filter(
        (row) => row?.aggregate_state === "consumed",
      ).length;
      const structuralFailures = consumedCount === 1
        ? []
        : [`logical message consumed ${consumedCount} transport deliveries`];
      result = deliveryVerdict({
        id: "delivery-exact-once",
        baseline,
        candidate,
        labels: SINGLE_LABEL,
        structuralFailures,
        evidence: {
          logicalMessageId,
          deliveries,
          markerOutcome,
          settlementOutcome,
        },
      });
    } finally {
      cleanup.push(await runtime.deliveries.removeSeed(first.deliveryId));
      cleanup.push(await runtime.deliveries.removeSeed(retry.deliveryId));
    }
    result.cleanup = { deliveries: cleanup };
    return result;
  },

  async "delivery-fifo"(runtime, recorder) {
    const baseline = await steadyDeliveryBaseline(runtime, recorder, FIFO_LABELS);
    const seed = shortId();
    const firstMarker = `DELIVERY_FIFO_FIRST_${seed}`;
    const secondMarker = `DELIVERY_FIFO_SECOND_${seed}`;
    const specs = [
      { label: "first", text: `Reply with exactly ${firstMarker}.`, marker: firstMarker },
      { label: "second", text: `Reply with exactly ${secondMarker}.`, marker: secondMarker },
    ];
    const first = buildDurableDeliverySeed(
      randomUUID(), baseline.sessionId, specs[0].text,
    );
    const second = buildDurableDeliverySeed(
      randomUUID(), baseline.sessionId, specs[1].text,
    );
    const firstSeed = await runtime.deliveries.seed(first, { nextAttemptDelaySeconds: 10 });
    const secondSeed = await runtime.deliveries.seed(second);
    await recorder.event("fault_injected", {
      id: "delivery-fifo",
      sessionId: baseline.sessionId,
      firstDeliveryId: first.deliveryId,
      secondDeliveryId: second.deliveryId,
      firstEnqueueSequence: firstSeed.enqueue_sequence,
      secondEnqueueSequence: secondSeed.enqueue_sequence,
      dueOrder: [second.deliveryId, first.deliveryId],
    });

    let result;
    const cleanup = [];
    try {
      const markerOutcomes = await Promise.all(specs.map(
        ({ marker }) => settle(runtime.waitForMarker(baseline.sessionId, marker, 240_000)),
      ));
      const deliveries = await Promise.all([
        runtime.deliveries.byId(first.deliveryId),
        runtime.deliveries.byId(second.deliveryId),
      ]);
      const candidate = await captureDeliveryObservation(
        runtime,
        baseline.sessionId,
        baseline.afterEventId,
        specs,
      );
      const receiptOrder = deliveries.map((row) => receiptEventId(row?.target_receipt_id));
      const structuralFailures = [];
      if (deliveries.some((row) => row?.aggregate_state !== "consumed")) {
        structuralFailures.push("both FIFO deliveries were not consumed");
      }
      if (
        receiptOrder.some((eventId) => eventId === null)
        || receiptOrder[0] >= receiptOrder[1]
      ) {
        structuralFailures.push(`FIFO receipt order was ${JSON.stringify(receiptOrder)}`);
      }
      result = deliveryVerdict({
        id: "delivery-fifo",
        baseline,
        candidate,
        labels: FIFO_LABELS,
        structuralFailures,
        evidence: { deliveries, receiptOrder, markerOutcomes },
      });
    } finally {
      cleanup.push(await runtime.deliveries.removeSeed(first.deliveryId));
      cleanup.push(await runtime.deliveries.removeSeed(second.deliveryId));
    }
    result.cleanup = { deliveries: cleanup };
    return result;
  },

  async "delivery-accepted-cas"(runtime, recorder) {
    const baseline = await steadyDeliveryBaseline(runtime, recorder, SINGLE_LABEL, true);
    const seed = shortId();
    const marker = `DELIVERY_ACCEPTED_CAS_OK_${seed}`;
    const text = `Reply with exactly ${marker}.`;
    const spec = [{ label: "only", text, marker }];
    const leaseOwner = `lab-cas-${seed}`;
    const delivery = buildDurableDeliverySeed(
      randomUUID(), baseline.sessionId, text, leaseOwner,
    );
    await runtime.deliveries.seed(delivery, { state: "claimed", leaseOwner });
    await runtime.deliveries.installQueuedCasFault(delivery.deliveryId);

    let result;
    let cleanup;
    let callerOutcome;
    try {
      callerOutcome = await settle(runtime.intervene(baseline.sessionId, delivery.intervention));
      await recorder.event("fault_injected", {
        id: "delivery-accepted-cas",
        sessionId: baseline.sessionId,
        deliveryId: delivery.deliveryId,
        callerOutcome,
      });
      const markerOutcome = await settle(
        runtime.waitForMarker(baseline.sessionId, marker, 120_000),
      );
      const deliveryRow = await runtime.deliveries.byId(delivery.deliveryId);
      const candidate = await captureDeliveryObservation(
        runtime,
        baseline.sessionId,
        baseline.afterEventId,
        spec,
        callerOutcome,
      );
      const structuralFailures = deliveryRow?.aggregate_state === "consumed"
        ? []
        : [`delivery state was ${deliveryRow?.aggregate_state ?? "missing"}`];
      result = deliveryVerdict({
        id: "delivery-accepted-cas",
        baseline,
        candidate,
        labels: SINGLE_LABEL,
        callerDisposition: "queued_for_next_turn",
        structuralFailures,
        evidence: { delivery: deliveryRow, callerOutcome, markerOutcome },
      });
    } finally {
      await runtime.deliveries.removeQueuedCasFault();
      cleanup = await runtime.deliveries.removeSeed(delivery.deliveryId);
    }
    result.cleanup = { delivery: cleanup };
    return result;
  },
});

async function steadyDeliveryBaseline(runtime, recorder, labels, compareCaller = false) {
  const seed = shortId();
  const baseMarker = `DELIVERY_BASE_${seed}`;
  const sessionId = await runtime.createSession(`Reply with exactly ${baseMarker}.`);
  await runtime.waitForMarker(sessionId, baseMarker);
  await runtime.waitForTerminal(sessionId);
  const baseTimeline = await runtime.timeline(sessionId);
  const beforeEventId = lastEventId(baseTimeline);
  const specs = labels.map((label) => ({
    label,
    text: `Reply with exactly DELIVERY_STEADY_${label.toUpperCase()}_${seed}.`,
    marker: `DELIVERY_STEADY_${label.toUpperCase()}_${seed}`,
  }));
  const outcomes = [];
  const rows = [];
  const cleanup = [];
  try {
    for (const spec of specs) {
      const leaseOwner = `lab-steady-${shortId()}`;
      const delivery = buildDurableDeliverySeed(
        randomUUID(), sessionId, spec.text, leaseOwner,
      );
      await runtime.deliveries.seed(delivery, { state: "claimed", leaseOwner });
      const callerOutcome = await settle(runtime.intervene(sessionId, delivery.intervention));
      outcomes.push(callerOutcome);
      await runtime.waitForMarker(sessionId, spec.marker);
      await runtime.waitForTerminal(sessionId);
      rows.push(await waitForConsumed(runtime, delivery.deliveryId, "steady delivery"));
      cleanup.push(delivery.deliveryId);
    }
    const timeline = await runtime.timeline(sessionId);
    const observation = buildDeliveryObservation({
      timeline,
      afterEventId: beforeEventId,
      terminalStatus: await runtime.sessionStatus(sessionId),
      deliveries: specs,
      callerOutcome: compareCaller ? outcomes.at(-1) : null,
    });
    const authoredContract = expectedDeliveryObservation(
      labels,
      compareCaller ? "queued_for_next_turn" : null,
    );
    const contractDifferences = transparencyDifferences(authoredContract, observation);
    await recorder.event("steady_delivery_observation", {
      sessionId,
      labels,
      observation,
      contractDifferences,
    });
    return {
      sessionId,
      afterEventId: lastEventId(timeline),
      observation,
      contractDifferences,
      outcomes,
      deliveries: rows,
    };
  } finally {
    await Promise.all(cleanup.map((deliveryId) => runtime.deliveries.removeSeed(deliveryId)));
  }
}

async function captureDeliveryObservation(
  runtime,
  sessionId,
  afterEventId,
  deliveries,
  callerOutcome = null,
) {
  const timeline = await runtime.timeline(sessionId);
  return {
    timeline,
    observation: buildDeliveryObservation({
      timeline,
      afterEventId,
      terminalStatus: await runtime.sessionStatus(sessionId),
      deliveries,
      callerOutcome,
    }),
  };
}

function deliveryVerdict({
  id,
  baseline,
  candidate,
  labels,
  callerDisposition = null,
  structuralFailures,
  evidence,
}) {
  const authoredContract = expectedDeliveryObservation(labels, callerDisposition);
  const contractDifferences = transparencyDifferences(
    authoredContract,
    candidate.observation,
  );
  const steadyObservationDifferences = transparencyDifferences(
    baseline.observation,
    candidate.observation,
  );
  return {
    id,
    status: baseline.contractDifferences.length === 0
      && contractDifferences.length === 0
      && steadyObservationDifferences.length === 0
      && structuralFailures.length === 0
      ? "passed"
      : "failed",
    sessionId: baseline.sessionId,
    authoredContract,
    observation: candidate.observation,
    contractDifferences,
    steadyObservation: baseline.observation,
    steadyObservationDifferences,
    steadyContractDifferences: baseline.contractDifferences,
    structuralFailures,
    ...evidence,
  };
}

async function waitForConsumed(runtime, deliveryId, label, timeoutMs = 180_000) {
  return await waitFor(
    async () => {
      const row = await runtime.deliveries.byId(deliveryId);
      return row?.aggregate_state === "consumed" ? row : undefined;
    },
    timeoutMs,
    `${label} was not consumed`,
    500,
  );
}

async function waitForLogicalMessageSettled(runtime, deliveryIds, timeoutMs) {
  return await waitFor(
    async () => {
      const rows = await Promise.all(deliveryIds.map((id) => runtime.deliveries.byId(id)));
      return rows.every((row) => row && row.aggregate_state !== "pending")
        ? rows
        : undefined;
    },
    timeoutMs,
    "logical message retry deliveries did not settle",
    500,
  );
}

function receiptEventId(receiptId) {
  const match = /^event:(\d+)$/.exec(receiptId ?? "");
  return match === null ? null : Number(match[1]);
}

function lastEventId(timeline) {
  return Math.max(0, ...(timeline.messages ?? []).map(
    (message) => Number(message?.event_id ?? message?.id ?? 0),
  ));
}
