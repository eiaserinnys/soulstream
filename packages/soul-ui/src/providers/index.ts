/**
 * @seosoyoung/soul-ui - Providers Barrel
 */

// === Dashboard DnD Provider ===
export { DashboardDndProvider, pointerFirstCollisionDetection } from "./DashboardDndProvider";
export type { DashboardDndProviderProps } from "./DashboardDndProvider";
export {
  FolderSortableContext,
  useFolderDragActive,
  useFolderDragSurface,
  useFolderRootDropSurface,
} from "./FolderDragSurface";
export type { FolderDragData, FolderRootDropData } from "./folder-dnd";
export {
  StarredTaskSortableContext,
  reorderStarredTaskIds,
  useStarredTaskDragSurface,
} from "./starred-task-dnd";
export type { StarredTaskDragData } from "./starred-task-dnd";

// === SSE Subscribe Utility ===
export { createSSESubscribe } from "./sse-subscribe";
export type { SSESubscribeOptions } from "./sse-subscribe";
export {
  clearAllDetailCursorStores,
  createRegisteredDetailCursorStore,
  DetailCursorStore,
} from "./detail-cursor-store";
export type { DetailCursorStoreOptions } from "./detail-cursor-store";

// === Session List URL Utility ===
export { buildFetchSessionsUrl } from "./fetch-sessions-url";

// === Provider Types ===
export type {
  FetchSessionsOptions,
  SessionListResult,
  SessionListProvider,
  SessionDetailProvider,
  SessionStorageProvider,
  SessionKey,
} from "./types";

// === Auth ===
export { AuthProvider, useAuth } from "./AuthProvider";
export type { AuthContextValue, AuthUser, DashboardAccess } from "./AuthProvider";
