import { waitFor } from "./fault-harness-runtime.mjs";

export async function waitForConsumedDelivery(
  runtime,
  sourceSessionId,
  label,
  previousDeliveryId = null,
) {
  return await waitFor(
    async () => {
      const row = await runtime.deliveryForSource(sourceSessionId);
      return row?.aggregate_state === "consumed" && row.delivery_id !== previousDeliveryId
        ? row
        : undefined;
    },
    120_000,
    `${label} was not consumed`,
    500,
  );
}

export async function exhaustDelivery(runtime, initial) {
  let delivery = initial;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && delivery.aggregate_state !== "dead_letter") {
    const before = delivery.attempt_count;
    await runtime.forceDeliveryDue(delivery.delivery_id);
    delivery = await waitFor(
      async () => {
        const row = await runtime.deliveryForSource(delivery.source_session_id ?? "");
        return row && (row.aggregate_state === "dead_letter" || row.attempt_count > before)
          ? row
          : undefined;
      },
      15_000,
      `delivery retry did not advance past attempt ${before}`,
      250,
    );
  }
  return delivery;
}
