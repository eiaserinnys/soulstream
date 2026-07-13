import {
  createSerialIntentQueue,
  EditorOperationUnavailableError,
  StaleEditorTargetError,
  temporaryBlock,
  existingBlock,
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
  type ResolvedEditorFocus,
} from "./page-editor-command-adapter";

export type PageEditorMutationState =
  | { readonly status: "idle" }
  | { readonly status: "pending" | "resyncing"; readonly message: string }
  | { readonly status: "error" | "conflict"; readonly message: string };

export interface PageEditorController {
  readonly state: PageEditorMutationState;
  readonly pendingFocus: ResolvedEditorFocus | null;
  readonly feedback: string | null;
  run(operation: EditorOperation, options?: { restoreFocus?: boolean }): Promise<void>;
  createFirstBlock(): Promise<void>;
  convertToSessionReference(blockId: string, sessionId: string): Promise<void>;
  noteLocalInput(): void;
  queueFocus(focus: ResolvedEditorFocus | null): void;
  clearFocus(focus: ResolvedEditorFocus): void;
  dismissError(): void;
  dismissFeedback(): void;
  reportFailure(message: string): void;
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
  const [feedback, setFeedback] = useState<string | null>(null);
  const awaitingVersion = useRef<number | null>(null);
  const deferredFocus = useRef<ResolvedEditorFocus | null>(null);
  const blocked = useRef(false);
  const pendingCommandCount = useRef(0);
  const localInputRevision = useRef(0);
  const latest = useRef({ doc, blocks, mutationVersion });
  latest.current = { doc, blocks, mutationVersion };
  const snapshots = useMemo(() => toEditorSnapshots(pageId, blocks), [blocks, pageId]);
  const snapshotRef = useRef(snapshots);
  snapshotRef.current = snapshots;

  type QueuedCommand =
    | { readonly kind: "operation"; readonly operation: EditorOperation; readonly restoreFocus: boolean; readonly focusRevision: number }
    | { readonly kind: "plan"; readonly plan: EditorOperationPlan; readonly restoreFocus: boolean; readonly focusRevision: number };

  const commandRuntime = useMemo(() => {
    let disposed = false;
    const queue = createSerialIntentQueue<QueuedCommand>({
      isReady: () => awaitingVersion.current === null && !blocked.current,
      shouldSuppress: shouldSuppressCommand,
      onPendingCountChange: (count) => { pendingCommandCount.current = count; },
      execute: async (command) => {
        setState({ status: "pending", message: "Saving structure…" });
        try {
          const context = latest.current;
          const idempotencyKey = pageEditorIdempotencyKey(pageId);
          const result = await retryTransientStructureSave(() => command.kind === "operation"
            ? executePageEditorOperation({
                apiClient,
                pageId,
                doc: context.doc,
                mutationVersion: context.mutationVersion,
                blocks: snapshotRef.current,
                operation: command.operation,
                idempotencyKey,
              })
            : executePageEditorPlan({
                apiClient,
                pageId,
                doc: context.doc,
                mutationVersion: context.mutationVersion,
                plan: command.plan,
                idempotencyKey,
              }));
          const focus = command.restoreFocus && command.focusRevision === localInputRevision.current
            ? result.focus
            : null;
          if (disposed) return "local-failure";
          if (result.mutationVersion > latest.current.mutationVersion) {
            deferredFocus.current = focus;
            awaitingVersion.current = result.mutationVersion;
            setState({ status: "pending", message: "Waiting for page sync…" });
          } else {
            setPendingFocus(focus);
            setState({ status: "idle" });
          }
          return "executed";
        } catch (error) {
          if (disposed) return "local-failure";
          if (error instanceof PageApiError && error.kind === "conflict") {
            blocked.current = true;
            setState({
              status: "conflict",
              message: "This page changed elsewhere. Reload the latest page before repeating the command.",
            });
            return "blocked";
          } else if (error instanceof StaleEditorTargetError) {
            setFeedback("That queued edit could not run because its block no longer exists. Nothing else was changed.");
            setState({ status: "idle" });
            return "local-failure";
          } else if (error instanceof EditorOperationUnavailableError) {
            setFeedback(error.message);
            setState({ status: "idle" });
            return "local-failure";
          } else {
            const laterCount = Math.max(0, pendingCommandCount.current - 1);
            const detail = error instanceof Error && error.message
              ? error.message
              : "The page structure request ended without a confirmed response.";
            const continuation = laterCount === 0
              ? "No later edits are queued."
              : `${laterCount} later ${laterCount === 1 ? "edit" : "edits"} will continue with version checks.`;
            const retrySummary = isTransientStructureSaveError(error)
              ? "One automatic retry also failed."
              : "It was not retried.";
            setFeedback(`The previous edit could not be confirmed: ${detail} ${retrySummary} ${continuation} Repeat the failed edit after reviewing the page.`);
            setState({ status: "idle" });
            return "external-failure";
          }
        }
      },
    });
    return {
      queue,
      dispose() {
        disposed = true;
        queue.cancel();
      },
    };
  }, [apiClient, doc, pageId]);
  const commandQueue = commandRuntime.queue;

  useEffect(() => {
    setState({ status: "idle" });
    setPendingFocus(null);
    setFeedback(null);
    awaitingVersion.current = null;
    deferredFocus.current = null;
    blocked.current = false;
    pendingCommandCount.current = 0;
    localInputRevision.current = 0;
    return () => commandRuntime.dispose();
  }, [commandRuntime]);

  useEffect(() => {
    if (awaitingVersion.current === null || mutationVersion < awaitingVersion.current) return;
    awaitingVersion.current = null;
    const focus = deferredFocus.current;
    deferredFocus.current = null;
    setPendingFocus(focus);
    setState({ status: "idle" });
    commandQueue.notifyReady();
  }, [commandQueue, mutationVersion]);

  const run = useCallback(async (
    operation: EditorOperation,
    options: { restoreFocus?: boolean } = {},
  ) => {
    await commandQueue.enqueue({
      kind: "operation",
      operation,
      restoreFocus: options.restoreFocus ?? true,
      focusRevision: localInputRevision.current,
    }).catch(() => undefined);
  }, [commandQueue]);

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
    await commandQueue.enqueue({
      kind: "plan",
      plan,
      restoreFocus: true,
      focusRevision: localInputRevision.current,
    }).catch(() => undefined);
  }, [commandQueue]);

  const convertToSessionReference = useCallback(async (blockId: string, sessionId: string) => {
    const target = existingBlock(blockId);
    const plan: EditorOperationPlan = {
      intents: [
        { type: "update-text", target, text: "" },
        {
          type: "update-type-and-properties",
          target,
          blockType: "session_ref",
          properties: { sessionId, primary: false },
        },
      ],
      focus: null,
    };
    await commandQueue.enqueue({
      kind: "plan",
      plan,
      restoreFocus: false,
      focusRevision: localInputRevision.current,
    }).catch(() => undefined);
  }, [commandQueue]);

  return {
    state,
    pendingFocus,
    feedback,
    run,
    createFirstBlock,
    convertToSessionReference,
    noteLocalInput() {
      localInputRevision.current += 1;
      deferredFocus.current = null;
      setPendingFocus(null);
    },
    queueFocus: setPendingFocus,
    clearFocus(focus) {
      setPendingFocus((current) => current === focus ? null : current);
    },
    dismissError() { setState({ status: "idle" }); },
    dismissFeedback() { setFeedback(null); },
    reportFailure(message) { setFeedback(message); },
    resync() {
      setState({ status: "resyncing", message: "Reloading the latest page…" });
      onResync();
    },
  };
}

function shouldSuppressCommand(
  pending: { readonly kind: "operation"; readonly operation: EditorOperation; readonly restoreFocus: boolean; readonly focusRevision: number } | { readonly kind: "plan"; readonly plan: EditorOperationPlan; readonly restoreFocus: boolean; readonly focusRevision: number },
  incoming: { readonly kind: "operation"; readonly operation: EditorOperation; readonly restoreFocus: boolean; readonly focusRevision: number } | { readonly kind: "plan"; readonly plan: EditorOperationPlan; readonly restoreFocus: boolean; readonly focusRevision: number },
): boolean {
  if (pending.kind !== "operation" || incoming.kind !== "operation") return false;
  const left = pending.operation;
  const right = incoming.operation;
  if (left.type === "splitBlock" && right.type === "splitBlock") {
    return left.blockId === right.blockId &&
      left.selection.anchor === right.selection.anchor &&
      left.selection.focus === right.selection.focus;
  }
  if (left.type === "deleteSelection" && right.type === "deleteSelection") {
    return left.blockIds.join("\u0000") === right.blockIds.join("\u0000");
  }
  return false;
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
    properties: structuredClone(block.properties),
  }));
}

function pageEditorIdempotencyKey(pageId: string): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Page editor mutation requires crypto.randomUUID");
  }
  return `page-editor:${pageId}:${globalThis.crypto.randomUUID()}`;
}

async function retryTransientStructureSave<T>(save: () => Promise<T>): Promise<T> {
  const attempts = 2;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await save();
    } catch (error) {
      if (!isTransientStructureSaveError(error) || attempt === attempts - 1) throw error;
      await Promise.resolve();
    }
  }
  throw new Error("unreachable page editor retry state");
}

function isTransientStructureSaveError(error: unknown): error is PageApiError {
  return error instanceof PageApiError && (error.kind === "network" || error.kind === "server");
}
