import { createBoardWorkspaceOperations } from "@seosoyoung/soul-ui";

export const {
  updateBoardItemPosition,
  createMarkdownDocument,
} = createBoardWorkspaceOperations({
  updateBoardItemPositionUrl: (id) => `/api/catalog/board-items/${id}/position`,
  createMarkdownDocumentUrl: "/api/catalog/markdown-documents",
});
