import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { PlannerFolder } from '../../../api/plannerTypes';

const mockBuildPlannerContextPresentation = jest.fn();
const mockCreateFolderSession = jest.fn();
const mockReportSanitizedEasObserveError = jest.fn();
let mockDiagnosticFallbackShouldThrow = false;
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
const mockUseNewSessionSelection = jest.fn((_input?: unknown) => ({
  selectedFolderId: null,
  setSelectedFolderId: jest.fn(),
  selectedNodeId: 'eiaserinnys',
  setSelectedNodeId: jest.fn(),
  nodes: [{ nodeId: 'eiaserinnys' }],
  agents: [{ id: 'seosoyoung_codex', name: '서소영 (codex)' }],
  agentId: 'seosoyoung_codex',
  setAgentId: jest.fn(),
  modelPresets: [],
  selectedModelPresetId: null,
  setSelectedModelPresetId: jest.fn(),
  effectiveModelPresetId: null,
  selectedModelPresetName: '자동 선택',
  selectedModelPresetUsageWarning: false,
  modelPresetSelectionInvalid: false,
  effectiveNodeId: 'eiaserinnys',
  sortedFolders: [],
  selectedFolderName: '폴더 미지정',
  selectedAgentName: '서소영 (codex)',
  selectedNodeName: 'eiaserinnys',
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: { version: '1.0.0', ios: { buildNumber: '89' } },
    platform: {
      ios: {
        buildNumber: '89',
        systemVersion: '26.5.2',
        model: 'iPad',
        platform: 'iPad17,2',
        userInterfaceIdiom: 'tablet',
      },
    },
  },
}));
jest.mock('../../../lib/planner-context-presentation', () => ({
  ...jest.requireActual('../../../lib/planner-context-presentation'),
  buildPlannerContextPresentation: (...args: unknown[]) => (
    mockBuildPlannerContextPresentation(...args)
  ),
}));
jest.mock('../../../hooks/usePlannerReads', () => ({
  usePlannerPageDetail: () => ({
    data: { blocks: [{
      id: 'project-context', pageId: '407c77c7-7d50-4f4a-b7c2-6faae9c704b4',
      parentId: null, positionKey: 'V', blockType: 'paragraph', text: '[[기반 준비]]',
      properties: {}, collapsed: false,
    }] },
    loading: false,
    error: null,
  }),
}));
jest.mock('../../../hooks/usePlannerActions', () => ({
  usePlannerActions: () => ({ createFolderSession: mockCreateFolderSession }),
}));
jest.mock('../../../hooks/useChatAttachments', () => ({
  useChatAttachments: () => ({
    attachments: [],
    uploading: false,
    attachmentsReady: true,
    pickAttachment: jest.fn(),
    uploadAttachment: jest.fn(),
    removeAttachment: jest.fn(),
    clearAttachments: jest.fn(),
  }),
}));
jest.mock('../../../lib/eas-observe-crash-reporting', () => ({
  reportSanitizedEasObserveError: (...args: unknown[]) => (
    mockReportSanitizedEasObserveError(...args)
  ),
}));
jest.mock('../../sheets/useNewSessionSelection', () => ({
  useNewSessionSelection: (input: unknown) => mockUseNewSessionSelection(input),
}));
jest.mock('../SessionSuccessionDiagnosticFallback', () => {
  const ReactModule = require('react');
  const actual = jest.requireActual('../SessionSuccessionDiagnosticFallback');
  return {
    ...actual,
    SessionSuccessionDiagnosticFallback: (props: unknown) => {
      if (mockDiagnosticFallbackShouldThrow) {
        throw new Error('diagnostic fallback render failed');
      }
      return ReactModule.createElement(actual.SessionSuccessionDiagnosticFallback, props);
    },
  };
});

import { SessionSuccessionSheet } from '../SessionSuccessionSheet';

const DIAGNOSTICS_KEY = 'soul-app.session-succession-diagnostics.v1';

beforeEach(async () => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  await AsyncStorage.clear();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockDiagnosticFallbackShouldThrow = false;
  mockCreateFolderSession.mockResolvedValue({ agentSessionId: 'diagnostic-session' });
  mockBuildPlannerContextPresentation.mockImplementation(() => {
    throw new Error('build 89 pre-POST context/default failure');
  });
});

test('100% 재현 조건은 매 진입마다 일반 폼이 아닌 진단 화면으로 격리된다', async () => {
  for (const expectedTitle of ['새 세션 시작 실패', '새 세션 시작 실패']) {
    const callsBeforeEntry = mockBuildPlannerContextPresentation.mock.calls.length;
    const screen = renderSheet();

    expect(screen.getByTestId('succession-diagnostic-fallback')).toBeTruthy();
    expect(screen.getByText(expectedTitle)).toBeTruthy();
    expect(screen.getByTestId('succession-diagnostic-submit')).toBeTruthy();
    expect(screen.queryByTestId('succession-recovery-mode')).toBeNull();
    expect(screen.queryByTestId('succession-selection-node')).toBeNull();
    expect(screen.queryByText('안전 모드로 열었습니다.')).toBeNull();
    expect(screen.queryByText('새 세션')).toBeNull();
    expect(screen.queryByPlaceholderText('이 세션에만 적용할 지침…')).toBeNull();
    screen.unmount();
    expect(mockBuildPlannerContextPresentation.mock.calls.length).toBeGreaterThan(callsBeforeEntry);
  }

  expect(mockUseNewSessionSelection).not.toHaveBeenCalled();
  expect(mockReportSanitizedEasObserveError).toHaveBeenCalledTimes(2);
  expect(mockReportSanitizedEasObserveError).toHaveBeenNthCalledWith(
    1,
    expect.any(Error),
    'session-succession-render',
  );
  await waitFor(async () => {
    const outbox = JSON.parse((await AsyncStorage.getItem(DIAGNOSTICS_KEY)) ?? '{}');
    expect(outbox.pending).toHaveLength(1);
    expect(outbox.pending[0]).toMatchObject({
      schemaVersion: 1,
      folderId: '05e70c70-578c-47e8-844e-5c436c78cd64',
      folderPageId: '05e70c70-578c-47e8-844e-5c436c78cd64',
      projectPageId: '407c77c7-7d50-4f4a-b7c2-6faae9c704b4',
      phase: 'render',
      error: { message: 'build 89 pre-POST context/default failure' },
    });
  });
}, 10_000);

test('진단 버튼은 업무 anchor와 구조화 진단 context를 실제 생성 payload 하나에 담는다', async () => {
  const onClose = jest.fn();
  const onCreated = jest.fn();
  const screen = renderSheet({ onClose, onCreated });
  const contextBuildsBeforeSubmit = mockBuildPlannerContextPresentation.mock.calls.length;

  await act(async () => { fireEvent.press(screen.getByTestId('succession-diagnostic-submit')); });

  expect(mockBuildPlannerContextPresentation).toHaveBeenCalledTimes(contextBuildsBeforeSubmit);
  expect(mockCreateFolderSession).toHaveBeenCalledTimes(1);
  const input = mockCreateFolderSession.mock.calls[0][0];
  expect(input).toMatchObject({
    folder: affectedFolder(),
    nodeId: 'eiaserinnys',
    agentId: 'seosoyoung_codex',
    needsPageAnchor: true,
    extraContextItems: [{
      key: 'planner-folder',
      label: '서소영 온디바이스 앱',
      content: {
        pageId: '05e70c70-578c-47e8-844e-5c436c78cd64',
        folderId: '05e70c70-578c-47e8-844e-5c436c78cd64',
      },
    }, {
      key: 'session_start_diagnostic',
      label: '새 세션 시작 오류 진단',
      content: {
        schemaVersion: 1,
        occurredAt: expect.any(String),
        phase: 'render',
        error: {
          message: 'build 89 pre-POST context/default failure',
          stack: expect.any(String),
          componentStack: expect.any(String),
        },
        scope: {
          folderId: '05e70c70-578c-47e8-844e-5c436c78cd64',
          folderPageId: '05e70c70-578c-47e8-844e-5c436c78cd64',
          projectPageId: '407c77c7-7d50-4f4a-b7c2-6faae9c704b4',
        },
        app: { version: '1.0.0', buildNumber: '89' },
        device: {
          platform: 'ios',
          platformVersion: '26.5.2',
          modelName: 'iPad',
          modelIdentifier: 'iPad17,2',
          interfaceIdiom: 'tablet',
        },
        screen: {
          visible: true,
          predecessorSessionId: null,
          folderBlockCount: 2,
          folderSessionCount: 0,
          targetSource: 'task-defaults',
          targetNodeId: 'eiaserinnys',
          targetAgentId: 'seosoyoung_codex',
          settingsNodeId: null,
        },
      },
    }],
  });
  expect(input.prompt).toContain('새 세션 시작 오류');
  expect(onCreated).toHaveBeenCalledWith('diagnostic-session');
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(await AsyncStorage.getItem(DIAGNOSTICS_KEY)).toBeNull();
});

test('전송 실패는 outbox를 보존하고 같은 화면의 재시도가 성공하면 정리한다', async () => {
  mockCreateFolderSession
    .mockRejectedValueOnce(new Error('network unavailable'))
    .mockResolvedValueOnce({ agentSessionId: 'retried-session' });
  const onCreated = jest.fn();
  const screen = renderSheet({ onCreated });

  await act(async () => { fireEvent.press(screen.getByTestId('succession-diagnostic-submit')); });
  expect(screen.getByText('network unavailable')).toBeTruthy();
  expect(screen.getByText('다시 시도')).toBeTruthy();
  await waitFor(async () => {
    const outbox = JSON.parse((await AsyncStorage.getItem(DIAGNOSTICS_KEY)) ?? '{}');
    expect(outbox.pending).toHaveLength(1);
  });

  await act(async () => { fireEvent.press(screen.getByTestId('succession-diagnostic-submit')); });
  expect(mockCreateFolderSession).toHaveBeenCalledTimes(2);
  expect(onCreated).toHaveBeenCalledWith('retried-session');
  expect(await AsyncStorage.getItem(DIAGNOSTICS_KEY)).toBeNull();
});

test('전송 중 중복 탭은 진단 세션을 하나만 만든다', async () => {
  const pending = deferred<{ agentSessionId: string }>();
  mockCreateFolderSession.mockReturnValue(pending.promise);
  const screen = renderSheet();

  fireEvent.press(screen.getByTestId('succession-diagnostic-submit'));
  fireEvent.press(screen.getByTestId('succession-diagnostic-submit'));
  expect(mockCreateFolderSession).toHaveBeenCalledTimes(1);

  await act(async () => { pending.resolve({ agentSessionId: 'single-session' }); });
});

test('정상 경로는 추가 지침 없이 초기 지시 첨부와 기본 담당 계산을 유지한다', () => {
  mockBuildPlannerContextPresentation.mockReturnValue({
    contexts: [],
    assignment: {
      agentId: 'seosoyoung_codex',
      nodeId: 'eiaserinnys',
      blockId: 'defaults',
      sourceLabel: '직접 지정',
    },
  });
  const screen = renderSheet();

  expect(screen.getByTestId('succession-header-title')).toBeTruthy();
  expect(screen.queryByTestId('succession-selection-node')).toBeNull();
  fireEvent.press(screen.getByTestId('succession-execution-disclosure'));
  expect(screen.getByTestId('succession-selection-node')).toBeTruthy();
  expect(screen.queryByPlaceholderText('이 세션에만 적용할 지침…')).toBeNull();
  expect(screen.getByTestId('succession-attachment-button')).toBeTruthy();
  expect(screen.queryByTestId('succession-diagnostic-fallback')).toBeNull();
  expect(mockUseNewSessionSelection).toHaveBeenLastCalledWith(expect.objectContaining({
    defaultNodeId: 'eiaserinnys',
    defaultAgentId: 'seosoyoung_codex',
  }));
});

test('진단 fallback 자체가 실패하면 plain emergency UI가 흡수하고 닫을 수 있다', async () => {
  mockDiagnosticFallbackShouldThrow = true;
  const onClose = jest.fn();

  const screen = renderSheet({ onClose });

  expect(screen.getByTestId('succession-emergency-fallback')).toBeTruthy();
  expect(screen.getByText('새 세션 화면을 안전하게 닫았습니다.')).toBeTruthy();
  expect(screen.getByText('diagnostic fallback render failed')).toBeTruthy();
  fireEvent.press(screen.getByTestId('succession-emergency-close'));
  expect(onClose).toHaveBeenCalledTimes(1);

  await waitFor(async () => {
    const outbox = JSON.parse((await AsyncStorage.getItem(DIAGNOSTICS_KEY)) ?? '{}');
    expect(outbox.pending).toHaveLength(2);
    expect(outbox.pending).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'render',
        error: expect.objectContaining({
          message: 'build 89 pre-POST context/default failure',
        }),
      }),
      expect.objectContaining({
        phase: 'fallback',
        error: expect.objectContaining({
          message: 'diagnostic fallback render failed',
        }),
      }),
    ]));
  });
  expect(mockReportSanitizedEasObserveError).toHaveBeenCalledTimes(2);
  expect(mockReportSanitizedEasObserveError).toHaveBeenNthCalledWith(
    1,
    expect.any(Error),
    'session-succession-render',
  );
  expect(mockReportSanitizedEasObserveError).toHaveBeenNthCalledWith(
    2,
    expect.any(Error),
    'session-succession-fallback',
  );
});

function renderSheet(overrides: {
  onClose?: jest.Mock;
  onCreated?: jest.Mock;
} = {}) {
  return render(<SessionSuccessionSheet
    api={null}
    folder={affectedFolder()}
    predecessorSessionId={null}
    visible
    onClose={overrides.onClose ?? jest.fn()}
    onCreated={overrides.onCreated ?? jest.fn()}
  />);
}

function affectedFolder(): PlannerFolder {
  return {
    page: {
      id: '05e70c70-578c-47e8-844e-5c436c78cd64',
      title: '서소영 온디바이스 앱',
      dailyDate: null,
      version: 19,
      archived: false,
      metadata: {},
      createdAt: '',
      updatedAt: '',
    },
    blocks: [
      block('description', 'paragraph', '온디바이스 LLM 앱 업무'),
      block('defaults', 'session_defaults', '', {
        agentId: 'seosoyoung_codex',
        nodeId: 'eiaserinnys',
        scope: 'session',
      }),
    ],
    folderId: '05e70c70-578c-47e8-844e-5c436c78cd64',
    folderSummary: null,
    status: 'open',
    assignee: '',
    contextCount: 1,
    progress: null,
    projectPageId: '407c77c7-7d50-4f4a-b7c2-6faae9c704b4',
    sessions: [],
    sessionIds: [],

  };
}

function block(
  id: string,
  blockType: string,
  text: string,
  properties: Record<string, unknown> = {},
) {
  return {
    id,
    pageId: '05e70c70-578c-47e8-844e-5c436c78cd64',
    parentId: null,
    positionKey: id,
    blockType,
    text,
    properties,
    collapsed: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
