import React from 'react';
import { ActionSheetIOS, StyleSheet } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import type { PlannerFolder } from '../../../api/plannerTypes';
import { resetAuthScopeForTest } from '../../../lib/auth-scope';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { AppGlassCard } from '../../AppGlassCard';

let mockDimensions = { width: 1024, height: 1366, scale: 2, fontScale: 1 };

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
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

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: { version: '1.0.0', ios: { buildNumber: '90' } },
    platform: {
      ios: {
        buildNumber: '90',
        systemVersion: '26.5.2',
        model: 'iPad',
        platform: 'iPad17,2',
        userInterfaceIdiom: 'tablet',
      },
    },
  },
}));
jest.mock('../../../hooks/usePlannerReads', () => ({
  usePlannerPageDetail: () => ({ data: { blocks: [] }, loading: false, error: null }),
}));
jest.mock('../../../hooks/usePlannerActions', () => ({
  usePlannerActions: () => ({ createFolderSession: jest.fn() }),
}));

import { SessionSuccessionSheet } from '../SessionSuccessionSheet';

beforeEach(() => {
  mockDimensions = { width: 1024, height: 1366, scale: 2, fontScale: 1 };
  useAuthStore.getState().setJwt('ipad-user');
  resetAuthScopeForTest();
  useSettingsStore.setState({ nodeId: 'eiaserinnys' });
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test.each([
  ['컴팩트 540pt', { width: 540, height: 1024, scale: 2, fontScale: 1 }, 52, 8, 17],
  ['넓은 1024pt', { width: 1024, height: 1366, scale: 2, fontScale: 1 }, 60, 12, 18],
] as const)('iPad %s 전체 새 세션 프레임에서 모델 행과 비활성 사유가 유지된다', async (
  _case,
  dimensions,
  headerMinHeight,
  selectionGap,
  chatBodyFontSize,
) => {
  mockDimensions = dimensions;
  const api = {
    listNodes: jest.fn().mockResolvedValue({
      nodes: [{ nodeId: 'eiaserinnys', status: 'online', sessionCount: 12 }],
    }),
    listNodeAgents: jest.fn().mockResolvedValue({
      agents: [{
        id: 'seosoyoung-opus',
        name: null,
        portraitUrl: '/api/agents/seosoyoung-opus/portrait',
        max_turns: null,
        backend: 'server-backend',
        default_preset: 'server-limited',
      }],
    }),
    listModelPresets: jest.fn().mockResolvedValue({
      model_presets: [{
        id: 'server-limited',
        label: '서버 모델',
        backend: 'server-backend',
        available: false,
        reason: 'server-reason',
        reason_label: '서버 사용량 제한',
        resets_at: '2030-01-02T03:04:00.000Z',
        usage_warning: false,
      }],
    }),
  } as unknown as ApiClient;

  const screen = render(
    <AppGlassCard role="glassSoft">
      <SessionSuccessionSheet
        api={api}
        folder={affectedFolder()}
        predecessorSessionId={null}
        visible
        onClose={jest.fn()}
        onCreated={jest.fn()}
      />
    </AppGlassCard>,
  );

  expect(screen.getByTestId('succession-safe-area')).toBeTruthy();
  expect(screen.getByTestId('succession-header')).toBeTruthy();
  expect(screen.getByTestId('succession-header-title')).toBeTruthy();
  expect(screen.getByTestId('succession-keyboard')).toBeTruthy();
  expect(screen.getByTestId('succession-content')).toBeTruthy();
  expect(screen.getByTestId('succession-content').props.automaticallyAdjustKeyboardInsets).toBe(true);
  expect(screen.getByTestId('succession-selection-group')).toBeTruthy();
  expect(screen.getByTestId('succession-context-group')).toBeTruthy();
  expect(screen.getByTestId('succession-initial-instruction-group')).toBeTruthy();
  expect(screen.queryByTestId('succession-diagnostic-fallback')).toBeNull();
  const headerStyle = StyleSheet.flatten(screen.getByTestId('succession-header').props.style);
  const nodeStyle = StyleSheet.flatten(screen.getByTestId('succession-selection-node').props.style);
  const agentStyle = StyleSheet.flatten(screen.getByTestId('succession-selection-agent').props.style);
  const modelStyle = StyleSheet.flatten(screen.getByTestId('succession-selection-model').props.style);
  const initialInputStyle = StyleSheet.flatten(
    screen.getByPlaceholderText('세션을 시작하자마자 수행할 지시…').props.style,
  );
  expect(headerStyle).toEqual(expect.objectContaining({ minHeight: headerMinHeight }));
  expect(headerStyle.height).toBeUndefined();
  expect(modelStyle).toEqual(nodeStyle);
  expect(modelStyle).toEqual(agentStyle);
  expect(modelStyle).toEqual(expect.objectContaining({
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: selectionGap,
    paddingHorizontal: 16,
  }));
  expect(modelStyle.height).toBeUndefined();
  expect(initialInputStyle).toEqual(expect.objectContaining({
    fontSize: chatBodyFontSize,
    lineHeight: chatBodyFontSize * 1.3,
  }));
  await waitFor(() => expect(api.listNodeAgents).toHaveBeenCalledWith('eiaserinnys'));
  await waitFor(() => expect(api.listModelPresets).toHaveBeenCalledWith('eiaserinnys'));

  fireEvent.press(screen.getByTestId('succession-selection-agent'));
  expect(ActionSheetIOS.showActionSheetWithOptions).toHaveBeenLastCalledWith(
    expect.objectContaining({
      options: ['자동 선택', '(이름 없는 에이전트)', '취소'],
    }),
    expect.any(Function),
  );

  fireEvent.press(screen.getByTestId('succession-selection-model'));
  expect(ActionSheetIOS.showActionSheetWithOptions).toHaveBeenLastCalledWith(
    expect.objectContaining({
      options: [
        '자동 선택',
        expect.stringMatching(/^서버 모델 \(서버 사용량 제한\) · \d{2}:\d{2} 해제$/),
        '취소',
      ],
      disabledButtonIndices: [1],
    }),
    expect.any(Function),
  );
});

function affectedFolder(): PlannerFolder {
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
