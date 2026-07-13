import type { StructuredClipboardCutSource } from "@soulstream/page-editor-core";
import { useCallback } from "react";
import * as Y from "yjs";

import type { PageApiClient, PageDocumentBlock, TransferPageBlocksInput } from "../page";

export function usePageBlockTransfers({
  apiClient,
  pageId,
  doc,
  mutationVersion,
  blocks,
  transfer,
  reportFailure,
  onOpenPage,
}: {
  apiClient: PageApiClient;
  pageId: string;
  doc: Y.Doc;
  mutationVersion: number;
  blocks: readonly PageDocumentBlock[];
  transfer(input: TransferPageBlocksInput): Promise<{ target: { page: { id: string } } } | null>;
  reportFailure(message: string): void;
  onOpenPage?(pageId: string): void;
}) {
  const execute = useCallback(async (input: TransferPageBlocksInput) => {
    const result = await transfer(input);
    return result !== null;
  }, [transfer]);

  return {
    pasteCut: async (cut: StructuredClipboardCutSource, target: PageDocumentBlock) => {
      let sourceStateVector: Uint8Array;
      try {
        sourceStateVector = decodeBase64(cut.expectedStateVector);
      } catch {
        reportFailure("The cut clipboard metadata is invalid. Nothing was changed.");
        return false;
      }
      return await execute({
        source: {
          pageId: cut.sourcePageId,
          expectedVersion: cut.expectedVersion,
          expectedStateVector: sourceStateVector,
          blockIds: cut.blockIds,
        },
        target: {
          kind: "existing",
          pageId,
          expectedVersion: mutationVersion,
          expectedStateVector: Y.encodeStateVector(doc),
          parentId: target.parentId,
          afterBlockId: target.id,
        },
        idempotencyKey: cut.idempotencyKey,
        reason: "page-editor-cut-paste",
      });
    },
    extractNew: async (selectedBlockIds: readonly string[], title: string) => {
      const targetPageId = crypto.randomUUID();
      const result = await transfer({
        source: currentSource(pageId, mutationVersion, doc, selectedBlockIds),
        target: { kind: "new", pageId: targetPageId, title },
        sourceMount: { title, tempId: `extract-mount-${crypto.randomUUID()}` },
        idempotencyKey: `page-extract:${pageId}:${crypto.randomUUID()}`,
        reason: "page-editor-extract-new",
      });
      if (result) onOpenPage?.(result.target.page.id);
      return result !== null;
    },
    extractExisting: async (selectedBlockIds: readonly string[], targetPageId: string) => {
      let target;
      let targetStateVector: Uint8Array;
      try {
        target = await apiClient.getPage(targetPageId);
        targetStateVector = decodeBase64(target.state_vector);
      } catch (error) {
        const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
        reportFailure(`The target page could not be loaded${detail}. Nothing was changed.`);
        return false;
      }
      const lastRoot = [...target.blocks].reverse().find((block) => block.parent_id === null);
      const freshTitle = target.page.title;
      const result = await transfer({
        source: currentSource(pageId, mutationVersion, doc, selectedBlockIds),
        target: {
          kind: "existing",
          pageId: targetPageId,
          expectedVersion: target.page.version,
          expectedStateVector: targetStateVector,
          parentId: null,
          afterBlockId: lastRoot?.id ?? null,
        },
        sourceMount: { title: freshTitle, tempId: `extract-mount-${crypto.randomUUID()}` },
        idempotencyKey: `page-extract:${pageId}:${crypto.randomUUID()}`,
        reason: "page-editor-extract-existing",
      });
      if (result) onOpenPage?.(result.target.page.id);
      return result !== null;
    },
    defaultTitle(selectedBlockIds: readonly string[]) {
      const first = selectedBlockIds.map((id) => blocks.find((block) => block.id === id)?.textValue.trim())
        .find((text) => text);
      return first?.slice(0, 80) || "Untitled page";
    },
  };
}

function currentSource(
  pageId: string,
  expectedVersion: number,
  doc: Y.Doc,
  blockIds: readonly string[],
) {
  return { pageId, expectedVersion, expectedStateVector: Y.encodeStateVector(doc), blockIds };
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
