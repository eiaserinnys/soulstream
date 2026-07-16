import type { MarkdownDocument } from "../shared/types";

export interface RenameMarkdownDocumentInput {
  documentId: string;
  title: string;
  expectedVersion: number;
}

export async function renameMarkdownDocument(
  input: RenameMarkdownDocumentInput,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<MarkdownDocument> {
  const response = await fetchImplementation(
    `/api/markdown-documents/${encodeURIComponent(input.documentId)}`,
    {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: input.title,
        expectedVersion: input.expectedVersion,
      }),
    },
  );
  if (response.status === 409) {
    throw new Error("문서가 다른 곳에서 변경되었습니다. 다시 불러온 뒤 재시도하세요.");
  }
  if (!response.ok) {
    throw new Error(`마크다운 문서 이름을 바꾸지 못했습니다 (${response.status})`);
  }
  return await response.json() as MarkdownDocument;
}
