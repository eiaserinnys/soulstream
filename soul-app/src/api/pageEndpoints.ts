import type { ApiRequestContext } from './clientCore';
import {
  parsePlannerBlock,
  parsePlannerPage,
  type PlannerBlock,
  type PlannerBlockWire,
  type PlannerPage,
  type PlannerPageWire,
} from './plannerTypes';
import type { PageStructureOperation } from '../../../packages/soul-ui/src/page/page-structure-operation';

export interface PageReadResult {
  page: PlannerPage;
  blocks: PlannerBlock[];
  stateVector: string;
}

export interface PageMutationResult {
  page: PlannerPage;
  blocks: PlannerBlock[];
  operation: { id: string; [key: string]: unknown };
  tempIdMapping: Record<string, string>;
  idempotent: boolean;
}

interface PageReadWire {
  page: PlannerPageWire;
  blocks: PlannerBlockWire[];
  state_vector: string;
}

interface PageMutationWire {
  page: PlannerPageWire;
  blocks: PlannerBlockWire[];
  operation: { id: string; [key: string]: unknown };
  temp_id_mapping: Record<string, string>;
  idempotent?: boolean;
}

export interface ApplyPageOperationsInput {
  expectedVersion: number;
  expectedStateVector: string;
  idempotencyKey: string;
  reason?: string | null;
  operations: PageStructureOperation[];
}

export interface TransferPageBlocksInput {
  source: {
    pageId: string;
    expectedVersion: number;
    expectedStateVector: string;
    blockIds: readonly string[];
  };
  target:
    | {
        kind: 'existing';
        pageId: string;
        expectedVersion: number;
        expectedStateVector: string;
        parentId: string | null;
        afterBlockId: string | null;
      }
    | { kind: 'new'; pageId: string; title: string; folderId?: string };
  sourceMount?: { title: string; tempId: string };
  idempotencyKey: string;
  reason?: string | null;
}

export interface TransferPageBlocksResult {
  source: PageMutationResult;
  target: PageMutationResult;
  targetCreated: boolean;
}

export interface PageBacklink {
  id: string;
  sourcePageId: string;
  sourcePageTitle: string;
  sourceBlockId: string;
  sourceTextPreview: string;
  linkKind: 'mount' | 'block_reference' | string;
  targetPageId: string | null;
  targetBlockId: string | null;
  sourceStart: number;
  sourceEnd: number;
}

const BROWSER_BACKLINK_PAGE_SIZE = 50;

export function createPageEndpoints({ base, authFetch, readJson }: ApiRequestContext) {
  return {
    getPage: (pageId: string): Promise<PageReadResult> =>
      authFetch(`${base}/api/pages/${encodeURIComponent(pageId)}`)
        .then((response) => readJson<PageReadWire>(response, 'getPage'))
        .then(parsePageRead),

    getPageBacklinks: (
      pageId: string,
      cursor?: string,
    ): Promise<{ items: PageBacklink[]; nextCursor: string | null }> => {
      const query = new URLSearchParams({
        kinds: 'mount',
        limit: String(BROWSER_BACKLINK_PAGE_SIZE),
      });
      if (cursor) query.set('cursor', cursor);
      return authFetch(
        `${base}/api/pages/${encodeURIComponent(pageId)}/backlinks?${query.toString()}`,
      ).then((response) => readJson(response, 'getPageBacklinks'));
    },

    applyPageOperations: (
      pageId: string,
      input: ApplyPageOperationsInput,
    ): Promise<PageMutationResult> =>
      authFetch(`${base}/api/pages/${encodeURIComponent(pageId)}/operations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expected_version: input.expectedVersion,
          expected_state_vector: input.expectedStateVector,
          idempotency_key: input.idempotencyKey,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          operations: input.operations,
        }),
      }).then((response) => readJson<PageMutationWire>(response, 'applyPageOperations'))
        .then(parsePageMutation),

    transferPageBlocks: (input: TransferPageBlocksInput): Promise<TransferPageBlocksResult> =>
      authFetch(`${base}/api/pages/block-transfers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: {
            page_id: input.source.pageId,
            expected_version: input.source.expectedVersion,
            expected_state_vector: input.source.expectedStateVector,
            block_ids: input.source.blockIds,
          },
          target: input.target.kind === 'new'
            ? {
                kind: 'new',
                page_id: input.target.pageId,
                title: input.target.title,
                ...(input.target.folderId === undefined
                  ? {}
                  : { folder_id: input.target.folderId }),
              }
            : {
                kind: 'existing',
                page_id: input.target.pageId,
                expected_version: input.target.expectedVersion,
                expected_state_vector: input.target.expectedStateVector,
                parent_id: input.target.parentId,
                after_block_id: input.target.afterBlockId,
              },
          ...(input.sourceMount
            ? { source_mount: { title: input.sourceMount.title, temp_id: input.sourceMount.tempId } }
            : {}),
          idempotency_key: input.idempotencyKey,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        }),
      }).then((response) => readJson<{
        source: PageMutationWire;
        target: PageMutationWire;
        target_created: boolean;
      }>(response, 'transferPageBlocks')).then((result) => ({
        source: parsePageMutation(result.source),
        target: parsePageMutation(result.target),
        targetCreated: result.target_created,
      })),

    setPageStarred: (
      pageId: string,
      input: {
        starred: boolean;
        expectedVersion: number;
        idempotencyKey: string;
        reason?: string | null;
      },
    ): Promise<PageMutationResult> =>
      authFetch(`${base}/api/pages/${encodeURIComponent(pageId)}/starred`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          starred: input.starred,
          expected_version: input.expectedVersion,
          idempotency_key: input.idempotencyKey,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        }),
      }).then((response) => readJson<PageMutationWire>(response, 'setPageStarred'))
        .then(parsePageMutation),
  };
}

function parsePageRead(raw: PageReadWire): PageReadResult {
  return {
    page: parsePlannerPage(raw.page),
    blocks: raw.blocks.map(parsePlannerBlock),
    stateVector: raw.state_vector,
  };
}

function parsePageMutation(raw: PageMutationWire): PageMutationResult {
  return {
    page: parsePlannerPage(raw.page),
    blocks: raw.blocks.map(parsePlannerBlock),
    operation: raw.operation,
    tempIdMapping: raw.temp_id_mapping,
    idempotent: raw.idempotent === true,
  };
}
