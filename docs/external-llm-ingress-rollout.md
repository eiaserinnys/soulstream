# External LLM ingress ownership

The orchestrator owns the dot connector's MCP ingress, subscriptions, and outbound delivery. Workers expose only their authenticated, node-local internal MCP listener. Their public listener has no MCP route, including the retired generic and dedicated external paths.

## Configuration

Configure these names on the orchestrator through the private deployment configuration channel; values do not belong in this document:

- `NODE_NAME` is required when enabling external ingress.
- `MCP_EXTERNAL_INGRESS_ENABLED`, `MCP_EXTERNAL_INGRESS_PATH`, `MCP_EXTERNAL_INGRESS_SOURCE`, `MCP_EXTERNAL_INGRESS_DISPLAY_NAME`, and `MCP_EXTERNAL_INGRESS_BEARER_TOKEN` configure the credential-bound connector.
- `MCP_ALLOWED_HOSTS` limits accepted Host headers.
- `MCP_EXTERNAL_EVENTS_STATE_FILE` enables the persistent subscription store.

The dedicated bearer must differ from `AUTH_BEARER_TOKEN`. Keep credentials, callback addresses, state-file contents, and tunnel registration identifiers out of source and reports. Preserve the existing subscription file and credential owner when updating the orchestrator; no worker subscription implementation remains.

## Tools and attribution

The dot inventory consists of the 63 shared definitions with `audience: "all"`. The frozen inventory lives in `orch-server-ts/tests/fixtures/mcp_external_tool_inventory.json`. Internal-only definitions are absent from listing and calls are refused before execution.

Eight card writes are available: `create_card`, `update_card_brief`, `add_card_report`, `add_card_comment`, `set_card_status`, `request_card_review`, `ask_card_question`, and `move_card`. Their actor is `llm`, without an agent session. Dot comments are recorded as the user's spoken input. Answers to dot-created card questions are stored on the card and are not pushed to dot. `start_card_work` remains internal-only.

Sessions and messages originating at the connector retain caller source `external-llm` when routed to a worker. This metadata survives removal of the worker's external MCP principal. The orchestrator's connector supplies the external execution context; worker forwarding bodies accept only `principal: "internal"`.

## Rolling updates

Worker forwards retain the `principal` field with its internal value. An old orchestrator accepts a new worker's body, and a new orchestrator accepts an old worker's internal body. The contract test is `orch-server-ts/tests/mcp-worker-version-compat.test.ts`.

A retired `MCP_EXTERNAL_INGRESS_ENABLED` line in a worker environment file is ignored by configuration parsing and release environment identity. Remove that line after deployment through the normal private configuration process. Other retired connector keys are no longer worker settings.

## Verification

Confirm the internal inventory remains 106 tools and the connector remains 63 tools. Check connector authentication, rejection of internal-only calls without executor invocation, subscription discovery, an explicit send to a verified recipient, and unsubscribe. Worker forwards from any node use the orchestrator for recipient listing and outbound sends.

The subscription compatibility fixture was written by the retired worker implementation with synthetic data. The orchestrator test reads it with the same credential owner and verifies recipient identity, expiration, send, and unsubscribe without a new challenge. Local tests do not establish a live dot subscription; operational acceptance requires the actual connector and recipient.
