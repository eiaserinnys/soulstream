import type { PlannerFolder } from '../../../api/plannerTypes';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../../hooks/useChatAttachments', () => ({
  useChatAttachments: () => ({
    attachments: [],
    uploading: false,
    pickAttachment: jest.fn(),
    uploadAttachment: jest.fn(),
    removeAttachment: jest.fn(),
    clearAttachments: jest.fn(),
  }),
}));

import {
  buildSuccessionContextSelection,
  INITIAL_SESSION_PROMPT,
  resolveSessionPredecessor,
  resolveSessionAssignmentDefaults,
} from '../SessionSuccessionSheet';
import { resolveDiagnosticSessionTarget } from '../SessionSuccessionDiagnosticFallback';

const folder = {
  sessions: [
    { agentSessionId: 'session-1' },
    { agentSessionId: 'session-2' },
  ],
} as PlannerFolder;

test('새 세션 null은 마지막 실행을 자동 승계하지 않는다', () => {
  expect(resolveSessionPredecessor(folder, null)).toBeUndefined();
});

test('명시한 세션만 승계 대상으로 선택한다', () => {
  expect(resolveSessionPredecessor(folder, 'session-1')?.agentSessionId).toBe('session-1');
  expect(resolveSessionPredecessor(folder, undefined)).toBeUndefined();
});

test('승계 확인 시트는 하드코딩 지시 없이 시작한다', () => {
  expect(INITIAL_SESSION_PROMPT).toBe('');
});

test('업무·프로젝트 기본 담당을 predecessor보다 우선하고 빈 필드만 보완한다', () => {
  expect(resolveSessionAssignmentDefaults(
    { agentId: 'task-agent', nodeId: 'task-node', modelPreset: 'task-model' },
    {
      agentId: 'previous-agent',
      nodeId: 'previous-node',
      modelPreset: 'previous-model',
    },
  )).toEqual({
    agentId: 'task-agent',
    nodeId: 'task-node',
    modelPreset: 'task-model',
    reasoningEffort: null,
  });
  expect(resolveSessionAssignmentDefaults(
    { agentId: 'task-agent', nodeId: null, modelPreset: null },
    {
      agentId: 'previous-agent',
      nodeId: 'previous-node',
      modelPreset: 'previous-model',
    },
  )).toEqual({
    agentId: 'task-agent',
    nodeId: 'previous-node',
    modelPreset: 'previous-model',
    reasoningEffort: null,
  });
});

test('후계 세션은 원본 세션의 effort를 상속한다', () => {
  // 저장된 비기본값이 후계 생성에서 프리셋 기본값으로 되돌아가면 안 된다.
  expect(resolveSessionAssignmentDefaults(
    { agentId: 'task-agent', nodeId: 'task-node', modelPreset: 'task-model' },
    {
      agentId: 'previous-agent',
      nodeId: 'previous-node',
      modelPreset: 'previous-model',
      reasoningEffort: 'low',
    },
  ).reasoningEffort).toBe('low');
});

test('업무 기본 담당은 effort를 갖지 않으므로 predecessor가 없으면 null이다', () => {
  expect(resolveSessionAssignmentDefaults(
    { agentId: 'task-agent', nodeId: 'task-node', modelPreset: 'task-model' },
    undefined,
  ).reasoningEffort).toBeNull();
});

test('진단 fallback도 업무 기본 preset을 세션 생성 대상으로 보존한다', () => {
  expect(resolveDiagnosticSessionTarget({
    ...folder,
    blocks: [{
      id: 'defaults',
      pageId: 'task-page',
      parentId: null,
      positionKey: 'a',
      blockType: 'session_defaults',
      text: '',
      properties: {
        agentId: 'task-agent',
        nodeId: 'task-node',
        modelPreset: 'task-model',
      },
      collapsed: false,
    }],
  } as PlannerFolder, 'session-1', 'settings-node')).toEqual({
    agentId: 'task-agent',
    nodeId: 'task-node',
    modelPreset: 'task-model',
    source: 'task-defaults',
  });
});

test('후계 세션 컨텍스트 토글은 업무 문맥만 포함한다', () => {
  const contextFolder = {
    ...folder,
    page: { id: 'task-page', title: '업무' },
    folderId: 'task-1',
  } as PlannerFolder;
  expect(buildSuccessionContextSelection({
    folder: contextFolder,
    includeFolderContext: true,
  })).toEqual({
    needsPageAnchor: true,
    contextItems: [
      {
        key: 'planner-folder',
        label: '업무',
        content: { pageId: 'task-page', folderId: 'task-1' },
      },
    ],
  });
  expect(buildSuccessionContextSelection({
    folder: contextFolder,
    includeFolderContext: false,
  })).toEqual({ needsPageAnchor: false, contextItems: [] });
});
