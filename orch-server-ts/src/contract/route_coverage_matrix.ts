import { adminUsersRouteAuthRequirements } from "../admin/admin_users_routes.js";
import { atomRouteAuthRequirements } from "../atom/atom_routes.js";
import { attachmentRouteAuthRequirements } from "../attachments/attachment_routes.js";
import { authRouteAuthRequirements } from "../auth/auth_routes.js";
import { boardAssetRouteAuthRequirements } from "../board/board_asset_routes.js";
import { boardItemRouteAuthRequirements } from "../board/board_item_routes.js";
import { boardYjsHostProxyRouteAuthRequirements } from "../board/board_yjs_host_proxy.js";
import { markdownDocumentRouteAuthRequirements } from "../board/markdown_document_routes.js";
import { cogitoRouteAuthRequirements } from "../cogito/cogito_routes.js";
import { executeProxyRouteAuthRequirements } from "../execute/execute_proxy_routes.js";
import { folderRouteAuthRequirements } from "../folders/folder_routes.js";
import { nodeAgentProfileRouteAuthRequirements } from "../node/node_agent_profile_routes.js";
import { nodeClaudeAuthRouteAuthRequirements } from "../node/node_claude_auth_routes.js";
import { nodeSnapshotRouteAuthRequirements } from "../node/node_snapshot_routes.js";
import { nodeWsRouteAuthRequirements } from "../node/ws_route.js";
import { publicStatusRouteAuthRequirements } from "../public/public_status_routes.js";
import { pushRouteAuthRequirements } from "../push/push_routes.js";
import { taskRouteAuthRequirements } from "../tasks/task_route_types.js";
import { sessionActionCommandRouteAuthRequirements } from "../session/session_action_command_routes.js";
import { sessionBackgroundScheduleRouteAuthRequirements } from "../session/session_background_schedule_routes.js";
import { sessionCatalogRouteAuthRequirements } from "../session/session_catalog_routes.js";
import { sessionCommandRouteAuthRequirements } from "../session/session_command_routes.js";
import { sessionHistoryRouteAuthRequirements } from "../session/session_history_routes.js";
import { sessionSnapshotRouteAuthRequirements } from "../session/session_snapshot_routes.js";
import { sseReplayRouteAuthRequirements } from "../sse/sse_replay_routes.js";
import { systemConfigRouteAuthRequirements } from "../system/system_config_routes.js";
import { userBackgroundRouteAuthRequirements } from "../user/user_background_routes.js";
import { userPreferencesRouteAuthRequirements } from "../user/user_preferences_routes.js";
import { usageSummaryRouteAuthRequirements } from "../usage/usage_summary_routes.js";
import { pageYjsRouteAuthRequirements } from "../page/page_yjs_route.js";
import { pageBrowserRouteAuthRequirements } from "../page/page_browser_routes.js";
import { plannerRouteAuthRequirements } from "../planner/planner_routes.js";
import type { RouteCoverageOwner } from "./route_coverage.js";

export const routeCoverageOwners = [
  { owner: "admin.users", authRequirements: adminUsersRouteAuthRequirements },
  { owner: "atom", authRequirements: atomRouteAuthRequirements },
  { owner: "attachments", authRequirements: attachmentRouteAuthRequirements },
  { owner: "auth", authRequirements: authRouteAuthRequirements },
  { owner: "board.assets", authRequirements: boardAssetRouteAuthRequirements },
  { owner: "board.items", authRequirements: boardItemRouteAuthRequirements },
  { owner: "board.yjs-host", authRequirements: boardYjsHostProxyRouteAuthRequirements },
  { owner: "cogito", authRequirements: cogitoRouteAuthRequirements },
  { owner: "execute", authRequirements: executeProxyRouteAuthRequirements },
  { owner: "folders", authRequirements: folderRouteAuthRequirements },
  { owner: "markdown.documents", authRequirements: markdownDocumentRouteAuthRequirements },
  { owner: "page.yjs", authRequirements: pageYjsRouteAuthRequirements },
  { owner: "page.browser", authRequirements: pageBrowserRouteAuthRequirements },
  { owner: "planner", authRequirements: plannerRouteAuthRequirements },
  { owner: "node.agent-profiles", authRequirements: nodeAgentProfileRouteAuthRequirements },
  { owner: "node.claude-auth", authRequirements: nodeClaudeAuthRouteAuthRequirements },
  { owner: "node.snapshot", authRequirements: nodeSnapshotRouteAuthRequirements },
  { owner: "node.ws", authRequirements: nodeWsRouteAuthRequirements },
  { owner: "public.status", authRequirements: publicStatusRouteAuthRequirements },
  { owner: "push", authRequirements: pushRouteAuthRequirements },
  { owner: "tasks", authRequirements: taskRouteAuthRequirements },
  { owner: "session.actions", authRequirements: sessionActionCommandRouteAuthRequirements },
  {
    owner: "session.background-schedule",
    authRequirements: sessionBackgroundScheduleRouteAuthRequirements,
  },
  { owner: "session.catalog", authRequirements: sessionCatalogRouteAuthRequirements },
  { owner: "session.command", authRequirements: sessionCommandRouteAuthRequirements },
  { owner: "session.history", authRequirements: sessionHistoryRouteAuthRequirements },
  { owner: "session.snapshot", authRequirements: sessionSnapshotRouteAuthRequirements },
  { owner: "sse.replay", authRequirements: sseReplayRouteAuthRequirements },
  { owner: "system.config", authRequirements: systemConfigRouteAuthRequirements },
  { owner: "user.background", authRequirements: userBackgroundRouteAuthRequirements },
  { owner: "user.preferences", authRequirements: userPreferencesRouteAuthRequirements },
  { owner: "usage.summary", authRequirements: usageSummaryRouteAuthRequirements },
] as const satisfies readonly RouteCoverageOwner[];
