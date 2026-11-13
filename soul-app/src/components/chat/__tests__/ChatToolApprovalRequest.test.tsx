import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import { createApiClient } from '../../../api/client';
import { ApiHttpError } from '../../../api/clientCore';
import { useChatStore } from '../../../store/chatStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { ChatToolApprovalRequest } from '../ChatToolApprovalRequest';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));

const mockApproveTool = jest.fn();
const mockRejectTool = jest.fn();
const mockResolveRealtimeToolApproval = jest.fn();

const APPROVAL_EVENT: SessionEvent = {
  id: 'approval-1',
  type: 'tool_approval_requested',
  data: {
    approval_id: 'approval-1',
    tool_name: '파일 읽기',
    agent_name: '예시 에이전트',
  },
} as unknown as SessionEvent;

function resetStores() {
  useChatStore.setState({
    eventsBySession: {},
    lastEventIdBySession: {},
    pendingFirstMessageBySession: {},
    pendingOptimisticBySession: {},
    streamingSlotsBySession: {},
    claudeRuntimeBySession: {},
  });
  useSettingsStore.setState({ serverUrl: 'https://server.test', serverType: 'orchestrator' });
}

function renderApproval() {
  return render(<ChatToolApprovalRequest event={APPROVAL_EVENT} sessionId="session-1" />);
}

async function press(screen: ReturnType<typeof renderApproval>, label: '승인' | '거부') {
  await act(async () => {
    fireEvent.press(screen.getByText(label));
    await Promise.resolve();
  });
}

describe('ChatToolApprovalRequest 실패 표시', () => {
  beforeEach(() => {
    resetStores();
    mockApproveTool.mockReset().mockResolvedValue({ ok: true, status: 200 });
    mockRejectTool.mockReset().mockResolvedValue({ ok: true, status: 200 });
    mockResolveRealtimeToolApproval.mockReset().mockResolvedValue({ status: 200 });
    (createApiClient as jest.Mock).mockReturnValue({
      approveTool: mockApproveTool,
      rejectTool: mockRejectTool,
      resolveRealtimeToolApproval: mockResolveRealtimeToolApproval,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('승인 실패 응답이면 선택을 되돌리고 버튼 아래에 알린다', async () => {
    mockApproveTool.mockResolvedValueOnce({ ok: false, status: 409 });
    const screen = renderApproval();

    await press(screen, '승인');

    await waitFor(() => expect(screen.getByTestId('tool-approval-error')).toBeTruthy());
    expect(screen.getByTestId('tool-approval-error').props.children)
      .toBe('이미 끝난 요청이라 보내지 못했습니다.');
    expect(screen.getByText('승인')).toBeTruthy();
  });

  it('거절 요청이 예외로 끝나면 연결 실패를 알린다', async () => {
    mockRejectTool.mockRejectedValueOnce(new Error('network down'));
    const screen = renderApproval();

    await press(screen, '거부');

    await waitFor(() => expect(screen.getByTestId('tool-approval-error')).toBeTruthy());
    expect(screen.getByTestId('tool-approval-error').props.children)
      .toBe('연결하지 못해 보내지 못했습니다. 다시 눌러 주세요.');
  });

  it('503 응답은 연결 실패로 알린다', async () => {
    mockApproveTool.mockRejectedValueOnce(new ApiHttpError('unavailable', 503, ''));
    const screen = renderApproval();

    await press(screen, '승인');

    await waitFor(() => expect(screen.getByTestId('tool-approval-error')).toBeTruthy());
    expect(screen.getByTestId('tool-approval-error').props.children)
      .toBe('연결하지 못해 보내지 못했습니다. 다시 눌러 주세요.');
  });

  it('다시 누르면 이전 실패 문구를 지운다', async () => {
    mockApproveTool.mockResolvedValueOnce({ ok: false, status: 500 });
    const screen = renderApproval();
    await press(screen, '승인');
    await waitFor(() => expect(screen.getByTestId('tool-approval-error')).toBeTruthy());

    await press(screen, '승인');

    expect(screen.queryByTestId('tool-approval-error')).toBeNull();
  });

  it('성공하면 실패 문구 없이 처리 완료를 보인다', async () => {
    const screen = renderApproval();

    await press(screen, '승인');

    await waitFor(() => expect(screen.getByText('승인됨')).toBeTruthy());
    expect(screen.queryByTestId('tool-approval-error')).toBeNull();
  });
});
