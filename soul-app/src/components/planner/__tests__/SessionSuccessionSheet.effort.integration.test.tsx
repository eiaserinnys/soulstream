import React from 'react';
import { ActionSheetIOS } from 'react-native';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import type { PlannerFolder } from '../../../api/plannerTypes';
import { resetAuthScopeForTest } from '../../../lib/auth-scope';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { SessionSuccessionSheet } from '../SessionSuccessionSheet';

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
const mockCreateFolderSession = jest.fn();
jest.mock('../../../hooks/usePlannerActions', () => ({
  usePlannerActions: () => ({
    createFolderSession: (...args: unknown[]) => mockCreateFolderSession(...args),
  }),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0', ios: { buildNumber: '90' } } },
}));

const OPUS = {
  id: 'claude-opus',
  label: 'Claude - Opus',
  backend: 'claude',
  available: true,
  reason: null,
  reason_label: null,
  resets_at: null,
  usage_warning: false,
  supported_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  default_effort: 'xhigh',
};
const ASTRA = {
  ...OPUS,
  id: 'codex-6-astra',
  label: 'Codex - 6 Astra',
  backend: 'codex',
  supported_efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  default_effort: 'medium',
};
/** Kimi advertises nothing: the picker must not appear at all. */
const KIMI = {
  ...OPUS,
  id: 'kimi-3',
  label: 'Kimi - 3',
  supported_efforts: undefined,
  default_effort: undefined,
};

beforeEach(() => {
  useAuthStore.getState().setJwt('effort-user');
  resetAuthScopeForTest();
  useSettingsStore.setState({ nodeId: 'eiaserinnys' });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(
    () => undefined,
  );
  mockCreateFolderSession.mockReset();
  mockCreateFolderSession.mockResolvedValue({ agentSessionId: 's-new' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function makeApi(presets: unknown[]) {
  return {
    listNodes: jest.fn().mockResolvedValue({
      nodes: [{ nodeId: 'eiaserinnys', status: 'online', sessionCount: 1 }],
    }),
    listNodeAgents: jest.fn().mockResolvedValue({
      agents: [{
        id: 'seosoyoung-opus',
        name: 'roselin',
        portraitUrl: null,
        backend: 'claude',
        default_preset: 'claude-opus',
      }],
    }),
    listModelPresets: jest.fn().mockResolvedValue({ model_presets: presets }),
  } as unknown as ApiClient;
}

function folder(): PlannerFolder {
  return {
    page: {
      id: '1822c134-b7a7-403e-8d20-a9d87a0bbff7',
      title: '소울앱 오동작 수정',
      dailyDate: null,
      version: 1,
      archived: false,
      metadata: {},
      createdAt: '', updatedAt: '',
    },
    blocks: [{
      id: 'description',
      pageId: '1822c134-b7a7-403e-8d20-a9d87a0bbff7',
      parentId: null,
      positionKey: 'V',
      blockType: 'paragraph',
      text: 'iPad에서 새 세션 시작 시 앱이 종료된다.',
      properties: {},
      collapsed: false,
    }],
    folderId: '1822c134-b7a7-403e-8d20-a9d87a0bbff7',
    folderSummary: {
      id: '1822c134-b7a7-403e-8d20-a9d87a0bbff7',
      title: '소울앱 오동작 수정',
      status: 'open',
      archived: false,
      version: 1,
      itemCounts: {},
      itemTotal: 0,
      completedItemCount: 0,
      assignee: 'seosoyoung-opus',
    },
    status: 'open',
    assignee: 'seosoyoung-opus',
    contextCount: 0,
    progress: null,
    projectPageId: null,
    sessions: [],
    sessionIds: [],

  };
}

function renderSheet(api: ApiClient) {
  return render(
    <SessionSuccessionSheet
      api={api}
      folder={folder()}
      predecessorSessionId={null}
      visible
      onClose={jest.fn()}
      onCreated={jest.fn()}
    />,
  );
}

function lastSheetHandler() {
  return (ActionSheetIOS.showActionSheetWithOptions as jest.Mock).mock.calls.at(-1)?.[1];
}

function pickEffort(screen: ReturnType<typeof renderSheet>, index: number) {
  fireEvent.press(screen.getByTestId('succession-selection-effort'));
  lastSheetHandler()?.(index);
}

/** Index 0 is the `자동 선택` sentinel, so preset N is at index N+1. */
function pickModel(screen: ReturnType<typeof renderSheet>, index: number) {
  fireEvent.press(screen.getByTestId('succession-selection-model'));
  lastSheetHandler()?.(index);
}

function pickAgent(screen: ReturnType<typeof renderSheet>, index: number) {
  fireEvent.press(screen.getByTestId('succession-selection-agent'));
  lastSheetHandler()?.(index);
}

/** Row value assertion: SelectionRow renders label and value as sibling Texts. */
function effortValue(screen: ReturnType<typeof renderSheet>, text: string) {
  return within(screen.getByTestId('succession-selection-effort')).getByText(text);
}

/**
 * The task fixture carries no session_defaults, so agent and model are chosen
 * here — which is also what a user does on this sheet.
 */
async function renderWithModel(api: ApiClient, modelIndex = 1) {
  const screen = renderSheet(api);
  await waitFor(() => expect(api.listModelPresets).toHaveBeenCalled());
  pickAgent(screen, 1);
  pickModel(screen, modelIndex);
  return screen;
}

test('로딩이 끝나면 선택 preset의 광고된 기본값을 보여준다', async () => {
  const api = makeApi([OPUS]);
  const screen = renderSheet(api);

  // While the catalog is in flight nothing is advertised, so no picker.
  expect(screen.queryByTestId('succession-selection-effort')).toBeNull();

  await waitFor(() => expect(api.listModelPresets).toHaveBeenCalled());
  pickAgent(screen, 1);
  pickModel(screen, 1);

  await waitFor(() =>
    expect(screen.getByTestId('succession-selection-effort')).toBeTruthy());
  expect(effortValue(screen, 'X High')).toBeTruthy();
});

test('광고된 값만 선택지로 제시한다 (minimal 없음, 자동 sentinel 포함)', async () => {
  const screen = await renderWithModel(makeApi([OPUS]));
  await waitFor(() =>
    expect(screen.getByTestId('succession-selection-effort')).toBeTruthy());

  fireEvent.press(screen.getByTestId('succession-selection-effort'));
  expect(ActionSheetIOS.showActionSheetWithOptions).toHaveBeenLastCalledWith(
    expect.objectContaining({
      options: ['자동', 'Low', 'Medium', 'High', 'X High', 'Max', '취소'],
    }),
    expect.any(Function),
  );
});

test('effort를 광고하지 않는 preset에서는 행 자체가 없다', async () => {
  const api = makeApi([KIMI]);
  const screen = await renderWithModel(api);
  expect(screen.queryByTestId('succession-selection-effort')).toBeNull();
});

test('수동 선택은 그 세션에만 적용되고 생성 payload로 전달된다', async () => {
  const screen = await renderWithModel(makeApi([OPUS]));
  await waitFor(() =>
    expect(screen.getByTestId('succession-selection-effort')).toBeTruthy());

  pickEffort(screen, 1); // 'Low'
  await waitFor(() => expect(effortValue(screen, 'Low')).toBeTruthy());

  fireEvent.press(screen.getByTestId('succession-submit'));
  await waitFor(() => expect(mockCreateFolderSession).toHaveBeenCalled());
  expect(mockCreateFolderSession.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({ reasoningEffort: 'low' }),
  );
});

test('모델을 바꾸면 이전 수동값을 유지하지 않고 새 preset 기본값으로 리필한다', async () => {
  const screen = await renderWithModel(makeApi([OPUS, ASTRA]), 1);
  await waitFor(() =>
    expect(screen.getByTestId('succession-selection-effort')).toBeTruthy());

  pickEffort(screen, 1); // Opus 에서 'Low' 수동 선택
  await waitFor(() => expect(effortValue(screen, 'Low')).toBeTruthy());

  // Astra 로 전환. Astra 도 low 를 지원하지만 기본값 medium 이 적용되어야 한다.
  pickModel(screen, 2);

  await waitFor(() => expect(effortValue(screen, 'Medium')).toBeTruthy());
});

test('effort를 건드리지 않으면 payload에서 생략하여 노드가 preset 기본값을 적용한다', async () => {
  const screen = await renderWithModel(makeApi([OPUS]));
  await waitFor(() =>
    expect(screen.getByTestId('succession-selection-effort')).toBeTruthy());

  fireEvent.press(screen.getByTestId('succession-submit'));
  await waitFor(() => expect(mockCreateFolderSession).toHaveBeenCalled());
  expect(mockCreateFolderSession.mock.calls[0]?.[0]).not.toHaveProperty('reasoningEffort');
});

/**
 * Predecessor ran claude-opus at `ultra` — a level opus does not advertise (it
 * was recorded on a Codex preset). Node, agent and model all resolve from the
 * predecessor, so nothing is picked here: this is the state the user lands in.
 */
function renderInheritedUltra() {
  const withPredecessor = {
    ...folder(),
    sessions: [{
      agentSessionId: 'prev-1',
      folderId: null,
      displayName: null,
      nodeId: 'eiaserinnys',
      sessionType: 'claude',
      status: 'completed',
      agentId: 'seosoyoung-opus',
      modelPreset: 'claude-opus',
      reasoningEffort: 'ultra',
      predecessorSessionId: null,
      reviewState: 'not_required',
    }],
  } as unknown as PlannerFolder;
  return render(
    <SessionSuccessionSheet
      api={makeApi([OPUS])}
      folder={withPredecessor}
      predecessorSessionId="prev-1"
      visible
      onClose={jest.fn()}
      onCreated={jest.fn()}
    />,
  );
}

test('이 모델에서 쓸 수 없는 상속값은 생성을 막고 두 가지 해결책을 제시한다', async () => {
  const screen = renderInheritedUltra();

  // The inherited value survives the catalogue load — that is what makes this
  // state reachable at all — and is then reported as unusable.
  await waitFor(() => expect(effortValue(screen, 'Ultra')).toBeTruthy());
  await waitFor(() => expect(
    screen.getByText(
      '이어받은 추론 강도를 이 모델에서는 쓸 수 없습니다. 다른 강도를 고르거나 기본값으로 시작하세요.',
    ),
  ).toBeTruthy());

  fireEvent.press(screen.getByTestId('succession-submit'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(mockCreateFolderSession).not.toHaveBeenCalled();

  // Exit 1: choose a supported level.
  pickEffort(screen, 1);
  await waitFor(() => expect(effortValue(screen, 'Low')).toBeTruthy());
  fireEvent.press(screen.getByTestId('succession-submit'));
  await waitFor(() => expect(mockCreateFolderSession).toHaveBeenCalled());
  expect(mockCreateFolderSession.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({ reasoningEffort: 'low' }),
  );
});

test("쓸 수 없는 상속값은 '기본값 사용'으로 같은 모델을 유지한 채 생성할 수 있다", async () => {
  // Exit 2. Forcing a different model would make an otherwise valid choice
  // unusable just because the predecessor ran at a level it lacks.
  const screen = renderInheritedUltra();
  await waitFor(() => expect(
    screen.getByTestId('succession-effort-use-default'),
  ).toBeTruthy());
  fireEvent.press(screen.getByTestId('succession-effort-use-default'));

  await waitFor(() => expect(effortValue(screen, 'X High')).toBeTruthy());
  fireEvent.press(screen.getByTestId('succession-submit'));
  await waitFor(() => expect(mockCreateFolderSession).toHaveBeenCalled());
  const payload = mockCreateFolderSession.mock.calls[0]?.[0];
  // Effort omitted, so the node applies claude-opus's own default — on the model
  // the user actually kept.
  expect(payload).not.toHaveProperty('reasoningEffort');
  expect(payload).toEqual(expect.objectContaining({ modelPreset: 'claude-opus' }));
});
