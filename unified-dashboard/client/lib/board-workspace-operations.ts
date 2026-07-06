import { createBoardWorkspaceOperations } from "@seosoyoung/soul-ui";

export const {
  updateBoardItemPosition,
  moveBoardItemToContainer,
  createMarkdownDocument,
  uploadBoardAsset,
} = createBoardWorkspaceOperations({
  updateBoardItemPositionUrl: (id) => `/api/board-items/${encodeURIComponent(id)}/position`,
  moveBoardItemToContainerUrl: (id) => `/api/board-items/${encodeURIComponent(id)}/container`,
  createMarkdownDocumentUrl: "/api/markdown-documents",
  initBoardAssetUrl: (target) => target.container.kind === "folder"
    ? `/api/board/${encodeURIComponent(target.folderId)}/assets/init`
    : `/api/board-containers/${encodeURIComponent(target.container.kind)}/${encodeURIComponent(target.container.id)}/assets/init`,
  commitBoardAssetUrl: (target, assetId) => target.container.kind === "folder"
    ? `/api/board/${encodeURIComponent(target.folderId)}/assets/${encodeURIComponent(assetId)}/commit`
    : `/api/board-containers/${encodeURIComponent(target.container.kind)}/${encodeURIComponent(target.container.id)}/assets/${encodeURIComponent(assetId)}/commit`,
});
