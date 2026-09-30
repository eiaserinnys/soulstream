/**
 * @seosoyoung/soul-ui - Stores Barrel
 */

// === Dashboard Store ===
export {
  useDashboardStore,
  isSessionUnread,
} from "./dashboard-store";
export { useFolderCardStore } from "./folder-card-store";
export { useCustomViewStore } from "./custom-view-store";
export type {
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
export { placeInTree, handleTextStart } from "./tree-placer";

// === Session Updater ===
export { shouldNotify } from "./session-updater";

// === Task Reads ===
export { fetchFolderSnapshot } from "./folder-card-store";
