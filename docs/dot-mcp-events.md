# Explicit messages to dot subscriptions

The orchestrator owns dot's MCP connector, subscription store, and outbound messages. Workers on every node forward `list_external_llm_recipients` and `send_to_external_llm` to it. An explicit send targets one verified, active recipient; a successful callback response confirms receipt, not reading or processing by dot.

## Enable on the orchestrator

Use the private deployment configuration channel for `NODE_NAME`, `MCP_EXTERNAL_INGRESS_ENABLED`, `MCP_EXTERNAL_INGRESS_PATH`, `MCP_EXTERNAL_INGRESS_SOURCE`, `MCP_EXTERNAL_INGRESS_DISPLAY_NAME`, `MCP_EXTERNAL_INGRESS_BEARER_TOKEN`, `MCP_ALLOWED_HOSTS`, and `MCP_EXTERNAL_EVENTS_STATE_FILE`. Enabling ingress requires `NODE_NAME`. The dedicated bearer differs from `AUTH_BEARER_TOKEN`.

The subscription state file must be absolute, outside release directories, and retained across updates and restarts. Its directory is private and the atomically replaced file is readable only by its owner. It contains callback addresses and signing secrets: never copy its contents into source, logs, public artifacts, or handoffs. Keep the file's existing credential owner during the hosting transition. Without a state-file setting, Events are disabled.

## Subscription contract

The dedicated ingress uses the official MCP SDK2 handler for revision `2026-07-28`. Discovery advertises Events and supports `events/list`, `events/subscribe`, and `events/unsubscribe`. The event name is `soulstream.message.created`. Subscription arguments contain `recipient_label`, a self-reported display label of 1–120 trimmed characters. Labels do not authenticate recipients or select a primary dot.

The server derives subscription ownership from the dedicated route and credential. Subscription IDs depend on owner, event name, normalized arguments, and callback address. Refresh updates the same subscription; changing the route or credential invalidates old recipients. The finite lease is at most 24 hours. Refresh before the returned `refreshBefore`; unsubscribe with the same event, arguments, and callback.

A callback must pass signed challenge verification before activation. Delivery uses HTTPS, validated public addresses with pinned connections, TLS hostname checks, and no redirects. Callback addresses and signing secrets are never returned by recipient listing.

Events carry an ID, name, timestamp, and data containing message ID, text, optional title, sender session ID, and send time. Text is data, without injected model instructions. Transient failures have bounded retries retaining the event ID. An expired or unknown recipient is not sent a message; callback failure is reported with a sanitized reason. There is no implicit broadcast, automatic send, reading acknowledgment, or replay queue.

## Tool access and card behavior

Dot sees the 65 shared definitions with `audience: "all"`. Eight card writes are available with actor `llm`: `create_card`, `update_card_brief`, `add_card_report`, `add_card_comment`, `set_card_status`, `request_card_review`, `ask_card_question`, and `move_card`. Comments are recorded as the user's spoken input. Answers to dot-created questions stay on the card and are not pushed to dot.

The recipient and send tools are internal-only. Recipient listing returns IDs, labels, expiration, and last delivery status, without secrets or callback addresses. Sending requires an authenticated existing sender session; arguments cannot forge that identity. `send_to_external_llm` takes a recipient ID, text, and optional title. It returns `accepted_by_receiver`, `not_sent`, or `delivery_failed` as appropriate.

Workers retain these registrations and always forward to the orchestrator. They do not host dot ingress or subscriptions. Caller metadata source `external-llm` remains attached to connector-originated sessions and messages delivered to workers.

## Dot handoff

Ask dot to rescan the dedicated endpoint, subscribe to `soulstream.message.created` with its display label, and refresh before its lease expires. Select its generated recipient ID explicitly after it appears in recipient listing. Have dot acknowledge a test message visibly, then confirm unsubscribe prevents subsequent delivery. Local callback tests do not prove a real dot is subscribed.

Implementation and fixed contracts: `orch-server-ts/src/external_events/`, `orch-server-ts/src/mcp/external_ingress_server.ts`, `orch-server-ts/tests/mcp-external-ingress.test.ts`, and `orch-server-ts/tests/mcp-external-llm.test.ts`.
