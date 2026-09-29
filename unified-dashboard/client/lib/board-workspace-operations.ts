import { createBoardWorkspaceOperations } from "@seosoyoung/soul-ui";

export const {
  updateBoardItemPosition,
  moveBoardItemToFolder,
  createMarkdownDocument,
  uploadBoardAsset,
} = createBoardWorkspaceOperations({
  updateBoardItemPositionUrl: (id) => `/api/board-items/${encodeURIComponent(id)}/position`,
  moveBoardItemToFolderUrl: (id) => `/api/board-items/${encodeURIComponent(id)}/folder`,
  createMarkdownDocumentUrl: "/api/markdown-documents",
  initBoardAssetUrl: (folderId) => `/api/board/${encodeURIComponent(folderId)}/assets/init`,
  commitBoardAssetUrl: (folderId, assetId) => `/api/board/${encodeURIComponent(folderId)}/assets/${encodeURIComponent(assetId)}/commit`,
});
