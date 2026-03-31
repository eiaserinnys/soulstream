# Bot Client API Reference

This document covers the HTTP/SSE API for building Slack bots, Discord bots, or any other client that delegates Claude Code sessions to Soulstream.

## Base URL

```
http://<host>:<port>          # default port: 3105
```

## Authentication

If `AUTH_BEARER_TOKEN` is set on the server, include it in every request:

```
Authorization: Bearer <token>
```

Requests without a valid token return `403 Forbidden`.

## Typical bot flow

```
1. POST /execute            → receive agent_session_id + SSE stream
2. Stream SSE events        → relay text_delta events to the chat thread
3. POST .../intervene       → send follow-up messages from users
4. POST .../respond         → answer AskUserQuestion prompts
5. Session reaches complete/error → done
```

## Endpoints

### POST /execute

Start a new Claude Code session. The response is an SSE stream; the first event is always `init` and contains the `agent_session_id`.

**Request body**

```json
{
  "prompt": "string (required) — the user's message",
  "agent_session_id": "string (optional) — resume an existing session",
  "client_id": "string (optional) — your bot's identifier",
  "context": {
    "items": [
      {
        "type": "string",
        "content": "string"
      }
    ]
  },
  "attachment_paths": ["string"],
  "allowed_tools": ["string"],
  "disallowed_tools": ["string"],
  "use_mcp": true,
  "model": "string (optional) — Claude model name",
  "folder_id": "string (optional) — place session in a dashboard folder",
  "system_prompt": "string (optional) — prepended system prompt",
  "profile": "string (optional) — agent profile ID"
}
```

**Response**

`Content-Type: text/event-stream`

Each line is a standard SSE event:

```
data: {"type": "init", "agent_session_id": "sess-abc123"}

data: {"type": "text_delta", "timestamp": 1234567890.123, "text": "Hello"}

data: {"type": "complete", "timestamp": 1234567890.456}
```

**Error responses**

| Status | Code | Meaning |
|--------|------|---------|
| `409` | `SESSION_ALREADY_RUNNING` | `agent_session_id` is already active |
| `503` | `MAX_SESSIONS_REACHED` | Server is at capacity |

**Minimal example (Python)**

```python
import httpx

async def run_session(prompt: str, base_url: str, token: str):
    headers = {"Authorization": f"Bearer {token}"}
    payload = {"prompt": prompt, "client_id": "my-slack-bot"}

    async with httpx.AsyncClient() as client:
        async with client.stream("POST", f"{base_url}/execute",
                                 json=payload, headers=headers) as resp:
            session_id = None
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                event = json.loads(line[6:])

                if event["type"] == "init":
                    session_id = event["agent_session_id"]
                elif event["type"] == "text_delta":
                    print(event["text"], end="", flush=True)
                elif event["type"] in ("complete", "error"):
                    break

    return session_id
```

**Minimal example (Node.js)**

```js
import fetch from 'node-fetch';

async function runSession(prompt, baseUrl, token) {
  const res = await fetch(`${baseUrl}/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ prompt, client_id: 'my-discord-bot' }),
  });

  let sessionId = null;
  for await (const chunk of res.body) {
    for (const line of chunk.toString().split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === 'init')        sessionId = event.agent_session_id;
      if (event.type === 'text_delta')  process.stdout.write(event.text);
      if (event.type === 'complete' || event.type === 'error') break;
    }
  }
  return sessionId;
}
```

### GET /events/{agent_session_id}/stream

Reconnect to the SSE stream for a running session. Use the `Last-Event-ID` header to resume from a specific event.

**Path parameter**

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent_session_id` | string | Session identifier |

**Headers**

| Header | Description |
|--------|-------------|
| `Last-Event-ID` | Resume from this event ID (optional) |

**Response**

Same SSE stream format as `/execute`.

**Error responses**

| Status | Code | Meaning |
|--------|------|---------|
| `404` | `SESSION_NOT_FOUND` | Session does not exist |

### POST /sessions/{agent_session_id}/intervene

Send a follow-up message into a running session. Use this to forward messages from other users in the same thread, or to inject additional context.

The session resumes automatically if it was interrupted.

**Request body**

```json
{
  "text": "string (required) — message text",
  "user": "string (required) — sender identifier (e.g. Slack user ID)",
  "attachment_paths": ["string (optional)"]
}
```

**Response** `202 Accepted`

```json
{
  "queued": true,
  "queue_position": 0
}
```

**Error responses**

| Status | Code | Meaning |
|--------|------|---------|
| `404` | `SESSION_NOT_FOUND` | Session does not exist |

### POST /sessions/{agent_session_id}/respond

Send the user's answer to an `input_request` event (generated by the `AskUserQuestion` tool).

**Request body**

```json
{
  "request_id": "string (required) — from the input_request event",
  "answers": {
    "Question text here": "Selected option label"
  }
}
```

**Response** `200 OK`

**Error responses**

| Status | Code | Meaning |
|--------|------|---------|
| `404` | `SESSION_NOT_FOUND` | Session does not exist |
| `409` | `INPUT_REQUEST_NOT_FOUND` | `request_id` is unknown or already answered |
| `422` | `INPUT_REQUEST_EXPIRED` | The request timed out |

### GET /sessions/{agent_session_id}

Poll the current status of a session.

**Response**

```json
{
  "agent_session_id": "sess-abc123",
  "status": "running | completed | error | interrupted",
  "result": "string (final output, if completed)",
  "error": "string (error message, if failed)",
  "claude_session_id": "string",
  "pid": 12345,
  "created_at": "2026-01-01T00:00:00Z",
  "completed_at": "2026-01-01T00:01:00Z"
}
```

## SSE event reference

All events share a `type` field. The stream ends when `complete` or `error` is received.

| `type` | Key fields | Description |
|--------|-----------|-------------|
| `init` | `agent_session_id` | Stream open; session ID assigned |
| `text_start` | `timestamp`, `parent_event_id` | Response text block starting |
| `text_delta` | `timestamp`, `text` | Incremental response text |
| `text_end` | `timestamp` | Response text block complete |
| `thinking` | `timestamp`, `thinking` | Extended thinking content |
| `tool_start` | `timestamp`, `tool_name`, `tool_input`, `tool_use_id` | Tool call started |
| `tool_result` | `timestamp`, `tool_name`, `result`, `is_error`, `tool_use_id` | Tool result |
| `subagent_start` | `timestamp`, `agent_id`, `agent_type` | Sub-agent spawned |
| `subagent_stop` | `timestamp`, `agent_id` | Sub-agent finished |
| `input_request` | `timestamp`, `request_id`, `questions`, `timeout_sec` | `AskUserQuestion` fired |
| `input_request_expired` | `timestamp`, `request_id` | Input request timed out |
| `input_request_responded` | `timestamp`, `request_id` | Input request answered |
| `intervention_sent` | *(varies)* | User intervention delivered |
| `result` | `timestamp`, `success`, `output`, `error`, `usage` | Session result summary |
| `complete` | `timestamp` | Session finished successfully |
| `error` | `timestamp`, `error` | Session failed |
| `progress` | `timestamp`, `message` | Informational progress update |
| `credential_alert` | `utilization`, `rate_limit_type` | Credential near rate limit |

## Handling interactive sessions (`input_request`)

When the Claude Code agent calls `AskUserQuestion`, Soulstream emits an `input_request` event and pauses the session until a response arrives. Your bot must:

1. Detect `input_request` events in the SSE stream.
2. Present the questions to the user in the chat UI.
3. Call `POST /sessions/{id}/respond` with the user's selection.

If no response arrives within `timeout_sec`, the session continues with defaults and emits `input_request_expired`.

```python
if event["type"] == "input_request":
    request_id = event["request_id"]
    for q in event["questions"]:
        # Show q["question"] and q["options"] to the user
        pass

    # After user selects...
    await client.post(f"{base_url}/sessions/{session_id}/respond",
        json={"request_id": request_id, "answers": {"Which model?": "Sonnet"}},
        headers=headers,
    )
```

## Reconnection

If the SSE connection drops mid-session, reconnect with `GET /events/{id}/stream` and pass `Last-Event-ID` to skip already-received events:

```python
headers["Last-Event-ID"] = last_received_event_id
async with client.stream("GET", f"{base_url}/events/{session_id}/stream",
                         headers=headers) as resp:
    ...
```

## Rate limits and capacity

- `503 SERVICE_UNAVAILABLE` means the server has reached `MAX_CONCURRENT_SESSIONS`.
- Retry with exponential backoff. A `complete` or `error` on another session will free a slot.
- Monitor `credential_alert` events to detect credential utilization warnings before hitting limits.
