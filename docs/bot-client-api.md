# Bot Client API

This guide covers the authenticated HTTP and Server-Sent Events (SSE) routes
that a bot uses to create, observe, and continue Soulstream sessions.

These routes are served by the TypeScript orchestrator. Execution workers
register with the orchestrator and may expose worker-local operational or MCP
surfaces, but they do not host this public bot session API. Bot clients call the
orchestrator rather than a worker.

The implementation contracts are:

- [`orch-server-ts/src/execute/execute_proxy_routes.ts`](../orch-server-ts/src/execute/execute_proxy_routes.ts)
- [`orch-server-ts/src/execute/execute_proxy_payloads.ts`](../orch-server-ts/src/execute/execute_proxy_payloads.ts)
- [`orch-server-ts/src/session/session_history_routes.ts`](../orch-server-ts/src/session/session_history_routes.ts)
- [`orch-server-ts/src/session/session_action_command_routes.ts`](../orch-server-ts/src/session/session_action_command_routes.ts)
- [`orch-server-ts/src/session/session_command_routes.ts`](../orch-server-ts/src/session/session_command_routes.ts)
- [`packages/wire-schema/generated/typescript/index.ts`](../packages/wire-schema/generated/typescript/index.ts)

## Base URL

The orchestrator defaults to port `5200`:

```text
http://127.0.0.1:5200
```

Use the deployed orchestrator's HTTPS URL outside local development. Every API
path in this document begins with `/api`.

## Authentication

Production bot requests must send a bearer credential accepted by the
orchestrator:

```http
Authorization: Bearer <service-token>
```

Missing credentials normally return `401 Unauthorized`; rejected credentials
return `403 Forbidden`. Keep tokens in the bot's secret store, not in source or
configuration examples committed to the repository.

## Typical bot flow

1. Open `POST /api/execute` with a prompt and agent profile.
2. Read the `init` SSE event and retain `agent_session_id`.
3. Relay live response events to the chat thread and retain each numeric SSE
   `id`.
4. If the connection drops, reconnect with
   `GET /api/sessions/{agent_session_id}/events` and `Last-Event-ID`.
5. Send a message to an already observed session with
   `POST /api/sessions/{agent_session_id}/intervene`.
6. Answer an `input_request` with
   `POST /api/sessions/{agent_session_id}/respond`.

## POST /api/execute

Creates a session or resumes an existing one and returns an SSE stream.

### Create a session

`profile` is required for a new session. `agentId` is accepted as its alias.
`prompt` is a string and defaults to an empty string when omitted.

```json
{
  "prompt": "Summarize the latest support request.",
  "profile": "codex-default"
}
```

Common optional new-session fields are:

| Field | Type | Purpose |
|---|---|---|
| `node_id` | string | Request a particular connected worker. |
| `allowed_tools` | string array | Restrict the tools advertised to the agent. |
| `disallowed_tools` | string array | Deny specific tools. |
| `claude_permission_mode` | string | Claude permission mode. |
| `use_mcp` | boolean | Enable the configured MCP profile for the turn. |
| `folder_id` | string | Place the new session in a dashboard folder. |
| `system_prompt` | string | Add a session system prompt. |
| `model` | string | Explicit model override accepted by the execution proxy. |
| `reasoningEffort` | string | Codex reasoning effort: `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `caller_info` | object | Structured caller metadata. The proxy derives basic metadata when omitted. |
| `context_items` | object array | Additional structured context items. |

If neither `profile` nor `agentId` is supplied, the orchestrator returns `422`
with `AGENT_PROFILE_REQUIRED`.

### Resume through the execute stream

Set `agent_session_id` to route the prompt to an existing session while opening
a new SSE response stream:

```json
{
  "agent_session_id": "2de59061-6c36-4b48-9446-cccd7cf86ec4",
  "prompt": "Continue with the next step.",
  "attachment_paths": ["uploads/context.txt"]
}
```

Resume requests also accept `caller_info`, `context_items`, and the camelCase
alias `attachmentPaths`. New-session profile fields are not required when
`agent_session_id` is present.

### SSE response

The response has `Content-Type: text/event-stream`. The first event identifies
the session and selected worker:

```text
event: init
data: {"type":"init","agent_session_id":"2de59061-6c36-4b48-9446-cccd7cf86ec4","node_id":"worker-a"}

event: text_delta
id: 42
data: {"type":"text_delta","text":"Working"}

event: complete
id: 43
data: {"type":"complete","result":"Done"}
```

The execute stream sends a comment keepalive about every 30 seconds while no
event is available. It closes after a `complete` or `error` event.

### Minimal curl request

```bash
curl --no-buffer \
  --request POST \
  --header "Authorization: Bearer $SOULSTREAM_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"prompt":"Hello","profile":"codex-default"}' \
  "$SOULSTREAM_URL/api/execute"
```

## GET /api/sessions/{agent_session_id}/events

Opens the durable per-session SSE stream. It replays stored events newer than
the supplied cursor, then follows live events while the owning worker is
connected.

Send the last processed numeric SSE ID:

```http
Last-Event-ID: 42
```

The `lastEventId` query parameter is also accepted, but the header takes
precedence. Without a positive cursor, the route establishes the current
baseline instead of replaying the full history.

The stream starts with an `init` event whose payload uses `agentSessionId`, then
ends its initial synchronization window with `history_sync`:

```text
event: init
data: {"agentSessionId":"2de59061-6c36-4b48-9446-cccd7cf86ec4"}

event: history_sync
data: {"type":"history_sync","last_event_id":42,"is_live":true}
```

`is_live` tells the client whether the orchestrator attached a live event
subscription. Store the largest event `id` only after processing its payload so
that reconnects do not skip unhandled events.

```bash
curl --no-buffer \
  --header "Authorization: Bearer $SOULSTREAM_TOKEN" \
  --header "Last-Event-ID: 42" \
  "$SOULSTREAM_URL/api/sessions/$SESSION_ID/events"
```

## POST /api/sessions/{agent_session_id}/intervene

Sends a message to an existing session. `text` is required. `user` is optional
and defaults to an empty string.

```json
{
  "text": "Please also compare the mobile behavior.",
  "user": "slack-user-123",
  "caller_info": {
    "source": "slack",
    "display_name": "Example User"
  }
}
```

Optional fields include `attachment_paths` or `attachmentPaths`,
`context_items` or `contextItems`, and `caller_info`. A successful worker ACK is
returned as JSON; the common shape is:

```json
{
  "status": "ok",
  "type": "intervene_ack"
}
```

The orchestrator returns `404` when no owner can be resolved and `503` when the
owner is stale, unavailable, or times out. A worker-level rejection is returned
as `422`.

## POST /api/sessions/{agent_session_id}/respond

Answers a pending `input_request` event.

```json
{
  "request_id": "input-request-7",
  "answers": {
    "Which environment should I inspect?": "Production"
  }
}
```

`requestId` is accepted as an alias for `request_id`. `answers` must be a JSON
object. A successful response returns the worker's `respond_ack`, including the
resolved input request ID.

Relevant failures are:

| Status | Code |
|---|---|
| `404` | `SESSION_NOT_FOUND` |
| `409` | `SESSION_NOT_RUNNING` |
| `422` | `REQUEST_NOT_PENDING` |
| `422` | `INPUT_REQUEST_EXPIRED` |
| `422` | `INPUT_REQUEST_ALREADY_RESPONDED` |
| `422` | `INPUT_RESPONSE_NOT_SUPPORTED` |

## SSE event handling

Each server frame uses the SSE `event` field and a JSON `data` payload. For
worker-originated events, `event` normally matches `data.type`. Numeric `id`
values are durable replay cursors. Lines beginning with `:` are keepalive
comments and can be ignored.

Core bot-facing event types are:

| Type | Client behavior |
|---|---|
| `init` | Capture the session identifier. The execute and history streams use different key casing as shown above. |
| `text_start`, `text_delta`, `text_end` | Render generation-time text. Treat each payload according to the selected backend's emitted fields. |
| `assistant_message` | Durable completed assistant message. |
| `thinking` | Optional reasoning display. |
| `tool_start`, `tool_result` | Render or log tool activity. |
| `input_request` | Present questions and answer through the `respond` route. |
| `input_request_expired`, `input_request_responded` | Clear pending interaction UI. |
| `complete` | The current execute turn completed; the execute stream closes. |
| `error` | The current execute turn failed; the execute stream closes. |
| `session_ended` | Durable session terminal status and termination reason. |
| `history_sync` | The history route reached its stored baseline and reports whether live follow mode is active. |

The event union is open to additional backend and runtime events. Clients should
ignore unknown types after recording their SSE ID rather than failing the
stream. Use the generated wire schema linked at the top of this document as the
complete type inventory.

## Python streaming example

The following example handles the single-line JSON frames emitted by the
orchestrator and records reconnect cursors:

```python
import json

import httpx


async def run_session(base_url: str, token: str, profile: str, prompt: str) -> None:
    headers = {"Authorization": f"Bearer {token}"}
    payload = {"profile": profile, "prompt": prompt}
    event_name = "message"
    last_event_id = None

    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST",
            f"{base_url}/api/execute",
            headers=headers,
            json=payload,
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line or line.startswith(":"):
                    continue
                if line.startswith("event: "):
                    event_name = line[7:]
                    continue
                if line.startswith("id: "):
                    last_event_id = int(line[4:])
                    continue
                if not line.startswith("data: "):
                    continue

                data = json.loads(line[6:])
                if event_name == "init":
                    print("session", data["agent_session_id"])
                elif event_name == "text_delta":
                    print(data.get("text", ""), end="", flush=True)
                elif event_name in {"complete", "error"}:
                    print()
                    break

    print("last processed event id", last_event_id)
```

In production code, persist the session ID and last processed event ID with the
bot thread mapping before acknowledging delivery to the chat platform.
