# Notification outbox recovery

Completion notifications remain bound to the target session's canonical owner node. A temporary node disconnect does not migrate ownership or publish the notification from another node. The row remains pending until that node reconnects and claims it.

Claim leases are recovered after expiry. Retry uses bounded exponential backoff, with a ceiling of 16 attempts and a maximum row age of 24 hours. Reaching either ceiling moves the row to `dead_letter`. If the target session no longer has an owner node, the next claim scan dead-letters it immediately instead of guessing a destination.

Inspect the dead-letter queue without printing message payloads:

```bash
npm --prefix soul-server-ts run notification-outbox:list-dlq -- --limit 100
```

After restoring the target session and its owner node, explicitly requeue one delivery:

```bash
npm --prefix soul-server-ts run notification-outbox:requeue -- \
  --delivery-id <delivery-id> --confirm-requeue
```

Both commands require `SOULSTREAM_UPSTREAM_URL` and `AUTH_BEARER_TOKEN`. Requeue only accepts a row currently in `dead_letter`; it resets the retry count, error, lease, and deadline, then makes the row immediately claimable. It does not alter session ownership.
