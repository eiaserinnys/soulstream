import { createNotificationDlqClient, readArgument } from "./notification_dlq_cli_common.js";

const rawLimit = readArgument(process.argv.slice(2), "--limit");
const limit = rawLimit === undefined ? 100 : Number(rawLimit);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
  throw new Error("usage: list_notification_dlq [--limit <1..1000>]");
}

const rows = await createNotificationDlqClient().listDeadLetters(limit);
const entries = rows.map((row) => ({
  deliveryId: row.delivery_id,
  targetSessionId: row.target_session_id,
  disposition: row.disposition,
  attemptCount: row.attempt_count,
  lastError: row.last_error,
  createdAt: row.created_at,
  deadLetteredAt: row.dead_lettered_at,
}));
process.stdout.write(`${JSON.stringify({ count: entries.length, entries }, null, 2)}\n`);
