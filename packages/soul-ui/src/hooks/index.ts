/**
 * @seosoyoung/soul-ui - Hooks Barrel
 */

// === Theme ===
export { useTheme, useAppearancePreference, initTheme, setTheme, setAppearancePreference } from "./useTheme";
export type { Appearance, Theme } from "./useTheme";
export { useUserPreferencesSync } from "./useUserPreferencesSync";

// === Input Request / Mobile ===
export { useInputRequestTimer } from "./useInputRequestTimer";
export { useIsMobile } from "./use-mobile";

// === Dashboard Hooks (extracted from soul-dashboard) ===
export { useFileUpload } from "./useFileUpload";
export type { UseFileUploadOptions, UseFileUploadReturn, UploadedFile } from "./useFileUpload";
export { useSessionListProvider } from "./useSessionListProvider";
export type { UseSessionListProviderOptions } from "./useSessionListProvider";
export { useInitialCatalogLoad } from "./useInitialCatalogLoad";
export { useSessionProvider } from "./useSessionProvider";
export type { UseSessionProviderOptions } from "./useSessionProvider";
export { useReadPositionSync } from "./useReadPositionSync";
export { useNotification } from "./useNotification";
export { useUrlSync } from "./useUrlSync";
export { useDashboardConfig } from "./useDashboardConfig";
export { useServerStatus } from "./useServerStatus";
export { useFlipAnimation } from "./useFlipAnimation";
