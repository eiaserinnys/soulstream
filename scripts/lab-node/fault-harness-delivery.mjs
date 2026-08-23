import { waitFor } from "./fault-harness-runtime.mjs";

export async function waitForConsumedDelivery(
  runtime,
  sourceSessionId,
  label,
  previousDeliveryId = null,
) {
  return await waitFor(
    async () => {
      const row = await runtime.deliveries.forSource(sourceSessionId);
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
  while (
    Date.now() < deadline
    && !(delivery.state === "uncertain" && delivery.attempt_count >= 16)
  ) {
    const before = delivery.attempt_count;
    await runtime.deliveries.forceDue(delivery.delivery_id);
    delivery = await waitFor(
      async () => {
        const row = await runtime.deliveries.forSource(delivery.source_session_id ?? "");
        return row && (
          (row.state === "uncertain" && row.attempt_count >= 16)
          || row.attempt_count > before
        )
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
