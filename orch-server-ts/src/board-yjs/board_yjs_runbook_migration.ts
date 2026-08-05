import { parseBoardYjsDocumentName, readBoardYDocReplica } from "./board_yjs_model.js";
import type { BoardYjsPersistenceRepository } from "./board_yjs_persistence.js";
import { BoardYjsMigrationRevisionConflictError } from "./board_yjs_raw_document.js";
import {
  createBoardYjsRunbookMigrationPlan,
  hashBoardYjsDocument,
  recomposeBoardYjsRawDocument,
} from "./board_yjs_runbook_plan.js";
import { getCanonicalRunbookDocumentName } from "./board_yjs_runbook_residue.js";

const MAX_REVISION_RETRIES = 3;

export interface BoardYjsRunbookMigrationRequest {
  documentName: string;
  planFingerprint: string;
  opaqueBoardItemIds: readonly string[];
  approvedCollisionContentHash?: string | null;
}

export async function executeQuiescedBoardYjsRunbookMigrationBatch(input: {
  requests: readonly BoardYjsRunbookMigrationRequest[];
  repository: BoardYjsPersistenceRepository;
}): Promise<Array<Awaited<ReturnType<typeof executeQuiescedBoardYjsRunbookMigration>>>> {
  if (input.requests.length === 0) return [];
  if (!input.repository.runBoardYjsRunbookMigrationTransaction) {
    throw new Error("board Y.Doc migration repository requires a transaction boundary");
  }
  return await input.repository.runBoardYjsRunbookMigrationTransaction(
    async (transactionRepository) => {
      const results = [];
      for (const request of input.requests) {
        results.push(await executeQuiescedBoardYjsRunbookMigration({
          request,
          repository: transactionRepository,
        }));
      }
      return results;
    },
  );
}

export async function executeQuiescedBoardYjsRunbookMigration(input: {
  request: BoardYjsRunbookMigrationRequest;
  repository: BoardYjsPersistenceRepository;
}): Promise<{
  sourceDocumentName: string;
  canonicalDocumentName: string;
  planFingerprint: string;
  collisionContentHash: string | null;
  targetCollision: boolean;
  targetEquivalent: boolean | null;
  attempts: number;
}> {
  const { request, repository } = input;
  if (!repository.loadRawBoardYjsDocument || !repository.commitBoardYjsRunbookMigration) {
    throw new Error("board Y.Doc runbook migration repository is not configured");
  }

  for (let attempt = 1; attempt <= MAX_REVISION_RETRIES; attempt += 1) {
    const source = await repository.loadRawBoardYjsDocument(request.documentName);
    if (!source) throw new Error(`board Y.Doc not found: ${request.documentName}`);
    const canonicalDocumentName = getCanonicalRunbookDocumentName(request.documentName);
    const canonical = canonicalDocumentName === request.documentName
      ? null
      : await repository.loadRawBoardYjsDocument(canonicalDocumentName);
    const computed = createBoardYjsRunbookMigrationPlan({
      sourceDocumentName: request.documentName,
      source,
      canonical,
    });
    validateApprovedPlan(computed.plan, request);

    const container = parseBoardYjsDocumentName(canonicalDocumentName);
    if (!container) throw new Error(`invalid canonical board Y.Doc: ${canonicalDocumentName}`);
    const scope = await repository.resolveBoardYjsContainerScope(container);
    if (!scope) throw new Error(`board Y.Doc container not found: ${canonicalDocumentName}`);
    const committedDocument = computed.plan.targetCollision && canonical
      ? recomposeBoardYjsRawDocument(canonical)
      : computed.migratedDocument;
    try {
      await repository.commitBoardYjsRunbookMigration({
        sourceDocumentName: request.documentName,
        canonicalDocumentName,
        expectedSourceRevision: source.revision,
        expectedCanonicalRevision: canonical?.revision ?? null,
        canonicalSnapshot: computed.migratedSnapshot,
        scope,
        replica: readBoardYDocReplica(scope, committedDocument),
        preserveCanonical: computed.plan.targetCollision,
      });
    } catch (error) {
      if (error instanceof BoardYjsMigrationRevisionConflictError &&
        attempt < MAX_REVISION_RETRIES) {
        continue;
      }
      throw error;
    }

    const persisted = await repository.loadRawBoardYjsDocument(canonicalDocumentName);
    if (!persisted) throw new Error(`canonical board Y.Doc missing: ${canonicalDocumentName}`);
    const persistedHash = hashBoardYjsDocument(recomposeBoardYjsRawDocument(persisted));
    const expectedHash = computed.plan.targetCollision
      ? computed.plan.canonicalContentHash
      : computed.plan.migratedContentHash;
    if (persistedHash !== expectedHash) {
      throw new Error(
        `canonical board Y.Doc postcondition failed: expected ${expectedHash}, ` +
          `received ${persistedHash}`,
      );
    }
    return {
      sourceDocumentName: request.documentName,
      canonicalDocumentName,
      planFingerprint: computed.plan.planFingerprint,
      collisionContentHash: computed.plan.collisionContentHash,
      targetCollision: computed.plan.targetCollision,
      targetEquivalent: computed.plan.targetEquivalent,
      attempts: attempt,
    };
  }
  throw new Error(`board Y.Doc migration retries exhausted: ${request.documentName}`);
}

function validateApprovedPlan(
  plan: ReturnType<typeof createBoardYjsRunbookMigrationPlan>["plan"],
  request: BoardYjsRunbookMigrationRequest,
): void {
  if (plan.planFingerprint !== request.planFingerprint) {
    throw new Error(
      `board Y.Doc migration plan fingerprint mismatch: expected ${request.planFingerprint}, ` +
        `received ${plan.planFingerprint}`,
    );
  }
  assertSameStrings(plan.opaqueBoardItemIds, request.opaqueBoardItemIds);
  if (!plan.opaqueBoardItemIdsPreserved) {
    throw new Error("canonical collision would drop opaque runbook board item IDs");
  }
  if (request.approvedCollisionContentHash !== undefined &&
    request.approvedCollisionContentHash !== null &&
    request.approvedCollisionContentHash !== plan.collisionContentHash) {
    throw new Error("approved collision content hash does not match the migration plan");
  }
  if (plan.targetCollision && plan.targetEquivalent === false &&
    request.approvedCollisionContentHash !== plan.collisionContentHash) {
    throw new Error(
      `non-equivalent canonical collision requires explicit content hash approval: ` +
        `${plan.collisionContentHash}`,
    );
  }
}

function assertSameStrings(actual: readonly string[], expected: readonly string[]): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(
      `opaque runbook board item allowlist mismatch: expected ${JSON.stringify(right)}, ` +
        `received ${JSON.stringify(left)}`,
    );
  }
}
