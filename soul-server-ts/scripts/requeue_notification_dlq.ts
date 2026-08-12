import { createNotificationDlqClient, readArgument } from "./notification_dlq_cli_common.js";

const args = process.argv.slice(2);
const deliveryId = readArgument(args, "--delivery-id");
if (!deliveryId || !args.includes("--confirm-requeue")) {
  throw new Error(
    "usage: requeue_notification_dlq --delivery-id <id> --confirm-requeue",
  );
}

const row = await createNotificationDlqClient().requeueDeadLetter(deliveryId);
if (!row) {
  throw new Error(`dead-letter notification not found: ${deliveryId}`);
}
process.stdout.write(`${JSON.stringify({
  status: "requeued",
  deliveryId: row.delivery_id,
  state: row.state,
  nextAttemptAt: row.next_attempt_at,
}, null, 2)}\n`);
