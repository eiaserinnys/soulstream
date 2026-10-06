import { ownedAgentRouteAuthRequirements } from "../owned-agents/routes.js";
import { mcpHostRouteAuthRequirements } from "../mcp/mcp_host_routes.js";
import { cardOrchestrationRouteAuthRequirements } from "../cards/card_orchestration_routes.js";
import { cardOrchestrationDecisionRouteAuthRequirements } from "../cards/card_orchestration_decision_routes.js";
import { r2SettingsRouteAuthRequirements } from "../admin/r2_settings_routes.js";
import { adminUsersRouteAuthRequirements } from "../admin/admin_users_routes.js";
import { cardDispatchSettingsRouteAuthRequirements } from "../cards/card_dispatch_settings_routes.js";
import { atomRouteAuthRequirements } from "../atom/atom_routes.js";
import { attachmentRouteAuthRequirements } from "../attachments/attachment_routes.js";
import { authRouteAuthRequirements } from "../auth/auth_routes.js";
import { boardAssetRouteAuthRequirements } from "../board/board_asset_routes.js";
import { boardItemRouteAuthRequirements } from "../board/board_item_routes.js";
import { boardYjsHostProxyRouteAuthRequirements } from "../board/board_yjs_host_proxy.js";
import { boardYjsRouteAuthRequirements } from "../board-yjs/board_yjs_route.js";
import { markdownDocumentRouteAuthRequirements } from "../board/markdown_document_routes.js";
import { cogitoRouteAuthRequirements } from "../cogito/cogito_routes.js";
import { executeProxyRouteAuthRequirements } from "../execute/execute_proxy_routes.js";
import { ephemeralLlmRouteAuthRequirements } from "../llm/ephemeral_llm_routes.js";
import { folderRouteAuthRequirements } from "../folders/folder_routes.js";
import { nodeAgentProfileRouteAuthRequirements } from "../node/node_agent_profile_routes.js";
import { nodeClaudeAuthRouteAuthRequirements } from "../node/node_claude_auth_routes.js";
import { nodeSnapshotRouteAuthRequirements } from "../node/node_snapshot_routes.js";
import { nodeWsRouteAuthRequirements } from "../node/ws_route.js";
import { publicStatusRouteAuthRequirements } from "../public/public_status_routes.js";
import { pushRouteAuthRequirements } from "../push/push_routes.js";
import { sessionActionCommandRouteAuthRequirements } from "../session/session_action_command_routes.js";
import { sessionBackgroundScheduleRouteAuthRequirements } from "../session/session_background_schedule_routes.js";
import { sessionResumeAfterLimitRouteAuthRequirements } from "../session/session_resume_after_limit_routes.js";
import { sessionCatalogRouteAuthRequirements } from "../session/session_catalog_routes.js";
import { persistentSessionSettingsRouteAuthRequirements } from "../session/persistent_session_settings_routes.js";
import { sessionCommandRouteAuthRequirements } from "../session/session_command_routes.js";
import { sessionHistoryRouteAuthRequirements } from "../session/session_history_routes.js";
import { sessionSnapshotRouteAuthRequirements } from "../session/session_snapshot_routes.js";
import { sseReplayRouteAuthRequirements } from "../sse/sse_replay_routes.js";
import { systemConfigRouteAuthRequirements } from "../system/system_config_routes.js";
import { userBackgroundRouteAuthRequirements } from "../user/user_background_routes.js";
import { userPreferencesRouteAuthRequirements } from "../user/user_preferences_routes.js";
import { usageSummaryRouteAuthRequirements } from "../usage/usage_summary_routes.js";
import { uiEventRouteAuthRequirements } from "../ui-events/ui_event_routes.js";
import { pageYjsRouteAuthRequirements } from "../page/page_yjs_route.js";
import { pageBrowserRouteAuthRequirements } from "../page/page_browser_routes.js";
import { plannerRouteAuthRequirements } from "../planner/planner_routes.js";
import { agentProfileRouteAuthRequirements } from "../node/agent_profile_routes.js";
import { contextBundleRouteAuthRequirements } from "../node/context_bundle_routes.js";
import { recurringJobRouteAuthRequirements } from "../recurring-jobs/recurring_job_routes.js";
import { persistentContextRouteAuthRequirements } from "../persistent-context/persistent_context_host_routes.js";
import type { RouteCoverageOwner } from "./route_coverage.js";

export const routeCoverageOwners = [
  { owner: "owned.agents", authRequirements: ownedAgentRouteAuthRequirements },
  { owner: "mcp.host", authRequirements: mcpHostRouteAuthRequirements },
  {owner:"cards.settings",authRequirements:cardDispatchSettingsRouteAuthRequirements},
  {owner:"cards.orchestration",authRequirements:{...cardOrchestrationRouteAuthRequirements,...cardOrchestrationDecisionRouteAuthRequirements}},
  { owner: "admin.users", authRequirements: { ...adminUsersRouteAuthRequirements, ...r2SettingsRouteAuthRequirements } },
  { owner: "atom", authRequirements: atomRouteAuthRequirements },
  { owner: "attachments", authRequirements: attachmentRouteAuthRequirements },
  { owner: "auth", authRequirements: authRouteAuthRequirements },
  { owner: "board.assets", authRequirements: boardAssetRouteAuthRequirements },
  { owner: "board.items", authRequirements: boardItemRouteAuthRequirements },
  { owner: "board.yjs-host", authRequirements: boardYjsHostProxyRouteAuthRequirements },
  { owner: "board.yjs", authRequirements: boardYjsRouteAuthRequirements },
  { owner: "cogito", authRequirements: cogitoRouteAuthRequirements },
  { owner: "execute", authRequirements: executeProxyRouteAuthRequirements },
  { owner: "llm.ephemeral", authRequirements: ephemeralLlmRouteAuthRequirements },
  { owner: "folders", authRequirements: folderRouteAuthRequirements },
  { owner: "markdown.documents", authRequirements: markdownDocumentRouteAuthRequirements },
  { owner: "page.yjs", authRequirements: pageYjsRouteAuthRequirements },
  { owner: "page.browser", authRequirements: pageBrowserRouteAuthRequirements },
  { owner: "planner", authRequirements: plannerRouteAuthRequirements },
  { owner: "agent.profiles", authRequirements: agentProfileRouteAuthRequirements },
  { owner: "context.bundles", authRequirements: contextBundleRouteAuthRequirements },
  { owner: "node.agent-profiles", authRequirements: nodeAgentProfileRouteAuthRequirements },
  { owner: "node.claude-auth", authRequirements: nodeClaudeAuthRouteAuthRequirements },
  { owner: "node.snapshot", authRequirements: nodeSnapshotRouteAuthRequirements },
  { owner: "node.ws", authRequirements: nodeWsRouteAuthRequirements },
  { owner: "public.status", authRequirements: publicStatusRouteAuthRequirements },
  { owner: "push", authRequirements: pushRouteAuthRequirements },
  { owner: "session.actions", authRequirements: sessionActionCommandRouteAuthRequirements },
  {
    owner: "session.background-schedule",
    authRequirements: sessionBackgroundScheduleRouteAuthRequirements,
  },
  {
    owner: "session.resume-after-limit",
    authRequirements: sessionResumeAfterLimitRouteAuthRequirements,
  },
  { owner: "session.catalog", authRequirements: sessionCatalogRouteAuthRequirements },
  { owner: "session.command", authRequirements: sessionCommandRouteAuthRequirements },
  { owner: "session.persistent-settings", authRequirements: persistentSessionSettingsRouteAuthRequirements },
  { owner: "session.history", authRequirements: sessionHistoryRouteAuthRequirements },
  { owner: "session.snapshot", authRequirements: sessionSnapshotRouteAuthRequirements },
  { owner: "sse.replay", authRequirements: sseReplayRouteAuthRequirements },
  { owner: "system.config", authRequirements: systemConfigRouteAuthRequirements },
  { owner: "user.background", authRequirements: userBackgroundRouteAuthRequirements },
  { owner: "user.preferences", authRequirements: userPreferencesRouteAuthRequirements },
  { owner: "usage.summary", authRequirements: usageSummaryRouteAuthRequirements },
  { owner: "ui.events", authRequirements: uiEventRouteAuthRequirements },
  { owner: "recurring.jobs", authRequirements: recurringJobRouteAuthRequirements },
  { owner: "persistent.context", authRequirements: persistentContextRouteAuthRequirements },
] as const satisfies readonly RouteCoverageOwner[];

// The route inventory fixture describes the retired Python server. New TS-only
// routes must be listed explicitly instead of being backfilled into that fixture.
export const tsOnlyRouteKeys = [
  "GET /api/owned-agents", "POST /api/owned-agents", "PATCH /api/owned-agents/{id}",
  "POST /api/owned-agents/{id}/keys", "DELETE /api/owned-agents/{id}/keys/{keyId}", "POST /api/owned-agents/register-existing",
  "POST /api/mcp/host/{tool}",
  "POST /api/persistent-context/host/evaluate",
  "POST /api/attachments/sessions/multipart/init",
  "POST /api/attachments/sessions/multipart/complete",
  "POST /api/attachments/sessions/multipart/abort",
  "POST /api/cards/{id}/start-work",
  "POST /api/cards/{id}/execute",
  "POST /api/cards/{id}/items/{itemId}/confirm",
  "GET /api/cards/{id}/execution",
  "POST /api/cards/{id}/execution-settings",
  "GET /api/settings/card-orchestration",
  "PUT /api/settings/card-orchestration",
  "POST /api/card-orchestration/host/{operation}",
  "POST /api/card-orchestration/decision/authorize",
  "POST /api/card-orchestration/worker/authorize",
  "WEBSOCKET /ws/node/control",
  "WEBSOCKET /yjs/{folderId}",
  "GET /api/nodes/{node_id}/model-presets",
  "GET /api/admin/settings/session-review-policy",
  "GET /api/admin/settings/board-r2",
  "PUT /api/admin/settings/board-r2",
  "POST /api/admin/settings/board-r2/check",
  "GET /api/admin/settings/attachment-r2",
  "PUT /api/admin/settings/attachment-r2",
  "POST /api/admin/settings/attachment-r2/check",

  "PUT /api/admin/settings/session-review-policy",
  "GET /api/sessions/{session_id}/conversation-context",
  "GET /api/sessions/{session_id}/resume-after-limit",
  "POST /api/sessions/{session_id}/resume-after-limit",
  "POST /api/ui-events",
  "GET /api/ui-events",
  "GET /api/ui-events/config",
  "GET /api/ui-events/installs",
  "GET /api/context-bundles",
  "DELETE /api/context-bundles/{bundle_id}",
  "GET /api/context-bundles/{bundle_id}",
  "PUT /api/context-bundles/{bundle_id}",
  "GET /api/recurring-jobs",
  "POST /api/recurring-jobs",
  "POST /api/recurring-jobs/preview",
  "GET /api/recurring-jobs/{job_id}",
  "PATCH /api/recurring-jobs/{job_id}",
  "POST /api/recurring-jobs/{job_id}/run",
  "POST /api/recurring-jobs/{job_id}/archive",
  "GET /api/recurring-jobs/{job_id}/runs",
  "PATCH /api/planner/starred-folders/order",
  "GET /api/persistent-sessions",
  "GET /api/persistent-sessions/{session_id}",
  "PUT /api/persistent-sessions/{session_id}",
  "POST /api/persistent-sessions",
  "GET /api/persistent-sessions/{session_id}/instructions",
  "POST /api/persistent-sessions/{session_id}/instructions",
  "PUT /api/persistent-sessions/{session_id}/instructions/{instruction_id}",
] as const;
