/**
 * @seosoyoung/soul-ui - Components Barrel
 */

// === Layout Components ===
export { DragHandle } from "./DragHandle";
export type { DragHandleProps } from "./DragHandle";

// === Folder / Feed / Session Views ===
export {
  getFolderTreeExpandedStorageKey,
  readFolderTreeExpandedState,
  writeFolderTreeExpandedState,
} from "./folder-tree-expansion";
export { nodeIdToHue } from "../lib/nodeColors";
export { NodeBadge } from "./NodeBadge";
export type { NodeBadgeProps } from "./NodeBadge";
export { FolderDialog } from "./FolderDialog";
export { FolderSettingsDialog } from "./FolderSettingsDialog";
export type { FolderSettingsDialogProps } from "./FolderSettingsDialog";
export { ChatInput } from "./ChatInput";
export { CustomViewPanel } from "./CustomViewPanel";
export type { CustomViewPanelProps } from "./CustomViewPanel";
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
export { STATUS_CONFIG } from "./SessionItem";
export type { StatusConfig } from "./SessionItem";
export { CustomViewIframe } from "../custom-view/CustomViewRenderer";
export type {
  CustomViewBindingData,
  CustomViewBindingRecord,
} from "../custom-view/CustomViewRenderer";
export { useCustomViewBindings } from "../custom-view/use-custom-view-bindings";
export { BoardAssetCard } from "./BoardAssetCard";
export type { BoardAssetCardProps } from "./BoardAssetCard";
export { AskQuestionBanner } from "./AskQuestionBanner";
export { ProfileAvatar } from "./ProfileAvatar";
export { ContextContentRenderer } from "./ContextContentRenderer";
export { WallpaperLayer } from "./WallpaperLayer";
export { LiquidGlassCanvas, LiquidGlassProvider, useGlassSurface } from "./LiquidGlassProvider";
export { AtomNodeSelector } from "./AtomNodeSelector";
export type { AtomNodeSelectorProps } from "./AtomNodeSelector";

// === Dashboard Components ===
export { SessionModelPresetBadge } from "./SessionModelPresetBadge";
export { SessionStoryDisclosure } from "./SessionStoryDisclosure";
export { ThemeToggle } from "./ThemeToggle";
export { DashboardIconCap } from "./DashboardIconCap";
export type { DashboardIconCapProps } from "./DashboardIconCap";
export { DisclosureActionIcon } from "./DisclosureActionIcon";
export type { DisclosureActionIconProps } from "./DisclosureActionIcon";
export { ConfigButton } from "./ConfigButton";
export { NewSessionFolderSelector } from "./NewSessionFolderSelector";
export type { NewSessionFolderSelectorProps } from "./NewSessionFolderSelector";
export { FileAttachmentPreview } from "./FileAttachmentPreview";
export type { FileAttachmentPreviewProps } from "./FileAttachmentPreview";

// === Sub-barrels ===
export * from "./chat";
export * from "./auth";
export * from "./ui";
