export { buildDeterministicDeliveryIdentity, buildDeliveryInputUuid, hashDeliveryPayload } from "@soulstream/wire-schema/delivery";
export type { DeterministicDeliveryIdentity } from "@soulstream/wire-schema/delivery";

/** 같은 전송의 user_message와 intervention_sent가 함께 쓰는 키라 재시도가 입력 기록을 두 번 남기지 않는다. */
export function buildDeliveryInputDedupeKey(deliveryId: string): string {
  return `delivery_input:${deliveryId}`;
}
