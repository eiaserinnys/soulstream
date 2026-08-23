import { randomUUID } from "node:crypto";

import { buildDurableDeliverySeed } from "./fault-harness-contract.mjs";
import { waitFor } from "./fault-harness-runtime.mjs";
import { assertScenario, shortId } from "./fault-scenario-result.mjs";

export const DELIVERY_LOG_TERMS = Object.freeze({
  "delivery-revival": ["DELIVERY_REVIVAL_", "delivery", "uncertain"],
  "delivery-exact-once": ["DELIVERY_EXACT_ONCE_", "delivery", "consumed"],
  "delivery-fifo": ["DELIVERY_FIFO_", "delivery", "enqueue_sequence"],
  "delivery-accepted-cas": ["DELIVERY_ACCEPTED_CAS_", "durable acceptance", "delivery"],
});

export const DELIVERY_SCENARIOS = Object.freeze({
  async "delivery-revival"(runtime, recorder) {
    const seed = shortId();
    const sessionId = await completedSession(runtime, `DELIVERY_REVIVAL_BASE_${seed}`);
    const marker = `DELIVERY_REVIVAL_OK_${seed}`;
    const text = `Reply with exactly ${marker}.`;
    const delivery = buildDurableDeliverySeed(randomUUID(), sessionId, text);
    await runtime.deliveries.seed(delivery, {
      state: "uncertain",
      attemptCount: 16,
      nextAttemptDelaySeconds: 3_600,
    });
    await recorder.event("fault_injected", {
      id: "delivery-revival",
      sessionId,
      deliveryId: delivery.deliveryId,
      state: "uncertain",
      attemptCount: 16,
    });
    await runtime.deliveries.forceDue(delivery.deliveryId);

    try {
      await runtime.waitForMarker(sessionId, marker, 45_000);
    } catch (error) {
      const stranded = await runtime.deliveries.byId(delivery.deliveryId);
      await runtime.deliveries.removeSeed(delivery.deliveryId);
      throw new Error(
        `uncertain delivery did not revive: ${JSON.stringify(stranded)}`,
        { cause: error },
      );
    }
    await runtime.waitForTerminal(sessionId);
    const consumed = await waitForConsumed(runtime, delivery.deliveryId, "revived delivery");
    const userCount = await runtime.countTimelineEvents(sessionId, "user_message", text);
    const markerCount = await runtime.countTimelineEvents(sessionId, "assistant_message", marker);
    assertScenario(userCount === 1, `delivery revival user count was ${userCount}`);
    assertScenario(markerCount === 1, `delivery revival marker count was ${markerCount}`);
    return {
      id: "delivery-revival",
      status: "passed",
      sessionId,
      delivery: consumed,
      userCount,
      markerCount,
    };
  },

  async "delivery-exact-once"(runtime, recorder) {
    const seed = shortId();
    const sessionId = await completedSession(runtime, `DELIVERY_EXACT_ONCE_BASE_${seed}`);
    const marker = `DELIVERY_EXACT_ONCE_OK_${seed}`;
    const text = `Reply with exactly ${marker}.`;
    const logicalMessageId = `client-message-${seed}`;
    const first = buildDurableDeliverySeed(
      randomUUID(), sessionId, text, undefined, logicalMessageId,
    );
    const retry = buildDurableDeliverySeed(
      randomUUID(), sessionId, text, undefined, logicalMessageId,
    );
    const firstSeed = await runtime.deliveries.seed(first, {
      nextAttemptDelaySeconds: 10,
    });
    const retrySeed = await runtime.deliveries.seed(retry);
    await recorder.event("fault_injected", {
      id: "delivery-exact-once",
      sessionId,
      logicalMessageId,
      firstDeliveryId: first.deliveryId,
      retryDeliveryId: retry.deliveryId,
      firstEnqueueSequence: firstSeed.enqueue_sequence,
      retryEnqueueSequence: retrySeed.enqueue_sequence,
    });

    await runtime.waitForMarker(sessionId, marker);
    await runtime.waitForTerminal(sessionId);
    const deliveries = await waitForLogicalMessageSettled(
      runtime,
      [first.deliveryId, retry.deliveryId],
    );
    const userCount = await runtime.countTimelineEvents(sessionId, "user_message", text);
    const markerCount = await runtime.countTimelineEvents(sessionId, "assistant_message", marker);
    assertScenario(userCount === 1, `delivery exact-once user count was ${userCount}`);
    assertScenario(markerCount === 1, `delivery exact-once marker count was ${markerCount}`);
    return {
      id: "delivery-exact-once",
      status: "passed",
      sessionId,
      logicalMessageId,
      deliveries,
      userCount,
      markerCount,
    };
  },

  async "delivery-fifo"(runtime, recorder) {
    const seed = shortId();
    const sessionId = await completedSession(runtime, `DELIVERY_FIFO_BASE_${seed}`);
    const firstMarker = `DELIVERY_FIFO_FIRST_${seed}`;
    const secondMarker = `DELIVERY_FIFO_SECOND_${seed}`;
    const first = buildDurableDeliverySeed(
      randomUUID(),
      sessionId,
      `Reply with exactly ${firstMarker}.`,
    );
    const second = buildDurableDeliverySeed(
      randomUUID(),
      sessionId,
      `Reply with exactly ${secondMarker}.`,
    );
    const firstSeed = await runtime.deliveries.seed(first, {
      nextAttemptDelaySeconds: 10,
    });
    const secondSeed = await runtime.deliveries.seed(second);
    await recorder.event("fault_injected", {
      id: "delivery-fifo",
      sessionId,
      firstDeliveryId: first.deliveryId,
      secondDeliveryId: second.deliveryId,
      firstEnqueueSequence: firstSeed.enqueue_sequence,
      secondEnqueueSequence: secondSeed.enqueue_sequence,
      dueOrder: [second.deliveryId, first.deliveryId],
    });

    await runtime.waitForMarker(sessionId, firstMarker, 240_000);
    await runtime.waitForMarker(sessionId, secondMarker, 240_000);
    await runtime.waitForTerminal(sessionId, 240_000);
    const firstConsumed = await waitForConsumed(runtime, first.deliveryId, "first FIFO delivery");
    const secondConsumed = await waitForConsumed(runtime, second.deliveryId, "second FIFO delivery");
    const firstReceipt = receiptEventId(firstConsumed.target_receipt_id);
    const secondReceipt = receiptEventId(secondConsumed.target_receipt_id);
    assertScenario(
      firstReceipt < secondReceipt,
      `FIFO receipt order was ${firstReceipt} then ${secondReceipt}`,
    );
    return {
      id: "delivery-fifo",
      status: "passed",
      sessionId,
      firstDelivery: firstConsumed,
      secondDelivery: secondConsumed,
      receiptOrder: [firstReceipt, secondReceipt],
    };
  },

  async "delivery-accepted-cas"(runtime, recorder) {
    const seed = shortId();
    const sessionId = await completedSession(runtime, `DELIVERY_ACCEPTED_CAS_BASE_${seed}`);
    const marker = `DELIVERY_ACCEPTED_CAS_OK_${seed}`;
    const text = `Reply with exactly ${marker}.`;
    const leaseOwner = `lab-cas-${seed}`;
    const delivery = buildDurableDeliverySeed(
      randomUUID(),
      sessionId,
      text,
      leaseOwner,
    );
    await runtime.deliveries.seed(delivery, { state: "claimed", leaseOwner });
    await runtime.deliveries.installQueuedCasFault(delivery.deliveryId);
    let outcome;
    try {
      outcome = await runtime.intervene(sessionId, delivery.intervention);
    } finally {
      await runtime.deliveries.removeQueuedCasFault();
    }
    await recorder.event("fault_injected", {
      id: "delivery-accepted-cas",
      sessionId,
      deliveryId: delivery.deliveryId,
      outcome,
    });

    await runtime.waitForMarker(sessionId, marker);
    await runtime.waitForTerminal(sessionId);
    const consumed = await waitForConsumed(runtime, delivery.deliveryId, "CAS-advanced delivery");
    const userCount = await runtime.countTimelineEvents(sessionId, "user_message", text);
    const markerCount = await runtime.countTimelineEvents(sessionId, "assistant_message", marker);
    assertScenario(userCount === 1, `accepted CAS user count was ${userCount}`);
    assertScenario(markerCount === 1, `accepted CAS marker count was ${markerCount}`);
    return {
      id: "delivery-accepted-cas",
      status: "passed",
      sessionId,
      delivery: consumed,
      outcome,
      userCount,
      markerCount,
    };
  },
});

async function completedSession(runtime, marker) {
  const sessionId = await runtime.createSession(`Reply with exactly ${marker}.`);
  await runtime.waitForMarker(sessionId, marker);
  await runtime.waitForTerminal(sessionId);
  return sessionId;
}

async function waitForConsumed(runtime, deliveryId, label) {
  return await waitFor(
    async () => {
      const row = await runtime.deliveries.byId(deliveryId);
      return row?.aggregate_state === "consumed" ? row : undefined;
    },
    180_000,
    `${label} was not consumed`,
    500,
  );
}

async function waitForLogicalMessageSettled(runtime, deliveryIds) {
  return await waitFor(
    async () => {
      const rows = await Promise.all(deliveryIds.map((id) => runtime.deliveries.byId(id)));
      return rows.every((row) => row && row.aggregate_state !== "pending")
        ? rows
        : undefined;
    },
    180_000,
    "logical message retry deliveries did not settle",
    500,
  );
}

function receiptEventId(receiptId) {
  const match = /^event:(\d+)$/.exec(receiptId ?? "");
  assertScenario(match !== null, `delivery receipt was not an event id: ${receiptId}`);
  return Number(match[1]);
}
