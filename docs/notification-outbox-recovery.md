# Notification outbox recovery

Completion notifications remain bound to the target session's canonical owner node. A temporary node disconnect does not migrate ownership or publish the notification from another node. The row remains pending until that node reconnects and claims it.

Claim attempt tokens are recovered after their TTL expires. Retry uses bounded exponential backoff, with a ceiling of 16 attempts and a maximum row age of 24 hours. Reaching either ceiling moves the row to `dead_letter`. If the target session no longer has an owner node, the next claim scan dead-letters it immediately instead of guessing a destination.

Inspect the dead-letter queue without printing message payloads:

```bash
npm --prefix soul-server-ts run notification-outbox:list-dlq -- --limit 100
```

After restoring the target session and its owner node, explicitly requeue one delivery:

```bash
npm --prefix soul-server-ts run notification-outbox:requeue -- \
  --delivery-id <delivery-id> --confirm-requeue
```

Both commands call the node-local soul-server instead of the orchestrator. The address is the same internal MCP listener isolated sessions already use: `MCP_INTERNAL_PORT` (default `PORT + 1`) under `MCP_PATH` (default `/mcp`), so the server serves them at `GET <MCP_PATH>/internal/notification-dlq/dead-letters?limit=<n>` and `POST <MCP_PATH>/internal/notification-dlq/requeue` with `{"deliveryId": "<id>"}`.

`AUTH_BEARER_TOKEN` must be the shared service token or a full-session token (`ssf1`); restricted session tokens (`ssr1`) receive 403, so the commands do not work inside an isolated restricted session. The server calls the orchestrator with its own service credential.

Requeue only accepts a row currently in `dead_letter`; it resets the retry count, error, attempt token, and deadline, then makes the row immediately claimable. It does not alter session ownership.
