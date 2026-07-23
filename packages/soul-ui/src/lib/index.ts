/**
 * @seosoyoung/soul-ui - Lib Barrel
 */

// === Core Utilities ===
export { cn } from "./cn";
export { BATCH_SIZE, BATCH_FLUSH_MS } from "./event-batch";
export { flattenTree } from "./flatten-tree";
export type { ChatMessage } from "./flatten-tree";
export { submitInputResponse } from "./input-request-actions";
export { formatTime } from "./input-request-utils";
export { fetchWithProjectionRetry } from "./projection-retry";
export { retainEqualSet, retainEqualValue } from "./structural-sharing";
export { appendAttachmentPathNotes } from "./attachment-path-notes";

// === Folder / Session Operations ===
export { createFolderOperations } from "./folder-operations";
export type { FolderApiConfig, FolderOperations } from "./folder-operations";
export {
  buildFolderTreeOptions,
  compareFoldersByName,
  getFolderNameSortKey,
} from "./folder-tree-options";
export type { FolderTreeOption } from "./folder-tree-options";
export { createBoardWorkspaceOperations } from "./board-workspace-operations";
export type {
  BoardWorkspaceApiConfig,
  BoardWorkspaceOperations,
  BoardAssetCommitResponse,
  CreateMarkdownDocumentRequest,
  CreateMarkdownDocumentResponse,
  MoveBoardItemToContainerInput,
  MoveBoardItemToContainerResponse,
  UploadBoardAssetInput,
} from "./board-workspace-operations";
export {
  deleteMarkdownDocument,
  fetchMarkdownDocument,
  MarkdownDocumentConflictError,
  renameMarkdownDocument,
  updateMarkdownDocument,
} from "./markdown-document-operations";
export type {
  RenameMarkdownDocumentInput,
  UpdateMarkdownDocumentInput,
} from "./markdown-document-operations";
export { createMoveSessionsOperations } from "./move-sessions";
export type { MoveSessionsApiConfig, MoveSessionsOperations } from "./move-sessions";
export { shouldLoadMoreAfterSessionMove } from "./session-move-load-more";
export type { SessionMoveLoadMoreState } from "./session-move-load-more";
export { SessionReviewAcknowledgeError, acknowledgeSessionReview } from "./session-review";
export type {
  SessionReviewAcknowledgeErrorInput,
  SessionReviewAcknowledgeResult,
} from "./session-review";
export {
  applyLiquidLens,
  calculateLiquidLensMapSize,
  cleanupLiquidLens,
  encodeLiquidLensVector,
  isChromiumLensRuntime,
  isChromiumUserAgent,
  sampleLiquidLensVector,
  useLiquidLens,
} from "./liquid-lens";
export type { LiquidLensMapMetrics, LiquidLensMapSize, LiquidLensOptions } from "./liquid-lens";
export {
  clearWebglGlassOverride,
  MAX_WEBGL_GLASS_CARDS,
  WEBGL_GLASS_CHANGE_EVENT,
  WEBGL_GLASS_STORAGE_KEY,
  calculateBackingDpr,
  createGlassSurfaceBuffer,
  dispatchWebglGlassChange,
  isWebglGlassStorageValueEnabled,
  isWebglGlassStorageValueDisabled,
  packVisibleGlassSurfaces,
  readWebglGlassEnabled,
  readWebglGlassOverride,
  writeWebglGlassEnabled,
} from "./webgl-glass";
export type {
  GlassSurfaceRef,
  GlassSurfaceRegistration,
  GlassViewport,
  PackedGlassSurfaces,
  WebglGlassStats,
} from "./webgl-glass";
export {
  DEFAULT_LIQUID_GLASS_SETTINGS,
  LIQUID_GLASS_SETTING_LIMITS,
  normalizeLiquidGlassSettings,
} from "./glass-settings";
export type { LiquidGlassSettings } from "./glass-settings";
export {
  DEFAULT_USER_PREFERENCES,
  dataUrlToBlob,
  deleteUserBackground,
  fetchUserPreferences,
  normalizeUserPreferences,
  normalizeUserPreferencesResponse,
  readCachedUserPreferences,
  saveUserPreferences,
  uploadUserBackground,
  writeCachedUserPreferences,
} from "./user-preferences";
export type { UserPreferencesResponse, UserPreferencesSnapshot } from "./user-preferences";
export {
  CHAT_FONT_SIZE_STEPS,
  DEFAULT_CHAT_FONT_SIZE,
  normalizeChatFontSize,
  resolveChatTypography,
} from "./chat-typography";
export type { ChatFontSize } from "./chat-typography";
export {
  DEFAULT_WALLPAPER_PHOTO_URL,
  DEFAULT_WALLPAPER_SETTINGS,
  MAX_WALLPAPER_DATA_URL_BYTES,
  WALLPAPER_STORAGE_KEY,
  fileToWallpaperDataUrl,
  normalizeWallpaperSettings,
  readWallpaperSettings,
  writeWallpaperSettings,
} from "./wallpaper-settings";
export type { WallpaperMode, WallpaperSettings } from "./wallpaper-settings";

// === Rename Session ===
export { renameSessionOptimistic, createRenameSessionOperation } from "./rename-session";
export type { RenameSessionApiConfig, RenameSessionOperations } from "./rename-session";

// === Viewport API (Phase 3) ===
export { encodeCursor, decodeCursor } from "./cursor-codec";
