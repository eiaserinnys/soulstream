import {
  temporaryBlock,
  type EditorBlockSnapshot,
  type EditorOperation,
  type EditorOperationPlan,
} from "@soulstream/page-editor-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";

import { PageApiError, type PageApiClient, type PageDocumentBlock } from "../page";
import {
  executePageEditorOperation,
  executePageEditorPlan,
  type PageEditorOperationResult,
  type ResolvedEditorFocus,
} from "./page-editor-command-adapter";

export type PageEditorMutationState =
  | { readonly status: "idle" }
  | { readonly status: "pending" | "resyncing"; readonly message: string }
  | { readonly status: "error" | "conflict"; readonly message: string };

export interface PageEditorController {
  readonly state: PageEditorMutationState;
  readonly pendingFocus: ResolvedEditorFocus | null;
  run(operation: EditorOperation): Promise<void>;
  createFirstBlock(): Promise<void>;
  queueFocus(focus: ResolvedEditorFocus | null): void;
  clearFocus(focus: ResolvedEditorFocus): void;
  dismissError(): void;
  resync(): void;
}

export function usePageEditorController({
  apiClient,
  pageId,
  doc,
  blocks,
  mutationVersion,
  onResync,
}: {
  apiClient: PageApiClient;
  pageId: string;
  doc: Y.Doc;
  blocks: readonly PageDocumentBlock[];
  mutationVersion: number;
  onResync(): void;
}): PageEditorController {
  const [state, setState] = useState<PageEditorMutationState>({ status: "idle" });
  const [pendingFocus, setPendingFocus] = useState<ResolvedEditorFocus | null>(null);
  const running = useRef(false);
  const awaitingVersion = useRef<number | null>(null);
  const latest = useRef({ doc, blocks, mutationVersion });
  latest.current = { doc, blocks, mutationVersion };
  const snapshots = useMemo(() => toEditorSnapshots(pageId, blocks), [blocks, pageId]);
  const snapshotRef = useRef(snapshots);
  snapshotRef.current = snapshots;

  useEffect(() => {
    setState({ status: "idle" });
    setPendingFocus(null);
    running.current = false;
    awaitingVersion.current = null;
  }, [doc, pageId]);

  useEffect(() => {
    if (awaitingVersion.current === null || mutationVersion < awaitingVersion.current) return;
    awaitingVersion.current = null;
    setState({ status: "idle" });
  }, [mutationVersion]);

  const execute = useCallback(async (
    task: (context: typeof latest.current, idempotencyKey: string) => Promise<PageEditorOperationResult>,
  ) => {
    if (running.current || awaitingVersion.current !== null) return;
    running.current = true;
    setState({ status: "pending", message: "Saving structure…" });
    try {
      const result = await task(latest.current, pageEditorIdempotencyKey(pageId));
      setPendingFocus(result.focus);
      if (result.mutationVersion > latest.current.mutationVersion) {
        awaitingVersion.current = result.mutationVersion;
        setState({ status: "pending", message: "Waiting for page sync…" });
      } else {
        setState({ status: "idle" });
      }
    } catch (error) {
      if (error instanceof PageApiError && error.kind === "conflict") {
        setState({
          status: "conflict",
          message: "This page changed elsewhere. Reload the latest page before repeating the command.",
        });
      } else {
        setState({
          status: "error",
          message: error instanceof Error && error.message ? error.message : "The page structure could not be changed.",
        });
      }
    } finally {
      running.current = false;
    }
  }, [pageId]);

  const run = useCallback(async (operation: EditorOperation) => {
    await execute((context, idempotencyKey) => executePageEditorOperation({
      apiClient,
      pageId,
      doc: context.doc,
      mutationVersion: context.mutationVersion,
      blocks: snapshotRef.current,
      operation,
      idempotencyKey,
    }));
  }, [apiClient, execute, pageId]);

  const createFirstBlock = useCallback(async () => {
    const tempId = `first-${crypto.randomUUID()}`;
    const plan: EditorOperationPlan = {
      intents: [{
        type: "create-block",
        tempId,
        parent: null,
        after: null,
        blockType: "paragraph",
        text: "",
        properties: {},
        collapsed: false,
      }],
      focus: { target: temporaryBlock(tempId), selection: { anchor: 0, focus: 0 } },
    };
    await execute((context, idempotencyKey) => executePageEditorPlan({
      apiClient,
      pageId,
      doc: context.doc,
      mutationVersion: context.mutationVersion,
      plan,
      idempotencyKey,
    }));
  }, [apiClient, execute, pageId]);

  return {
    state,
    pendingFocus,
    run,
    createFirstBlock,
    queueFocus: setPendingFocus,
    clearFocus(focus) {
      setPendingFocus((current) => current === focus ? null : current);
    },
    dismissError() { setState({ status: "idle" }); },
    resync() {
      setState({ status: "resyncing", message: "Reloading the latest page…" });
      onResync();
    },
  };
}

export function toEditorSnapshots(
  pageId: string,
  blocks: readonly PageDocumentBlock[],
): readonly EditorBlockSnapshot[] {
  return blocks.map((block) => ({
    id: block.id,
    pageId,
    parentId: block.parentId,
    positionKey: block.positionKey,
    collapsed: block.collapsed,
    type: block.type,
    text: block.textValue,
  }));
}

function pageEditorIdempotencyKey(pageId: string): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Page editor mutation requires crypto.randomUUID");
  }
  return `page-editor:${pageId}:${globalThis.crypto.randomUUID()}`;
}
