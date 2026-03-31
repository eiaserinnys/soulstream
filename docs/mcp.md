# MCP Server

Soulstream exposes a built-in MCP server that Claude Code sessions (and any other MCP client) can connect to. Through this server, a running session can inspect the service itself — query session history, search past conversations, manage folders, and reflect on what capabilities the server provides.

## Connecting

The MCP server is mounted at:

```
http://localhost:3105/cogito-mcp/sse   (SSE transport)
```

Add it to `.mcp.json` in the workspace:

```json
{
  "mcpServers": {
    "soulstream-cogito": {
      "type": "sse",
      "url": "http://localhost:3105/cogito-mcp/sse"
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
| `reflect_brief()` | Full Level 0 snapshot of all registered services |
| `reflect_refresh()` | Force-regenerate the brief file on disk |

**Level guide for `reflect_service`:**

| Level | Returns |
|-------|---------|
| 0 | Identity + capability list |
| 1 | Config / environment variable state |
| 2 | Source file paths and line ranges |
| 3 | Runtime status, PID, uptime |

### Session history

| Tool | Description |
|------|-------------|
| `list_sessions(search, folder_name, node_id, ...)` | Paginated session list — lightweight fields only |
| `get_session_summary(session_id)` | Turn-by-turn summary: user prompts, response previews, tools used, context usage |
| `list_session_events(session_id, event_types, ...)` | Raw event stream with pagination and truncation control |
| `get_session_event(session_id, event_id)` | Full content of a single event (no truncation) |
| `search_session_history(query, session_ids, top_k)` | BM25 full-text search across all session events |

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
| `create_folder(name)` | Create a new folder |
| `rename_folder(folder_id, name)` | Rename a folder |
| `delete_folder(folder_id)` | Delete a folder |
| `move_sessions_to_folder(session_ids, folder_id)` | Move sessions into a folder (pass `null` to unassign) |

## REST endpoints

Two endpoints are also available outside of MCP:

```
GET  /cogito/search?q=<query>&top_k=10   — BM25 session history search
POST /cogito/refresh                     — Force-refresh the brief file
```
