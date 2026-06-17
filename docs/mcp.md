# MCP Server

Soulstream exposes a built-in MCP server that Claude Code, Codex, and other MCP clients can connect to. Through this server, a running session can inspect the service itself, query session history, search past conversations, manage folders, and reflect on what capabilities the server provides.

The current reflection source of truth is the TypeScript `soul-server-ts` MCP server.

## Connecting

The TS MCP server uses Streamable HTTP and is mounted at `MCP_PATH` on the TS node. The default path is:

```
http://localhost:4205/mcp   (Streamable HTTP transport)
```

Add it to `.mcp.json` in the workspace:

```json
{
  "mcpServers": {
    "soul-server-ts": {
      "type": "streamable_http",
      "url": "http://localhost:4205/mcp"
    }
  }
}
```

Once connected, all tools below are available inside the Claude Code session.

## Tools

### Service reflection

| Tool | Description |
|------|-------------|
| `reflect_service(service, level)` | Query a service at depth 0–3: features → config → source locations → runtime state |
| `reflect_brief()` | Self-only compact aggregate over this TS node's Level 0–3 reflection, returned in memory |
| `reflect_cluster_brief()` | Orchestrator-backed aggregate of connected TS nodes' self `reflect_brief` snapshots |
| `reflect_refresh()` | Compatibility no-op; cogito brief files are no longer persisted |

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

### Session history

| Tool | Description |
|------|-------------|
| `list_sessions(search, folder_name, node_id, ...)` | Paginated session list — lightweight fields only |
| `get_session_summary(session_id)` | Turn-by-turn summary: user prompts, response previews, tools used, context usage |
| `list_session_events(session_id, event_types, ...)` | Raw event stream with pagination and truncation control |
| `get_session_event(session_id, event_id)` | Full content of a single event (no truncation) |
| `search_session_history(query, session_ids, event_types, search_session_id, top_k)` | BM25 full-text search across session events, with optional event type and session ID matching |

### Session management

| Tool | Description |
|------|-------------|
| `set_session_name(session_id, name)` | Set the display name shown in the dashboard |
| `get_session_name(session_id)` | Read the current display name |
| `delete_session(session_id)` | Permanently delete a session and all its events |

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

### Agent and MCP config

| Tool | Description |
|------|-------------|
| `get_agents_config(include_raw)` | Read `agents.yaml`, optionally including raw YAML |
| `list_mcp_registry()` | Read `mcp-registry.yaml` server definitions with sensitive header/env values redacted |
| `list_mcp_profiles()` | Read `mcp-profiles.yaml` exposure presets |
| `plan_agent_profile_update(profile, create_if_missing, include_text_diff)` | Plan a semantic `agents.yaml` profile replacement without writing |
| `update_agent_profile(profile, create_if_missing, expected_config_checksum)` | Apply a full profile replacement with snapshot/checksum guard |
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
GET  /cogito/search?q=<query>&top_k=10   — tsvector session history search
GET  /cogito/briefs                      — aggregate connected TS node reflect_brief snapshots
```
