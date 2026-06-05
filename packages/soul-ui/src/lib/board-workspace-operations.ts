import type { CatalogBoardItem, MarkdownDocument } from "../shared/types";

export interface BoardWorkspaceApiConfig {
  updateBoardItemPositionUrl: (id: string) => string;
  createMarkdownDocumentUrl: string;
}

export interface CreateMarkdownDocumentRequest {
  folderId: string;
  title: string;
  body: string;
  x: number;
  y: number;
}

export interface CreateMarkdownDocumentResponse {
  document: MarkdownDocument;
  boardItem: CatalogBoardItem;
}

export interface BoardWorkspaceOperations {
  updateBoardItemPosition: (boardItemId: string, x: number, y: number) => Promise<void>;
  createMarkdownDocument: (
    input: CreateMarkdownDocumentRequest,
  ) => Promise<CreateMarkdownDocumentResponse>;
}

export function createBoardWorkspaceOperations(
  config: BoardWorkspaceApiConfig,
): BoardWorkspaceOperations {
  async function updateBoardItemPosition(
    boardItemId: string,
    x: number,
    y: number,
  ): Promise<void> {
    const res = await fetch(config.updateBoardItemPositionUrl(boardItemId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x, y }),
    });
    if (!res.ok) {
      throw new Error(`Update board item position failed: ${res.status}`);
    }
  }

  async function createMarkdownDocument(
    input: CreateMarkdownDocumentRequest,
  ): Promise<CreateMarkdownDocumentResponse> {
    const res = await fetch(config.createMarkdownDocumentUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      throw new Error(`Create markdown document failed: ${res.status}`);
    }
    return await res.json() as CreateMarkdownDocumentResponse;
  }

  return { updateBoardItemPosition, createMarkdownDocument };
}
