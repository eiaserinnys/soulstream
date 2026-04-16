/**
 * @seosoyoung/soul-ui - Stores Barrel
 */

// === Dashboard Store ===
export {
  useDashboardStore,
  isSessionUnread,
  countTreeNodes,
  countStreamingNodes,
  findTreeNode,
} from "./dashboard-store";
export type {
  ProfileConfig,
  DashboardConfig,
  DashboardAgentConfig,
  SelectedEventNodeData,
  DashboardState,
  DashboardActions,
  FolderSortMode,
} from "./dashboard-store";

// === Processing Context ===
export type { ProcessingContext, TextTargetNode } from "./processing-context";
export { createProcessingContext, makeNode, registerNode, ensureRoot } from "./processing-context";

// === Node Factory ===
export { createNodeFromEvent, applyUpdate } from "./node-factory";

// === Tree Placer ===
export { resolveParent, placeInTree, handleTextStart } from "./tree-placer";

// === Session Updater ===
export { shouldNotify, deriveSessionStatus } from "./session-updater";
