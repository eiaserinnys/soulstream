import { createBoardWorkspaceOperations } from "@seosoyoung/soul-ui";

export const {
  updateBoardItemPosition,
  createMarkdownDocument,
} = createBoardWorkspaceOperations({
  updateBoardItemPositionUrl: (id) => `/api/board-items/${id}/position`,
  createMarkdownDocumentUrl: "/api/markdown-documents",
});
