export { useTheme, useAppearancePreference, initTheme, setTheme, setAppearancePreference } from "./useTheme";
export type { Theme } from "./useTheme";
export { useUserPreferencesSync } from "./useUserPreferencesSync";
export { useAgentPortraitSync } from "./useAgentPortraitSync";

export { ChatAttachmentLoaderProvider, useChatAttachmentLoader } from "./ChatAttachmentLoader";
export type { ChatAttachmentLoader, ChatAttachmentLoaderInput } from "./ChatAttachmentLoader";
export type { ChatAttachmentItem } from "../lib/chat-attachment-model";

// === Input Request / Mobile ===
export { useInputRequestTimer } from "./useInputRequestTimer";
export { useIsMobile } from "./use-mobile";

// === Dashboard Hooks (extracted from soul-dashboard) ===
export { useFileUpload } from "./useFileUpload";
export type { UseFileUploadOptions, UseFileUploadReturn, UploadedFile } from "./useFileUpload";
export { useSessionListProvider } from "./useSessionListProvider";
export type { UseSessionListProviderOptions } from "./useSessionListProvider";
export { useInitialCatalogLoad } from "./useInitialCatalogLoad";
export { useSessionStreamSSE } from "./useSessionStreamSSE";
export type { UseSessionStreamSSEOptions } from "./useSessionStreamSSE";
export { useSessionProvider } from "./useSessionProvider";
export type { SessionProviderConnectionStatus, UseSessionProviderOptions } from "./useSessionProvider";
export { useReadPositionSync } from "./useReadPositionSync";
export { useNotification } from "./useNotification";
export { useAtomPublicUrl, parseAtomPublicUrl } from "./useAtomPublicUrl";
export { mergeSessionSummarySnapshot } from "./session-snapshot-helpers";
