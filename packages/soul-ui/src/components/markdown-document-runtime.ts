import { useEffect, useState } from "react";

import {
  getBoardYjsRuntime,
  getMarkdownPreview,
  subscribeBoardYjsRuntime,
  type BoardYjsRuntime,
} from "../board-workspace";
import type { BoardContainerRef } from "../shared/types";

export function useBoardRuntime(container: BoardContainerRef | null): BoardYjsRuntime | null {
  const [runtime, setRuntime] = useState(() => getBoardYjsRuntime(container));
  const [, setRuntimeRevision] = useState(0);
  useEffect(() => {
    setRuntime(getBoardYjsRuntime(container));
    return subscribeBoardYjsRuntime(() => {
      setRuntime(getBoardYjsRuntime(container));
    });
  }, [container]);
  useEffect(() => {
    if (!runtime) return;
    return runtime.subscribe(() => {
      setRuntimeRevision((revision) => revision + 1);
    });
  }, [runtime]);
  return runtime;
}

export function getMetadataText(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
}

export function getMetadataNumber(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function refreshRuntimeMarkdownPreview(
  runtime: BoardYjsRuntime,
  documentId: string,
  body: string,
) {
  const boardItemId = `markdown:${documentId}`;
  const item = runtime.getBoardItems().find((candidate) => candidate.id === boardItemId);
  if (!item) return;
  runtime.upsertBoardItem({
    ...item,
    metadata: {
      ...(item.metadata ?? {}),
      preview: getMarkdownPreview(body),
      version: (getMetadataNumber(item.metadata, "version") ?? 1) + 1,
    },
    updatedAt: new Date().toISOString(),
  });
}
