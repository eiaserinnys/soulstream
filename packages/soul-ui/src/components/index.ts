/**
 * @seosoyoung/soul-ui - Components Barrel
 */

// === Layout Components ===
export { DashboardShell } from "./DashboardShell";
export type { DashboardShellProps } from "./DashboardShell";
export type { DashboardMobileTab } from "./BottomTabBar";
export { DragHandle } from "./DragHandle";
export type { DragHandleProps } from "./DragHandle";
export { ConnectionBadge } from "./ConnectionBadge";
export type { ConnectionBadgeProps, ConnectionStatus } from "./ConnectionBadge";

// === Folder / Feed / Session Views ===
export { FolderTree } from "./FolderTree";
export type { FolderTreeProps } from "./FolderTree";
export {
  getFolderTreeExpandedStorageKey,
  readFolderTreeExpandedState,
  writeFolderTreeExpandedState,
} from "./folder-tree-expansion";
export { FolderContents, nodeIdToHue, STATUS_CONFIG } from "./FolderContents";
export type { FolderContentsProps, StatusConfig } from "./FolderContents";
export { FeedCard } from "./FeedCard";
export type { FeedCardProps } from "./FeedCard";
export { NodeBadge } from "./NodeBadge";
export type { NodeBadgeProps } from "./NodeBadge";
export { FeedView } from "./FeedView";
export { FeedTopBar } from "./FeedTopBar";
export type { FeedTopBarProps } from "./FeedTopBar";
export { FolderDialog } from "./FolderDialog";
export { FolderSettingsDialog } from "./FolderSettingsDialog";
export type { FolderSettingsDialogProps } from "./FolderSettingsDialog";
export { ChatInput } from "./ChatInput";
export { RightPanel } from "./RightPanel";
export { MarkdownDocumentPanel } from "./MarkdownDocumentPanel";
export { MarkdownDeleteDialog } from "./MarkdownDeleteDialog";
export type { MarkdownDeleteDialogProps } from "./MarkdownDeleteDialog";
export { MarkdownContent } from "./MarkdownContent";
export { SessionContextMenu } from "./SessionContextMenu";
export type {
  SessionContextMenuExtraAction,
  SessionContextMenuProps,
  SessionContextMenuState,
} from "./SessionContextMenu";
export { CustomViewIframe } from "../custom-view/CustomViewRenderer";
export type {
  CustomViewBindingData,
  CustomViewBindingRecord,
} from "../custom-view/CustomViewRenderer";
export { useCustomViewBindings } from "../custom-view/use-custom-view-bindings";
export { BoardAssetCard } from "./BoardAssetCard";
export type { BoardAssetCardProps } from "./BoardAssetCard";
export { DetailView } from "./DetailView";
export { SessionInfoView } from "./SessionInfoView";
export { AskQuestionBanner } from "./AskQuestionBanner";
export { ProfileAvatar } from "./ProfileAvatar";
export { ContextContentRenderer } from "./ContextContentRenderer";
export { WallpaperLayer } from "./WallpaperLayer";
export { LiquidGlassCanvas, LiquidGlassProvider, useGlassSurface } from "./LiquidGlassProvider";
export { AtomNodeSelector } from "./AtomNodeSelector";
export type { AtomNodeSelectorProps } from "./AtomNodeSelector";

// === Dashboard Components (extracted from soul-dashboard) ===
export { SessionsTopBar } from "./SessionsTopBar";
export { VerticalSplitPane } from "./VerticalSplitPane";
export { MobileChatHeader } from "./MobileChatHeader";
export { ThemeToggle } from "./ThemeToggle";
export { DashboardIconCap } from "./DashboardIconCap";
export type { DashboardIconCapProps } from "./DashboardIconCap";
export { DisclosureActionIcon } from "./DisclosureActionIcon";
export type { DisclosureActionIconProps } from "./DisclosureActionIcon";
export { ConfigButton } from "./ConfigButton";
export { NewSessionDialog } from "./NewSessionDialog";
export type { NewSessionDialogProps } from "./NewSessionDialog";
export { NewSessionFolderSelector } from "./NewSessionFolderSelector";
export type { NewSessionFolderSelectorProps } from "./NewSessionFolderSelector";
export { FileAttachmentPreview } from "./FileAttachmentPreview";
export type { FileAttachmentPreviewProps } from "./FileAttachmentPreview";

// === Sub-barrels ===
export * from "./chat";
export * from "./detail";
export * from "./auth";
export * from "./ui";
