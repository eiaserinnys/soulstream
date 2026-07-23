import type { CatalogBoardItem, CatalogFolder, FolderSettings, MarkdownDocument, SessionSummary } from "../shared/types";
import type { LoadMoreCallback } from "../components/load-more-guard";
import type {
  BoardAssetCommitResponse,
  MoveBoardItemToContainerInput,
  MoveBoardItemToContainerResponse,
  UploadBoardAssetInput,
} from "../lib/board-workspace-operations";
import type { FolderWorkspaceViewMode } from "./folder-workspace-view-mode";

export interface CreateMarkdownDocumentInput {
  folderId: string;
  title: string;
  body: string;
  x: number;
  y: number;
}

export interface CreateMarkdownDocumentResult {
  document: MarkdownDocument;
  boardItem: CatalogBoardItem;
}

export interface BoardWorkspaceViewProps {
  sessions?: SessionSummary[];
  taskMoveTargets?: ReadonlyArray<{ id: string; title: string }>;
  onMoveSessions?: (sessionIds: string[], targetFolderId: string | null) => Promise<void>;
  onRenameSession?: (sessionId: string, displayName: string | null) => Promise<void>;
  onDeleteSessions?: (sessionIds: string[]) => Promise<void>;
  onContinueSession?: (sessionId: string) => Promise<void>;
  getContinueSessionDisabledReason?: (sessionId: string) => string | null;
  onCreateFolder?: (name: string, parentFolderId: string | null) => Promise<CatalogFolder | void> | CatalogFolder | void;
  onRenameFolder?: (folderId: string, name: string) => Promise<void> | void;
  onDeleteFolder?: (folderId: string) => Promise<void> | void;
  onUpdateFolderSettings?: (folderId: string, settings: FolderSettings) => Promise<void> | void;
  onUpdateBoardItemPosition?: (boardItemId: string, x: number, y: number) => Promise<void> | void;
  onMoveBoardItemToContainer?: (
    input: MoveBoardItemToContainerInput,
  ) => Promise<MoveBoardItemToContainerResponse>;
  onBoardItemMoved?: (boardItem: CatalogBoardItem) => void;
  onMarkdownDocumentDeleted?: (documentId: string, boardItemId: string) => void;
  onOpenMarkdownDocument?: (documentId: string) => void;
  onOpenCustomView?: (customViewId: string) => void;
  onCreateMarkdownDocument?: (input: CreateMarkdownDocumentInput) => Promise<CreateMarkdownDocumentResult>;
  onUploadBoardAsset?: (input: UploadBoardAssetInput) => Promise<BoardAssetCommitResponse>;
  onLoadMore?: LoadMoreCallback;
  hasMore?: boolean;
  workspaceViewMode?: FolderWorkspaceViewMode;
  onWorkspaceViewModeChange?: (mode: FolderWorkspaceViewMode) => void;
}
