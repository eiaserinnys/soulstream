# Agents and tools

Soulstream equips running agent sessions with structured profiles, on-demand skill compilation, and a built-in MCP tool surface for inspecting and operating the cluster.

## Agent profiles and model presets

Each worker node loads its agent profiles from `agents.yaml` (`AGENTS_CONFIG_PATH`) and model presets from `model-catalog.yaml` (`MODEL_CATALOG_PATH`).

- **Profile management**: operators and agents can inspect and update profiles from the web dashboard (`AgentProfileEditorTab`), mobile app (`SettingsScreen`), or MCP tools (`get_agents_config`, `plan_agent_profile_update`, `update_agent_profile`, `rollback_agents_config`). Remote node profile updates can also be planned and applied through the orchestrator (`plan_remote_agent_profile_update`, `apply_remote_agent_profile_update`, `rollback_remote_agents_config`).
- **Preset availability**: `list_node_model_presets` combines node configuration, provider usage snapshots, and rate-limit events to report preset status. Presets surface explicit availability reasons such as `env_unresolved` (missing environment variables), `not_authenticated` (missing provider credentials), `limit_rejected` (active provider rate-limit or usage rejection until `resets_at`), `quota_exhausted`, or `usage_warning`.

## Skill catalog and `load_skill` link blocks

Agents receive a compact skill catalog at startup and load full procedural instructions on demand via `load_skill(name, intent, pins)`.

When `load_skill` is called, the orchestrator's link-block compiler resolves embedded directives inside the skill document before returning `compiled_markdown`:

- `call`: marks a nested skill invocation point.
- `include`: inlines the body of a referenced document or card.
- `pick`: selects and expands the most relevant domain catalog entries for the caller's `intent` (using `match_skill_catalogs` or explicit `pins`).

Agents can also search the broader skill catalog with `search_skills` and match domain catalogs directly with `match_skill_catalogs`.

## MCP tool groups

Running agent sessions connect to the worker's stateless loopback MCP listener at `http://127.0.0.1:MCP_INTERNAL_PORT/mcp/internal`. See [`docs/mcp.md`](../mcp.md) for the complete tool reference and response schemas.

Major MCP tool groups include:

- **Service reflection (`cogito`)**: `reflect_service(service, level)` (levels `0` to `3` for capabilities, config state, source pointers, and runtime health), `reflect_brief()` for a single-node summary, and `reflect_cluster_brief()` for an orchestrator-backed view across all connected nodes.
- **Session history and search**: `list_sessions`, `search_sessions` (hybrid lexical, bigram BM25, RRF, and optional Jev reranking), `search_session_history` (event-level BM25 search), `list_session_events`, `get_session_event`, `get_session_summary`, `get_session_story`, `get_session_highlight`, and `get_session_turn_summaries`.
- **Session lifecycle and delegation**: `create_agent_session`, `create_remote_agent_session`, `send_message_to_session`, `get_session_name`, `set_session_name`, and `delete_session`.
- **Folder and card orchestration**: `list_folders`, `list_child_folders`, `browse_folder`, `create_folder`, `rename_folder`, `delete_folder`, `create_card`, `run_card`, `dispatch_work`, `get_card`, `list_cards`, `search_cards`, `update_card_brief`, `set_card_items`, `add_card_item`, `report_card_item`, `update_card_now`, `start_card_work`, `request_card_review`, `set_card_status`, `ask_card_question`, `withdraw_card_question`, `add_card_note`, `list_card_notes`, `add_card_comment`, and `transfer_card_assignee`.
- **Chat UI publication**: `publish_chat_ui(publication_key, document)` publishes validated interactive UI payloads alongside readable fallback markdown in chat.

## Worktrees

When `WORKTREE_MCP_ENABLED=true` and `WORKTREE_PROJECTS_ROOT` is configured on a worker, agents can isolate repository edits in dedicated git worktrees rather than mutating shared base checkouts:

- `list_worktrees`: list active worktrees tracked by the control plane.
- `create_worktree`: create a branch and checkout under `.projects/{repo}--{branch-slug}` and bind worktree ownership to the session.
- `remove_worktree`: remove a worktree checkout after changes are merged.
- `delete_worktree_branch`: clean up the local branch after worktree removal.

The control plane tracks active worktree leases so two concurrent sessions cannot occupy the same worktree simultaneously.

## Pages and documents

Soulstream provides two document surfaces inside folders:

- **Collaborative pages**: backed by Y.Doc snapshots in PostgreSQL (`packages/page-model`) and projected to structured blocks. Agents read and update pages with `get_page`, `find_page`, `get_page_markdown`, `get_backlinks`, `create_page`, `upsert_page_markdown`, `batch_page_operations`, and `get_daily_page`. See [`docs/task-page-invariants.md`](../task-page-invariants.md).
- **Folder markdown documents**: lightweight board documents managed via `create_markdown_document`, `get_markdown_document`, `update_markdown_document`, and `delete_markdown_document`.

## Recurring jobs

Trusted sessions with a verified owner email, as well as the web dashboard (`RecurringJobsTab`) and mobile app (`RecurringJobsScreen`), can manage scheduled agent executions:

- Tools: `list_recurring_jobs`, `get_recurring_job`, `preview_recurring_schedule`, `create_recurring_job`, `update_recurring_job`, `run_recurring_job`, `archive_recurring_job`, and `list_recurring_job_runs`.
- Supports recurring cron expressions (`schedule_expressions` with timezone) and one-time scheduled runs (`run_at` in ISO 8601 format with offset).
- Updates use compare-and-swap (`expected_version`) validation. See [`docs/recurring-jobs-deployment.md`](../recurring-jobs-deployment.md).

## Custom views

Agents can create sandboxed HTML widgets on folder boards using `create_custom_view`, `patch_custom_view`, `get_custom_view`, and `list_custom_views`.

- Custom views run inside an `allow-scripts` sandbox without `allow-same-origin`.
- External pages published to allowlisted origins (`CUSTOM_VIEW_FRAME_ORIGINS`) can be embedded via `<iframe>`, and live session or task fields can be bound declaratively using `<soul-bind>`. See [`docs/custom-views.md`](../custom-views.md).

## External LLM ingress

`orch-server-ts` hosts authenticated routes for bots and external LLM connectors:

- **Bot and ephemeral LLM API**: REST and SSE endpoints for creating, observing, and continuing sessions, plus `list_external_llm_recipients` and `send_to_external_llm`. See [`docs/bot-client-api.md`](../bot-client-api.md).
- **Credential-bound external MCP ingress**: when `MCP_EXTERNAL_INGRESS_ENABLED=true`, external connectors connect to the orchestrator's dedicated MCP ingress route, which owns tool filtering, event subscriptions, and outbound webhook delivery. See [`docs/external-llm-ingress-rollout.md`](../external-llm-ingress-rollout.md) and [`docs/dot-mcp-events.md`](../dot-mcp-events.md).

## Attachments

Users and agents can exchange files within sessions (`register_attachment`, `attach_session_output`, `resolve_attachment`). Both `unified-dashboard` (`SessionAttachmentFields`) and `soul-app` (`MessageAttachments`, `AttachmentViewerModal`) support inline and modal previews for images, Markdown, HTML, video, and audio attachments.

## Session statistics and usage

Soulstream tracks two distinct usage layers:

- **Session token and cost statistics**: `list_turn_usage` and `summarize_turn_usage` (and the dashboard's `UsageStatsTab` via `/api/usage/...` statistics routes) aggregate per-turn input tokens, cached tokens, output tokens, and list-price cost estimates across sessions, agents, and models.
- **Provider quota headroom**: `orch-server-ts` polls connected nodes (`provider_usage_get`) at `USAGE_SUMMARY_POLL_INTERVAL_SECONDS` and serves `GET /api/usage/summary` to display Claude, Codex, and Antigravity weekly quota percentages and reset times in the settings view, persistent assistant session, and iOS widget.
