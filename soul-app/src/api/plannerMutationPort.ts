import * as Crypto from 'expo-crypto';
import type { PlannerBlock, PlannerPage, PlannerFolder } from './plannerTypes';
import type { FolderMutationResult } from './types';
import type { FolderSnapshot } from './cardTypes';
import type {
  ApplyPageOperationsInput,
  PageBacklink,
  PageMutationResult,
  PageReadResult,
} from './pageEndpoints';
import type { InitialFolderContext } from './initialFolderContext';
import type { CreateSessionRequest, CreateSessionResponse } from './sessionEndpoints';
import { requirePlannerFolderId } from './plannerFolderIdentity';
import { loadAllPlannerBacklinks, pageMountBlockIds } from './plannerBacklinks';
import { isPlannerDescriptionRoot } from '../lib/planner-description-blocks';
import { retryPageMutationVersionConflict } from './pageMutationRetry';

export interface PlannerMutationApi {
  getFolderSnapshot(folderId: string): Promise<FolderSnapshot>;
  getPage(pageId: string): Promise<PageReadResult>;
  getPageBacklinks(
    pageId: string,
    cursor?: string,
  ): Promise<{ items: PageBacklink[]; nextCursor: string | null }>;
  getDailyPage(date?: string): Promise<{ page: PlannerPage; created: boolean }>;
  applyPageOperations(pageId: string, input: ApplyPageOperationsInput): Promise<PageMutationResult>;
  setPageStarred(pageId: string, input: {
    starred: boolean;
    expectedVersion: number;
    idempotencyKey: string;
    reason?: string | null;
  }): Promise<PageMutationResult>;
  createFolder(input: {
    name: string;
    description?: string;
    parentFolderId?: string | null;
    initialContext?: InitialFolderContext;
    idempotencyKey?: string;
  }): Promise<FolderMutationResult>;
  setFolderStatus(folderId: string, status: 'open' | 'completed', expectedVersion: number, idempotencyKey: string): Promise<FolderMutationResult>;
  moveBoardItemToFolder(
    boardItemId: string,
    folderId: string,
    idempotencyKey: string,
  ): Promise<unknown>;
  updateFolder(folderId: string, input: { name?: string; parentFolderId?: string | null; expectedVersion: number; idempotencyKey: string }): Promise<FolderMutationResult>;
  archiveFolder(folderId: string, expectedVersion: number, idempotencyKey: string): Promise<FolderMutationResult>;
  createSession(input: CreateSessionRequest): Promise<CreateSessionResponse>;
  renameSession(sessionId: string, displayName: string | null): Promise<Response>;
  deleteSession(sessionId: string): Promise<Response>;
  acknowledgeSessionReview(sessionId: string): Promise<unknown>;
}

export function createPlannerMutationPort(api: PlannerMutationApi) {
  return {
    createFolder: async (input: {
      title: string;
      description: string;
      folderId: string;
      projectPageId: string;
      initialContext?: InitialFolderContext;
      dailyDate?: string;
    }) => {
      const result = await api.createFolder({
        name: input.title,
        description: input.description,
        parentFolderId: input.folderId,
        initialContext: input.initialContext,
        idempotencyKey: operationId('folder-create'),
      });
      if (input.dailyDate) {
        const daily = await api.getDailyPage(input.dailyDate);
        await mountPage(api, daily.page.id, input.title, 'folder-daily-mount');
      }
      return result;
    },

    completeFolder: (folder: PlannerFolder) => {
      if (!folder.folderSummary) throw new Error('폴더 정보를 찾을 수 없습니다.');
      return api.setFolderStatus(
        requirePlannerFolderId(folder),
        'completed', folder.folderSummary.version,
        operationId('folder-complete'),
      );
    },

    setFolderToday: async (folder: PlannerFolder, date: string, present: boolean) => {
      const daily = await api.getDailyPage(date);
      const [current, backlinks] = await Promise.all([
        api.getPage(daily.page.id),
        loadAllPlannerBacklinks(api, folder.page.id),
      ]);
      const mountIds = pageMountBlockIds(backlinks, daily.page.id, folder.page.id);
      if (present && mountIds.length === 0) {
        return appendMount(api, current, folder.page.title, 'folder-today-add');
      }
      if (!present && mountIds.length > 0) {
        return api.applyPageOperations(current.page.id, pageWrite(
          current,
          'folder-today-remove',
          mountIds.map((blockId) => ({ op: 'delete_block_subtree', block_id: blockId })),
        ));
      }
      return null;
    },

    saveFolderDescription: (pageId: string, markdown: string) =>
      savePageDescription(api, pageId, markdown, 'folder-description'),

    saveDailyMemo: async (dailyPageId: string, blockId: string | null, text: string) => {
      const current = await api.getPage(dailyPageId);
      if (blockId) {
        const block = current.blocks.find((candidate) => candidate.id === blockId);
        if (!block) throw new Error('편집할 메모 블록이 사라졌습니다.');
        if (block.text === text) return null;
        return api.applyPageOperations(dailyPageId, pageWrite(current, 'daily-memo', [
          { op: 'update_block_text', block_id: blockId, text },
        ]));
      }
      if (!text.trim()) return null;
      return appendBlock(api, current, text, 'daily-memo');
    },

    setFolderStarred: async (pageId: string, starred: boolean) => {
      const current = await api.getPage(pageId);
      return api.setPageStarred(pageId, {
        starred,
        expectedVersion: current.page.version,
        idempotencyKey: operationId('folder-star'),
        reason: 'soul-app v3 folder starred',
      });
    },

    moveFolderParent: async (
      folder: PlannerFolder,
      target: { folderId: string; projectPageId: string },
    ) => moveFolderParent(api, folder, target),

    saveProjectContext: (projectPageId: string, markdown: string) =>
      savePageDescription(api, projectPageId, markdown, 'project-context'),

    createRootFolder: (name: string) => api.createFolder({
      name: requiredText(name, '프로젝트 이름'),
      idempotencyKey: operationId('project-create'),
    }),
    renameFolder: async (folderId: string, name: string) => {
      const snapshot = await api.getFolderSnapshot(folderId);
      const response = await api.updateFolder(folderId, {
        name: requiredText(name, '프로젝트 이름'),
        expectedVersion: snapshot.folder.version,
        idempotencyKey: operationId('project-rename'),
      });
      return response;
    },
    archiveFolder: (folderId: string, version: number) => api.archiveFolder(folderId, version, operationId('folder-archive')),

    createPageAnchor: (pageId: string) => retryPageMutationVersionConflict(
      () => api.getPage(pageId),
      async (current) => {
        const tempId = operationId('session-anchor');
        const result = await api.applyPageOperations(pageId, pageWrite(current, 'session-anchor', [{
          op: 'create_block', temp_id: tempId, parent_id: null,
          after_block_id: lastRootId(current.blocks), block_type: 'paragraph', text: '',
          properties: {}, collapsed: false,
        }]));
        const blockId = result.tempIdMapping[tempId];
        if (!blockId) throw new Error('새 세션 page anchor 블록 ID를 받지 못했습니다.');
        return { pageId, blockId, expectedVersion: result.page.version };
      },
    ),

    createFolderSession: async (input: {
      folder: PlannerFolder;
      prompt: string;
      nodeId?: string;
      agentId?: string;
      modelPreset?: string;
      reasoningEffort?: string;
      predecessorSessionId?: string;
      pageAnchor?: { pageId: string; blockId: string; expectedVersion: number };
      extraContextItems?: Array<{ key: string; label: string; content: unknown }>;
      attachmentPaths?: string[];
    }) => {
      const folderId = requirePlannerFolderId(input.folder);
      return api.createSession({
        prompt: requiredText(input.prompt, '프롬프트'),
        ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.modelPreset ? { modelPreset: input.modelPreset } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        folderId: folderId,
        ...(input.pageAnchor ? { pageAnchor: input.pageAnchor } : {}),
        ...(input.predecessorSessionId
          ? { predecessorSessionId: input.predecessorSessionId }
          : {}),
        ...(input.attachmentPaths?.length
          ? { attachmentPaths: input.attachmentPaths }
          : {}),
        extraContextItems: input.extraContextItems ?? [{
          key: 'planner-folder',
          label: input.folder.page.title,
          content: { pageId: input.folder.page.id, folderId: folderId },
        }],
      });
    },

    renameFolderSession: (sessionId: string, displayName: string | null) =>
      api.renameSession(sessionId, displayName),
    deleteFolderSession: (sessionId: string) => api.deleteSession(sessionId),
    moveFolderSession: (sessionId: string, targetFolderId: string) =>
      api.moveBoardItemToFolder(
        `session:${sessionId}`,
        requiredText(targetFolderId, '폴더 ID'),
        operationId('session-move-folder'),
      ),
    acknowledgeFolderSession: (sessionId: string) => api.acknowledgeSessionReview(sessionId),
  };
}

async function savePageDescription(
  api: PlannerMutationApi,
  pageId: string,
  markdown: string,
  prefix: string,
) {
  const current = await api.getPage(pageId);
  const editable = current.blocks.filter(isPlannerDescriptionRoot);
  const operations: ApplyPageOperationsInput['operations'] = [];
  const text = markdown.trim();
  if (editable[0] && editable[0].text !== text) {
    operations.push({ op: 'update_block_text', block_id: editable[0].id, text });
  } else if (!editable[0] && text) {
    operations.push({
      op: 'create_block', temp_id: operationId(`${prefix}-block`), parent_id: null,
      after_block_id: lastRootId(current.blocks), block_type: 'paragraph', text,
      properties: {}, collapsed: false,
    });
  }
  for (const block of editable.slice(text ? 1 : 0)) {
    operations.push({ op: 'delete_block_subtree', block_id: block.id });
  }
  if (operations.length === 0) return null;
  return api.applyPageOperations(pageId, pageWrite(current, prefix, operations));
}

async function mountPage(
  api: PlannerMutationApi,
  pageId: string,
  title: string,
  prefix: string,
) {
  const current = await api.getPage(pageId);
  if (current.blocks.some((block) => mountTitle(block) === title)) return null;
  return appendMount(api, current, title, prefix);
}

function appendMount(api: PlannerMutationApi, page: PageReadResult, title: string, prefix: string) {
  return appendBlock(api, page, `[[${title}]]`, prefix);
}

function appendBlock(api: PlannerMutationApi, page: PageReadResult, text: string, prefix: string) {
  return api.applyPageOperations(page.page.id, pageWrite(page, prefix, [{
    op: 'create_block', temp_id: operationId(`${prefix}-block`), parent_id: null,
    after_block_id: lastRootId(page.blocks), block_type: 'paragraph', text,
    properties: {}, collapsed: false,
  }]));
}

async function moveFolderParent(
  api: PlannerMutationApi,
  folder: PlannerFolder,
  target: { folderId: string; projectPageId: string },
) {
  if (!folder.folderSummary) throw new Error('폴더 정보를 찾을 수 없습니다.');
  if (folder.parentFolderId === target.folderId) throw new Error('이미 이 폴더에 속해 있습니다.');
  return api.updateFolder(folder.folderId, {
    parentFolderId: target.folderId,
    expectedVersion: folder.folderSummary.version,
    idempotencyKey: operationId('folder-move'),
  });
}

function pageWrite(
  page: PageReadResult,
  prefix: string,
  operations: ApplyPageOperationsInput['operations'],
): ApplyPageOperationsInput {
  return {
    expectedVersion: page.page.version,
    expectedStateVector: page.stateVector,
    idempotencyKey: operationId(prefix),
    reason: `soul-app v3 ${prefix}`,
    operations,
  };
}

function mountTitle(block: PlannerBlock): string | null {
  const match = /^\[\[([^\]]+)\]\]$/.exec(block.text.trim());
  return match?.[1]?.trim() || null;
}

function lastRootId(blocks: PlannerBlock[]): string | null {
  return [...blocks].reverse().find((block) => block.parentId === null)?.id ?? null;
}

function requiredText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label}을 입력해야 합니다.`);
  return text;
}

export function operationId(prefix: string): string {
  if (typeof Crypto.randomUUID !== 'function') {
    throw new Error('UUID 생성 기능을 사용할 수 없습니다.');
  }
  return `soul-app-v3-${prefix}-${Crypto.randomUUID()}`;
}
