import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";

import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";

import { planPageBlockTransfer } from "./page_block_transfer.js";
import type {
  CreatePageMutationInput,
  PageMutationActor,
  PageMutationApplication,
  PageMutationCore,
} from "./page_mutation_core.js";
import type { CommitPageMutationInput, PageMutationCommitResult } from "./page_repository.js";
import type {
  PageServiceMutationResult,
  PageServiceRepository,
} from "./page_service.js";
import type { PageAsyncMutex } from "./page_async_mutex.js";
import { PageMutationValidationError } from "./page_mutation_validation.js";
import {
  PageMutationIdempotencyConflictError,
  PageMutationStateVectorConflictError,
  PageMutationVersionConflictError,
  stateVectorsEqual,
} from "./page_mutation_helpers.js";
import { getPageYjsDocumentName, readPageYDocReplica } from "./page_yjs_model.js";

export interface PageBlockTransferInput {
  source: {
    pageId: string;
    expectedVersion: number;
    expectedStateVector: Uint8Array;
    blockIds: readonly string[];
  };
  target:
    | {
        kind: "existing";
        pageId: string;
        expectedVersion: number;
        expectedStateVector: Uint8Array;
        parentId: string | null;
        afterBlockId: string | null;
      }
    | { kind: "new"; pageId: string; title: string };
  sourceMount?: { title: string; tempId: string };
  actor: PageMutationActor;
  idempotencyKey: string;
  reason?: string | null;
}

export interface PageBlockTransferResult {
  source: PageServiceMutationResult;
  target: PageServiceMutationResult;
  target_created: boolean;
}

export interface PageBlockTransferRuntime {
  repository: PageServiceRepository;
  mutationCore: PageMutationCore;
  mutex: PageAsyncMutex;
  hocuspocus: Hocuspocus;
  createOperationId(): string;
  hydrateCommittedPage(documentName: string): Promise<void>;
  decodeSnapshot(snapshot: Uint8Array): Y.Doc;
  toMutationResult(
    replica: ReturnType<typeof readPageYDocReplica>,
    mapping: Record<string, string>,
    committed: PageMutationCommitResult,
  ): PageServiceMutationResult;
}

export async function transferPageBlocks(
  runtime: PageBlockTransferRuntime,
  input: PageBlockTransferInput,
): Promise<PageBlockTransferResult> {
  if (
    input.sourceMount &&
    input.target.kind === "new" &&
    input.sourceMount.title !== input.target.title
  ) {
    throw new PageMutationValidationError("extract mount title must match the new page title");
  }
  const samePage = input.target.kind === "existing" && input.target.pageId === input.source.pageId;
  const keys = [`${input.idempotencyKey}:source`, `${input.idempotencyKey}:target`] as const;
  const earlyIdempotent = await resolveIdempotentTransfer(runtime, input, samePage, keys);
  if (earlyIdempotent) return earlyIdempotent;

  return await runtime.mutex.runExclusiveMany(
    [input.source.pageId, input.target.pageId],
    async () => {
      const lockedIdempotent = await resolveIdempotentTransfer(runtime, input, samePage, keys);
      return lockedIdempotent ?? await transferLocked(runtime, input, samePage, keys);
    },
  );
}

async function resolveIdempotentTransfer(
  runtime: PageBlockTransferRuntime,
  input: PageBlockTransferInput,
  samePage: boolean,
  keys: readonly string[],
): Promise<PageBlockTransferResult | null> {
  const [source, target] = await Promise.all(keys.map((key) => (
    runtime.repository.getPageMutationByIdempotencyKey(key)
  )));
  if (!source && !target) return null;
  const identity = transferIdentity(input);
  if (!source || !hasTransferIdentity(source, identity)) {
    throw new PageMutationIdempotencyConflictError();
  }
  if (samePage) {
    if (target) throw new PageMutationIdempotencyConflictError();
    const result = await resultFromCommit(runtime, source);
    return { source: result, target: result, target_created: false };
  }
  if (!target || !hasTransferIdentity(target, identity)) {
    throw new PageMutationIdempotencyConflictError();
  }
  const [sourceResult, targetResult] = await Promise.all([
    resultFromCommit(runtime, source),
    resultFromCommit(runtime, target),
  ]);
  return {
    source: sourceResult,
    target: targetResult,
    target_created: input.target.kind === "new",
  };
}

async function transferLocked(
  runtime: PageBlockTransferRuntime,
  input: PageBlockTransferInput,
  samePage: boolean,
  keys: readonly string[],
): Promise<PageBlockTransferResult> {
  const commitMany = runtime.repository.commitPageMutations?.bind(runtime.repository);
  if (!commitMany) throw new Error("page repository does not support atomic block transfer");
  const sourceName = getPageYjsDocumentName(input.source.pageId);
  const targetName = getPageYjsDocumentName(input.target.pageId);
  if (input.target.kind === "new") {
    const existing = await runtime.repository.getPageYjsSnapshot(targetName);
    if (existing) {
      const actual = readPageYDocReplica(input.target.pageId, runtime.decodeSnapshot(existing));
      throw new PageMutationVersionConflictError(input.target.pageId, 0, actual.page.mutationVersion);
    }
  }
  if (samePage) validateSamePageTargetCas(input);
  const identity = transferIdentity(input);
  const sourceContext = operationContext();
  const sourceConnection = await runtime.hocuspocus.openDirectConnection(sourceName, sourceContext);
  const targetContext = operationContext();
  const targetConnection = input.target.kind === "existing" && !samePage
    ? await runtime.hocuspocus.openDirectConnection(targetName, targetContext)
    : null;
  try {
    const sourceLive = requireDocument(sourceConnection.document, input.source.pageId);
    const targetLive = samePage
      ? sourceLive
      : targetConnection
        ? requireDocument(targetConnection.document, input.target.pageId)
        : null;
    const sourceReplica = readPageYDocReplica(input.source.pageId, sourceLive);
    const targetReplica = targetLive ? readPageYDocReplica(input.target.pageId, targetLive) : null;
    const targetPlacement = input.target.kind === "existing"
      ? { parentId: input.target.parentId, afterBlockId: input.target.afterBlockId }
      : { parentId: null, afterBlockId: null };
    const plan = planPageBlockTransfer({
      source: sourceReplica,
      target: targetReplica,
      selectedBlockIds: input.source.blockIds,
      targetPlacement,
      sourceMount: input.sourceMount,
    });
    const sourceApplication = withTransferIdentity(runtime.mutationCore.mutate(sourceLive, {
      pageId: input.source.pageId,
      expectedVersion: input.source.expectedVersion,
      expectedStateVector: input.source.expectedStateVector,
      command: { type: "batch_operations", operations: plan.sourceOperations },
      actor: input.actor,
      idempotencyKey: keys[0]!,
      reason: input.reason,
    }), identity);
    if (samePage) {
      const primaryBindings = primaryBindingUpdates(
        sourceApplication.replica,
        plan.primarySessionIds,
      );
      const committed = await commitMany({
        mutations: [mutation(sourceName, sourceApplication, runtime.createOperationId())],
        primaryBindings,
      });
      if (committed[0]!.idempotent) {
        const result = await resultFromCommit(runtime, committed[0]!);
        return { source: result, target: result, target_created: false };
      }
      Y.applyUpdate(sourceLive, sourceApplication.update, committed[0]!.operation.id);
      await flush(runtime.hocuspocus, sourceName);
      const result = runtime.toMutationResult(sourceApplication.replica, sourceApplication.tempIdMapping, committed[0]!);
      return { source: result, target: result, target_created: false };
    }

    const targetApplication = withTransferIdentity(input.target.kind === "new"
      ? runtime.mutationCore.createPage({
          page: { id: input.target.pageId, title: input.target.title, dailyDate: null, metadata: {} },
          actor: input.actor,
          idempotencyKey: keys[1]!,
          reason: input.reason,
          initialCommand: { type: "batch_operations", operations: plan.targetOperations },
        })
      : runtime.mutationCore.mutate(targetLive!, {
          pageId: input.target.pageId,
          expectedVersion: input.target.expectedVersion,
          expectedStateVector: input.target.expectedStateVector,
          command: { type: "batch_operations", operations: plan.targetOperations },
          actor: input.actor,
          idempotencyKey: keys[1]!,
          reason: input.reason,
        }), identity);
    const primaryBindings = primaryBindingUpdates(targetApplication.replica, plan.primarySessionIds);
    const committed = await commitMany({
      mutations: [
        mutation(sourceName, sourceApplication, runtime.createOperationId()),
        mutation(targetName, targetApplication, runtime.createOperationId()),
      ],
      primaryBindings,
    });
    if (committed.every((result) => result.idempotent)) {
      const [source, target] = await Promise.all(committed.map((result) => (
        resultFromCommit(runtime, result)
      )));
      return {
        source: source!,
        target: target!,
        target_created: input.target.kind === "new",
      };
    }
    if (committed.some((result) => result.idempotent)) {
      throw new PageMutationIdempotencyConflictError();
    }
    Y.applyUpdate(sourceLive, sourceApplication.update, committed[0]!.operation.id);
    if (targetLive) {
      Y.applyUpdate(targetLive, targetApplication.update, committed[1]!.operation.id);
      await Promise.all([
        flush(runtime.hocuspocus, sourceName),
        flush(runtime.hocuspocus, targetName),
      ]);
    } else {
      await flush(runtime.hocuspocus, sourceName);
      await runtime.hydrateCommittedPage(targetName);
    }
    return {
      source: runtime.toMutationResult(sourceApplication.replica, sourceApplication.tempIdMapping, committed[0]!),
      target: runtime.toMutationResult(targetApplication.replica, targetApplication.tempIdMapping, committed[1]!),
      target_created: input.target.kind === "new",
    };
  } finally {
    sourceContext.skipPagePersistence = true;
    targetContext.skipPagePersistence = true;
    await targetConnection?.disconnect();
    await sourceConnection.disconnect();
  }
}

function validateSamePageTargetCas(input: PageBlockTransferInput): void {
  if (input.target.kind !== "existing") return;
  if (input.target.expectedVersion !== input.source.expectedVersion) {
    throw new PageMutationVersionConflictError(
      input.source.pageId,
      input.target.expectedVersion,
      input.source.expectedVersion,
    );
  }
  if (!stateVectorsEqual(input.target.expectedStateVector, input.source.expectedStateVector)) {
    throw new PageMutationStateVectorConflictError(input.source.pageId);
  }
}

function withTransferIdentity(
  application: PageMutationApplication,
  identity: Record<string, unknown>,
): PageMutationApplication {
  return {
    ...application,
    payload: { ...application.payload, transfer_identity: identity },
  };
}

function hasTransferIdentity(
  committed: PageMutationCommitResult,
  identity: Record<string, unknown>,
): boolean {
  return isDeepStrictEqual(committed.operation.payload_json.transfer_identity, identity);
}

function transferIdentity(input: PageBlockTransferInput): Record<string, unknown> {
  return {
    source: {
      page_id: input.source.pageId,
      expected_version: input.source.expectedVersion,
      expected_state_vector: Buffer.from(input.source.expectedStateVector).toString("base64"),
      block_ids: [...input.source.blockIds],
    },
    target: input.target.kind === "new"
      ? { kind: "new", page_id: input.target.pageId, title: input.target.title }
      : {
          kind: "existing",
          page_id: input.target.pageId,
          expected_version: input.target.expectedVersion,
          expected_state_vector: Buffer.from(input.target.expectedStateVector).toString("base64"),
          parent_id: input.target.parentId,
          after_block_id: input.target.afterBlockId,
        },
    source_mount: input.sourceMount
      ? { title: input.sourceMount.title, temp_id: input.sourceMount.tempId }
      : null,
  };
}

function operationContext() {
  return { pageLockHeld: true, source: "page-block-transfer", skipPagePersistence: false };
}

function requireDocument(document: unknown, pageId: string): Y.Doc {
  if (!(document instanceof Y.Doc)) throw new Error(`page Y.Doc direct connection closed: ${pageId}`);
  return document;
}

function mutation(
  documentName: string,
  application: CommitPageMutationInput["application"],
  operationId: string,
): CommitPageMutationInput {
  return { documentName, application, operationId };
}

async function flush(hocuspocus: Hocuspocus, documentName: string): Promise<void> {
  const debounceId = `onStoreDocument-${documentName}`;
  if (hocuspocus.debouncer.isDebounced(debounceId)) {
    await hocuspocus.debouncer.executeNow(debounceId);
  }
}

function requirePrimaryBlockId(
  replica: ReturnType<typeof readPageYDocReplica>,
  sessionId: string,
): string {
  const block = replica.blocks.find((candidate) => (
    candidate.type === "session_ref" &&
    candidate.properties.primary === true &&
    candidate.properties.sessionId === sessionId
  ));
  if (!block) throw new Error(`moved primary session reference missing: ${sessionId}`);
  return block.id;
}

function primaryBindingUpdates(
  replica: ReturnType<typeof readPageYDocReplica>,
  sessionIds: readonly string[],
) {
  return sessionIds.map((sessionId) => ({
    sessionId,
    blockId: requirePrimaryBlockId(replica, sessionId),
    targetPageId: replica.page.id,
    targetVersion: replica.page.mutationVersion,
  }));
}

async function resultFromCommit(
  runtime: PageBlockTransferRuntime,
  committed: PageMutationCommitResult,
): Promise<PageServiceMutationResult> {
  const documentName = getPageYjsDocumentName(committed.operation.page_id);
  const snapshot = await runtime.repository.getPageYjsSnapshot(documentName);
  if (!snapshot) throw new Error(`page snapshot missing: ${committed.operation.page_id}`);
  const replica = readPageYDocReplica(committed.operation.page_id, runtime.decodeSnapshot(snapshot));
  return { ...runtime.toMutationResult(replica, {}, committed), idempotent: true };
}
