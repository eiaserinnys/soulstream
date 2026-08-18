import type {
  SessionDeliveryNotificationOutboxRow,
} from "../db/session_db_types.js";

export interface NotificationReceiptRepository {
  markPublished(
    deliveryId: string,
    leaseOwner: string,
    targetReceiptId: string,
  ): Promise<SessionDeliveryNotificationOutboxRow | null>;
  get(deliveryId: string): Promise<SessionDeliveryNotificationOutboxRow | null>;
}

export async function projectNotificationReceipt(
  repository: NotificationReceiptRepository,
  deliveryId: string,
  leaseOwner: string,
  targetReceiptId: string,
): Promise<"published" | "idempotent"> {
  const published = await repository.markPublished(
    deliveryId,
    leaseOwner,
    targetReceiptId,
  );
  if (published) return "published";

  const current = await repository.get(deliveryId);
  if (
    current?.state === "published"
    && current.projection_state === "published"
    && current.target_receipt_id === targetReceiptId
  ) {
    return "idempotent";
  }
  if (current?.state === "published" && current.target_receipt_id) {
    throw new Error(
      `notification receipt conflict for ${deliveryId}: ${current.target_receipt_id}`,
    );
  }
  throw new Error(`notification publish CAS lost for ${deliveryId}`);
}
