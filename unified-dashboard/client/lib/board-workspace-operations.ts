import { createBoardWorkspaceOperations } from "@seosoyoung/soul-ui";

export const {
  updateBoardItemPosition,
  createMarkdownDocument,
  uploadBoardAsset,
} = createBoardWorkspaceOperations({
  updateBoardItemPositionUrl: (id) => `/api/board-items/${id}/position`,
  createMarkdownDocumentUrl: "/api/markdown-documents",
  initBoardAssetUrl: (folderId) => `/api/board/${encodeURIComponent(folderId)}/assets/init`,
  commitBoardAssetUrl: (folderId, assetId) =>
    `/api/board/${encodeURIComponent(folderId)}/assets/${encodeURIComponent(assetId)}/commit`,
});
