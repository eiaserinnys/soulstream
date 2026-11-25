# MCP Server

Soulstream exposes a built-in MCP server that Claude Code, Codex, and other MCP clients can connect to. Through this server, a running session can inspect the service itself, query session history, search past conversations, manage folders, and reflect on what capabilities the server provides.

The current reflection source of truth is the TypeScript `soul-server-ts` MCP server.

## Connecting

Release readiness checks ping, list tools, and perform a forwarded read through the node-local internal MCP listener.

The worker exposes Streamable HTTP only on its authenticated internal listener. The public listener has no generic or dedicated MCP route. Dot connects to the orchestrator's credential-bound external ingress, which owns its 65-tool listing, subscription state, and outbound messages. See [connector ownership](external-llm-ingress-rollout.md) and [dot subscriptions](dot-mcp-events.md).

Soulstream's own Claude SDK clients use the separate `${MCP_PATH}/internal` route (default `/mcp/internal`). It is mounted only on a second listener hard-bound to `127.0.0.1:MCP_INTERNAL_PORT`; the public listener has no internal route. `MCP_INTERNAL_PORT` defaults deterministically to `PORT+1` and must differ from `PORT`. The internal route is always stateless: every POST gets a fresh transport, agent-session ownership is applied from the node-local request, and stale `Mcp-Session-Id` values cannot strand a runner after host restart.

The Claude SDK HTTP MCP configuration accepts a URL but no Unix-domain-socket transport option, so the internal boundary uses a dedicated loopback TCP listener. nginx and every other public reverse proxy must forward only `PORT` and must never forward `MCP_INTERNAL_PORT`. Known internal server names (`soulstream`, `soulstream-cogito`, `soul-server-ts`) are rewritten to the node-local internal URL when Claude SDK options are built. External MCP servers and legacy SSE URLs are unchanged.

Node-local clients configure the internal listener and authentication in their private MCP configuration. The illustrative endpoint below is node-local:

```json
{
  "mcpServers": {
    "soul-server-ts": {
      "type": "streamable_http",
      "url": "http://localhost:4206/mcp/internal"
    }
  }
}
```

Once connected, the common tools documented below are available inside the client session. The live
inventory is returned by `tools/list` and by `reflect_service` Level 0 under the `mcp_tools` capability.

## Tools

### Service reflection

| Tool | Description |
|------|-------------|
| `reflect_service(service, level)` | Query a service at depth 0–3: features → config → source locations → runtime state |
| `reflect_brief()` | Self-only compact aggregate over this TS node's Level 0–3 reflection, returned in memory |
| `reflect_cluster_brief()` | Orchestrator-backed aggregate of connected TS nodes' self `reflect_brief` snapshots |

Use `reflect_brief()` when an agent needs a small, machine-readable startup view for the current node. It combines
identity/capabilities, configuration status, core source pointers, and runtime/dependency health in
one response. Use `reflect_service("soul-server-ts", level)` for drilldown when a section points to a
specific level.

Use `reflect_cluster_brief()` when an agent needs the orchestrator's view across connected TS nodes. The tool calls
the orchestrator API and keeps node failures local to each node entry. It does not replace self `reflect_brief()`;
the names are intentionally different so callers can choose local self-diagnosis or cluster diagnosis explicitly.

Agent startup also consumes the same orchestrator aggregate through `GET /cogito/briefs`, but it does not inject the
raw aggregate into the prompt. `soul-server-ts` builds a separate `<cogito_context>` item with a compact allowlist:
node status, service status, capability names, task/agent counts, dependency statuses, uptime, and memory counters.
Raw environment variables, tokens, argv/cmdline, executable paths, credential paths, and full runtime payloads are
omitted. Lookup failure, timeout, an empty cluster, or per-node failure must not block session creation; the startup
context records a short typed warning or an empty/partial status and continues.

`reflect_service("soul-server-ts", level)` returns a typed envelope for every level:

```json
{
  "schema_version": "soulstream.reflect.v1",
  "generated_at": "2026-05-25T00:00:00.000Z",
  "service": "soul-server-ts",
  "node_id": "node-id",
  "level": 2,
  "status": "ok",
  "summary": "source entrypoints, files, symbols, and line ranges",
  "data": {},
  "errors": []
}
```

Level-specific fields are always under `data`. Top-level compatibility aliases may exist for older callers, but new callers should read the envelope.

**Level guide for `reflect_service`:**

| Level | Returns |
|-------|---------|
| 0 | Identity + MCP capability list |
| 1 | Config / environment variable state with present, missing, default, redacted, or unavailable status |
| 2 | Source root, source file paths, capabilities, symbols, and runtime-computed line ranges |
| 3 | Runtime process details, memory, uptime, task/agent counts, database probe status, and orchestrator proxy status |

Unavailable runtime facts are represented structurally, for example `{ "status": "unavailable", "reason": "..." }` or `{ "status": "not_configured" }`. Reflection should not guess values that the TS node cannot verify.

`reflect_brief()` may also report aggregate providers that are not available from the local node. Cross-node lookup
belongs to the orchestrator-backed `reflect_cluster_brief()` path.

### Event ingress observability

| Tool | Description |
|------|-------------|
| `list_event_ingress_dead_letters(state, since, until, node_id, limit, cursor)` | Read-only listing of the orchestrator's event ingress dead-letter files. `state` is `dead_lettered` (default), `retrying`, or `all`; `since`/`until` filter on the record time (inclusive start, exclusive end); `node_id` filters one sender; `limit` is 1–100 (default 20); `cursor` is the previous `next_cursor` and pages by `(recorded_at, id)`. Items carry envelope metadata, failure counters, `recorded_at`, and `delay_ms` — never the event payload, `searchable_text`, `semantic_dedupe_key`, `session_effect`, or raw `failures[]`. Unparseable files are skipped and counted in `unreadable_count`. A missing directory returns an empty list with `directory_exists: false`. The list reads the files directly, so it still works while a deployment handover has paused writes. `STALE_REGISTRATION` rejections never create a dead-letter file and do not appear here. |
| `get_event_ingress_delivery_latency(since, until, node_id)` | Read-only delivery latency: `event_ingress_receipts.created_at` (orchestrator commit time) minus `events.created_at` (node-created time), joined on `session_id` and `event_id`. Defaults to the last hour; the window must be at most 7 days and `since < until`. Returns `overall` and `by_node[]` with `count`, `p50_ms`, `p90_ms`, `p99_ms`, `max_ms`, plus the 5 slowest events. Negative delays are reported unchanged when node clocks differ. The query runs under a transaction-local 55-second `statement_timeout`, with a 60-second tool timeout. |

Both are `internal` cluster tools: the orchestrator reads its own dead-letter directory and database, and worker nodes
reach them through the usual cluster forwarding. Node-local outbox backlog and quarantine JSONL are out of scope.

### Session history

| Tool | Description |
|------|-------------|
| `list_sessions(search, folder_name, node_id, ...)` | Paginated session list — lightweight fields only |
| `get_session_summary(session_id, max_response_chars)` | Legacy event-based turn reconstruction: user prompts, response previews, tools used, context usage |
| `get_session_highlight(session_id)` | Stored highlight, or chronological stored turn summaries when no story exists; `source` is `story`, `turn_summaries`, or `empty` |
| `get_session_story(session_id, include_highlight=false)` | Folded narrative plus all still-unfolded turn summaries; highlight body is opt-in and `source` is explicit |
| `get_session_turn_summaries(session_id, mode, ...)` | Stored turn-summary count, single index, or chronological range |
| `expand_session_turn(session_id, turn, to_turn, include_tools, max_chars)` | Read turn summaries and original events by turn number; original events include user input and responses by default |
| `list_session_events(session_id, event_types, ...)` | Raw event stream with pagination and truncation control |
| `get_session_event(session_id, event_id)` | Full content of a single event (no truncation) |
| `list_user_messages(since, until, sources, cursor, limit, max_text_chars)` | Internal only. `user_message` events in a time range across sessions, oldest first, with text and `caller_info` fields only (no injected context). Without `sources`, `agent`, `api`, `channel_observer`, `execute-proxy`, `llm`, `external`, `system` and messages with no source are left out; text over `max_text_chars` is cut and flagged `truncated` (full text via `get_session_event`) |
| `list_persistent_session_history(session_id, since, until, cursor, limit, max_text_chars)` | Internal only. Read persistent session inputs, final responses, notifications, and generation boundaries in time order; use `get_session_event` for truncated text |
| `list_turn_usage(session_id, since, until, cursor, limit)` | Internal only. Reads per-turn token usage in time order for one session or a period; includes `complete`, failed usage, and closed turns without usage. Input tokens include cached tokens; cost is a list-price estimate. |
| `summarize_turn_usage(since, until)` | Internal only. Returns period totals, agent/model groups, and the 20 most expensive sessions; new-session injection and first-call statistics use sessions created in the period. Use `list_turn_usage` for individual turns. |
| `search_sessions(query, top_k=10, folder_id)` | Search past sessions by meaning, ranked by relevance; includes `created_at` and `updated_at` ISO timestamps; use `search_session_history` for exact event text |
| `search_session_history(query, session_ids, event_types, search_session_id, include_turn_summaries, include_highlight, include_story, top_k)` | BM25 event search with actual turn count and saved summary/story/highlight presence metadata; use `search_sessions` first for session-level search |

### Chat UI publication

`publish_chat_ui(publication_key, document)` is an internal-only tool for a currently executing, registered agent session. It validates the document and publishes one durable `assistant_message` containing both readable fallback text and the `ui` payload. Repeating the same key and document in the same session is idempotent; publish changed content with a new key. Validation errors include the failing path and reason. Until clients render the `ui` payload, the readable text is what appears in chat. Published screens cannot be edited, and their local interactions do not call the model.

### Session management

| Tool | Description |
|------|-------------|
| `set_session_name(session_id, name)` | Set the display name shown in the dashboard |
| `get_session_name(session_id)` | Read the current display name |
| `delete_session(session_id)` | Permanently delete a session and all its events |

### Recurring jobs

Recurring-job tools require a trusted Soulstream caller session with a verified owner email. Public and external/LLM MCP callers cannot use them. The tools delegate to the same orchestrator service and CAS validation as web and soul-app.

| Tool | Description |
|------|-------------|
| `list_recurring_jobs(include_archived)` | List the caller's jobs |
| `get_recurring_job(job_id)` | Read one job and its server-computed next execution |
| `preview_recurring_schedule(timezone, schedule_expressions)` | Preview the next five occurrences |
| `create_recurring_job(...)` | Create a recurring job with `schedule_expressions`, a one-time job with offset ISO 8601 `run_at`, or a node-connected event job with `event_trigger` (exactly one of the three); one-time jobs, `repeat: false` event jobs, and run history are deleted when session creation is confirmed |
| `update_recurring_job(job_id, expected_version, ...)` | Change a recurring job or pause/resume it with CAS; change a one-time execution time with `run_at`; change an event job's condition with `event_trigger` (changing the kind is rejected) |
| `run_recurring_job(job_id, idempotency_key)` | Request one manual run, including while paused |
| `archive_recurring_job(job_id, expected_version)` | Archive a job without terminating an already running session |
| `list_recurring_job_runs(job_id, limit)` | Read run history and its linked session IDs |

`model_preset_fallbacks` on create or update lists ordered preset IDs advertised by the job's node for dispatch and runtime limit fallback. Omit it on update to retain the list, or pass `[]` to clear it.

### Webhooks

Webhook tools are internal only and need a trusted Soulstream caller session with a verified owner. The owner is that session's owner, so the same webhooks appear in that person's settings-screen Webhooks tab; the tools call the same management commands as `/api/webhooks/inbound` and `/api/webhooks/outbound`. `secret`, `signing_secret` and `key_url` appear only in the create result. Errors are the routes' code words (`session_not_found`, `forbidden`, `not_found`, `challenge_failed: <reason>`, `subscription_inactive`, `invalid_request: <path>`, `webhooks_unavailable`) and never carry secrets, keys or receiver URLs.

| Tool | Description |
|------|-------------|
| `create_inbound_webhook(target_session_id, label, auth_mode, preamble, expires_in_seconds)` | Issue an inbound webhook that puts external input into the target session; returns `secret` once, plus `key_url` for key mode |
| `revoke_inbound_webhook(id)` | Revoke one inbound webhook; later requests with its credential are refused |
| `create_outbound_webhook(target_session_id, label, url, event_types)` | Register an outbound subscription after the https public `url` echoes the verification challenge; returns `signing_secret` once |
| `set_outbound_webhook_active(id, active)` | Turn an outbound subscription off or on |
| `delete_outbound_webhook(id)` | Delete an outbound subscription and its delivery records |
| `redeliver_outbound_webhook(id, delivery_id)` | Send one delivery again now and return its `outcome` |
| `list_webhooks(direction)` | List the owner's inbound webhooks (with `state` and `recent`) or outbound `subscriptions`, without secrets |
| `list_webhook_activity(direction, id, state, limit)` | Read one webhook's recent inbound requests (`limit` 1-50, default 20) or outbound deliveries filtered by `state` |

### Folder management

| Tool | Description |
|------|-------------|
| `list_folders()` | List all folders |
| `list_child_folders(folder_id)` | List direct child folders under a folder |
| `browse_folder(folder_id, session_cursor, session_limit)` | Browse one folder: direct child folders, paginated sessions, and board items such as markdown documents and image/file assets |
| `create_folder(name)` | Create a new folder |
| `rename_folder(folder_id, name)` | Rename a folder |
| `delete_folder(folder_id)` | Delete a folder |
| `move_sessions_to_folder(session_ids, folder_id)` | Move sessions into a folder (pass `null` to unassign) |

### Card maintenance

`update_unstarted_card`, `merge_cards`, and `bulk_set_card_status` are internal-only tools for tidying cards before their first start. `update_unstarted_card(card_id, idempotency_key, ...)` edits the title, request, brief, assignee agent, model preset, node, or prerequisite cards (`depends_on`, replaced as a whole; an empty array clears them) of a card that is not archived, has no human or session assignee, is `todo`/`queued`/`on_hold`, and has no pending execution result, keeping its status and queue position. `merge_cards(target_card_id, source_card_ids, idempotency_key)` folds 1 to 9 unstarted source cards into an unstarted target in one transaction, appending request sections, user comments, handoff text, attachments, notes, and items, then cancels the sources; one ineligible card leaves everything unchanged. `bulk_set_card_status(card_ids, status, reason, idempotency_key)` moves 1 to 20 cards to `todo`/`queued`/`on_hold`/`cancelled` in separate transactions and returns `{card_id, ok, status, version}` or `{card_id, ok: false, error}` for each; a connected assignee may only be held or cancelled while idle, and its session and worktree stay connected. Card references with `#N` are accepted in `target_card_id`, `source_card_ids`, and `card_ids`. None of the three tools is exposed through external ingress. `create_card` also accepts `depends_on` (up to 10 prerequisite cards by `#N` or UUID) for a queued card, which the queue does not start until every prerequisite is done; it cannot be combined with `run=true`. `run_card` starts a card without checking its prerequisites.

### Agent and MCP config

| Tool | Description |
|------|-------------|
| `get_agents_config(include_raw)` | Read `agents.yaml`, optionally including raw YAML |
| `list_mcp_registry()` | Read `mcp-registry.yaml` server definitions with sensitive header/env values redacted |
| `list_mcp_profiles()` | Read `mcp-profiles.yaml` exposure presets |
| `plan_agent_profile_update(profile, create_if_missing, include_text_diff)` | Plan a top-level `agents.yaml` profile patch without writing: only supplied fields change, omitted fields are preserved, `null` deletes a field, nested objects are replaced rather than merged, and unknown top-level keys are rejected |
| `update_agent_profile(profile, create_if_missing, expected_config_checksum)` | Apply the same top-level profile patch with snapshot/checksum guard: only supplied fields change, omitted fields are preserved, `null` deletes a field, nested objects are replaced rather than merged, and unknown top-level keys are rejected |
| `plan_agent_mcp_profile_update(agent_id, mcp_profile)` | Plan only an agent's `mcp_profile` reference change without writing |
| `set_agent_mcp_profile(agent_id, mcp_profile)` | Set or clear only an agent's `mcp_profile` reference |
| `set_agent_atom_contexts(agent_id, atom_contexts)` | Set only an agent's atom contexts |
| `rollback_agents_config(snapshot_path)` | Restore `agents.yaml` from a managed ConfigStore snapshot |

`mcp_profile` is a convenience preset, not a hard security boundary. Profile defaults are expanded from
`mcp-profiles.yaml` and `mcp-registry.yaml` before an OpenAI Agents runtime starts. Inline
`agents_sdk.agents[].mcp_servers` and `hosted_tools` remain valid and override profile defaults by effective tool or
server key.

## REST endpoints

One endpoint is also available outside of MCP:

```
GET  /cogito/search?q=<query>&top_k=10   — 세션 검색: lexical은 제목 검색, expanded는 제목 검색과 세션 문서 bigram 후보를 Jev로 재판정
GET  /cogito/briefs                      — aggregate connected TS node reflect_brief snapshots
```
