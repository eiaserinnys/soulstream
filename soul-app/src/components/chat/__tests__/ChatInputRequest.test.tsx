import React from 'react';
import {
  act,
  fireEvent,
  render,
  waitFor,
} from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import { createApiClient } from '../../../api/client';
import { useChatStore } from '../../../store/chatStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { EventRenderer } from '../../events/EventRenderer';
import { ChatInputRequest } from '../ChatInputRequest';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

const mockRespond = jest.fn();
let mockTimerExpired = false;

jest.mock('../../../api/client', () => ({
  createApiClient: jest.fn(),
}));

jest.mock('../../../hooks/useInputRequestTimer', () => ({
  useInputRequestTimer: () => ({
    remainingSec: mockTimerExpired ? 0 : 299,
    isExpired: mockTimerExpired,
  }),
}));

const LIVE_PAYLOAD = {
  type: 'input_request',
  request_id: '34d824962786',
  tool_use_id: 'toolu_013RsQc4nrJPpeegwmvy1in6',
  started_at: 1784963321.14,
  timeout_sec: 300,
  timestamp: 1784963321.14,
  questions: [
    {
      header: '크래시 시점',
      question: '크래시가 정확히 어느 순간에 일어났습니까?',
      multiSelect: false,
      options: [
        {
          label: '"새 세션" 버튼을 누른 직후',
          description: '새 세션 시트가 뜨려는 순간 죽는다.',
        },
        {
          label: '시트는 떴고, "시작"을 누를 때',
          description: '노드·에이전트를 고르고 시작을 누르면 죽는다.',
        },
        {
          label: '업무 카드를 여는 순간',
          description: '업무 워크스페이스 진입만으로 죽는다.',
        },
        {
          label: '매번 다르다 / 확실치 않다',
          description: '일관되지 않거나 기억이 불확실하다.',
        },
      ],
    },
    {
      header: '재현 조건',
      question: '재현 빈도와 이전 빌드 상태를 알려주시겠습니까?',
      multiSelect: false,
      options: [
        {
          label: '항상 죽는다 (빌드 90부터)',
          description: '빌드 90에서 새로 생겼고 100% 재현된다.',
        },
        {
          label: '항상 죽는다 (이전 빌드도 그랬다)',
          description: '빌드 89 이하에서도 같은 증상이 있었다.',
        },
        {
          label: '가끔 죽는다',
          description: '같은 조작이 성공할 때도 있다.',
        },
        {
          label: '오늘 처음 겪었다',
          description: '빈도는 아직 모른다.',
        },
      ],
    },
  ],
} as const;

function inputRequestEvent(
  payload: Record<string, unknown> = LIVE_PAYLOAD as unknown as Record<string, unknown>,
): SessionEvent {
  return {
    id: '712',
    type: 'input_request',
    data: payload,
  };
}

function resetStores() {
  useChatStore.setState({
    eventsBySession: {},
    lastEventIdBySession: {},
    pendingFirstMessageBySession: {},
    pendingOptimisticBySession: {},
    streamingSlotsBySession: {},
    claudeRuntimeBySession: {},
  });
  useSettingsStore.setState({
    serverUrl: 'https://server.test',
    serverType: 'orchestrator',
  });
}

describe('ChatInputRequest', () => {
  beforeEach(() => {
    resetStores();
    mockTimerExpired = false;
    mockRespond.mockReset().mockResolvedValue({ ok: true, status: 200 });
    (createApiClient as jest.Mock).mockReturnValue({ respond: mockRespond });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('실측 payload의 모든 질문과 모든 옵션을 렌더한다', () => {
    const screen = render(
      <ChatInputRequest event={inputRequestEvent()} sessionId="session-1" />,
    );

    for (const question of LIVE_PAYLOAD.questions) {
      expect(screen.getByText(question.question)).toBeTruthy();
      for (const option of question.options) {
        expect(screen.getByText(option.label)).toBeTruthy();
      }
    }
  });

  it('세션 메타데이터가 아직 없어도 route sessionId로 옵션을 렌더한다', () => {
    const Renderer = EventRenderer as React.ComponentType<any>;
    const screen = render(
      <Renderer event={inputRequestEvent()} sessionId="session-1" />,
    );

    expect(
      screen.getByText('"새 세션" 버튼을 누른 직후'),
    ).toBeTruthy();
  });

  it('여러 질문의 답을 모두 모아 한 요청으로 전송한다', async () => {
    const screen = render(
      <ChatInputRequest event={inputRequestEvent()} sessionId="session-1" />,
    );

    fireEvent.press(screen.getByTestId('input-request-option-0-0'));
    fireEvent.press(screen.getByTestId('input-request-option-1-2'));
    expect(mockRespond).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('input-request-submit'));

    await waitFor(() => {
      expect(mockRespond).toHaveBeenCalledWith(
        'session-1',
        '34d824962786',
        {
          '크래시가 정확히 어느 순간에 일어났습니까?':
            '"새 세션" 버튼을 누른 직후',
          '재현 빈도와 이전 빌드 상태를 알려주시겠습니까?':
            '가끔 죽는다',
        },
      );
    });
  });

  it('multiSelect 질문은 여러 옵션을 유지하고 체크박스로 구분한다', async () => {
    const event = inputRequestEvent({
      ...LIVE_PAYLOAD,
      questions: [
        {
          header: '복수 선택',
          question: '필요한 항목을 모두 고르세요.',
          multiSelect: true,
          options: [
            { label: '로그', description: '로그를 수집합니다.' },
            { label: '스크린샷', description: '화면을 캡처합니다.' },
          ],
        },
      ],
    });
    const screen = render(
      <ChatInputRequest event={event} sessionId="session-1" />,
    );

    const first = screen.getByTestId('input-request-option-0-0');
    const second = screen.getByTestId('input-request-option-0-1');
    expect(first.props.accessibilityRole).toBe('checkbox');

    fireEvent.press(first);
    fireEvent.press(second);
    expect(mockRespond).not.toHaveBeenCalled();
    expect(
      screen.getByTestId('input-request-option-0-0').props.accessibilityState,
    ).toMatchObject({ checked: true });
    expect(
      screen.getByTestId('input-request-option-0-1').props.accessibilityState,
    ).toMatchObject({ checked: true });

    fireEvent.press(screen.getByTestId('input-request-submit'));

    await waitFor(() => {
      expect(mockRespond).toHaveBeenCalledWith(
        'session-1',
        '34d824962786',
        { '필요한 항목을 모두 고르세요.': '로그, 스크린샷' },
      );
    });
  });

  it('옵션 preview를 줄바꿈과 공백을 보존하는 비교 영역으로 표시한다', () => {
    const preview = '┌─ A ─┐\\n│ foo │\\n└─────┘';
    const event = inputRequestEvent({
      ...LIVE_PAYLOAD,
      questions: [
        {
          question: '구조를 선택하세요.',
          multiSelect: false,
          options: [{ label: 'A안', description: '간결함', preview }],
        },
      ],
    });
    const screen = render(
      <ChatInputRequest event={event} sessionId="session-1" />,
    );

    expect(screen.getByTestId('input-request-preview-0-0')).toHaveTextContent(
      preview,
    );
  });

  it('4xx 응답 실패를 인라인 접근성 alert와 로그로 드러내고 재시도를 허용한다', async () => {
    mockRespond.mockResolvedValue({ ok: false, status: 400 });
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const event = inputRequestEvent({
      ...LIVE_PAYLOAD,
      questions: [
        {
          question: '계속할까요?',
          multiSelect: false,
          options: [{ label: '계속', description: '작업을 계속합니다.' }],
        },
      ],
    });
    const screen = render(
      <ChatInputRequest event={event} sessionId="session-1" />,
    );

    fireEvent.press(screen.getByTestId('input-request-option-0-0'));

    const error = await screen.findByTestId('input-request-error');
    expect(error.props.accessibilityRole).toBe('alert');
    expect(error).toHaveTextContent(/응답을 보내지 못했습니다/);
    expect(consoleError).toHaveBeenCalled();
    expect(
      screen.getByTestId('input-request-option-0-0').props.accessibilityState,
    ).toMatchObject({ disabled: false });
  });

  it('네트워크 예외도 인라인 접근성 alert와 로그로 드러내고 재시도를 허용한다', async () => {
    mockRespond.mockRejectedValue(new Error('network unavailable'));
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const event = inputRequestEvent({
      ...LIVE_PAYLOAD,
      questions: [
        {
          question: '계속할까요?',
          multiSelect: false,
          options: [{ label: '계속', description: '작업을 계속합니다.' }],
        },
      ],
    });
    const screen = render(
      <ChatInputRequest event={event} sessionId="session-1" />,
    );

    fireEvent.press(screen.getByTestId('input-request-option-0-0'));

    const error = await screen.findByTestId('input-request-error');
    expect(error.props.accessibilityRole).toBe('alert');
    expect(error).toHaveTextContent(/응답을 보내지 못했습니다/);
    expect(consoleError).toHaveBeenCalledWith(
      '[ChatInputRequest] 응답 전송 실패',
      expect.objectContaining({
        reason: 'network_error',
        error: 'network unavailable',
      }),
    );
    expect(
      screen.getByTestId('input-request-option-0-0').props.accessibilityState,
    ).toMatchObject({ disabled: false });
  });

  it('서버 응답 완료와 타이머 만료 상태를 각각 잠근다', () => {
    const event = inputRequestEvent({
      ...LIVE_PAYLOAD,
      questions: [
        {
          question: '계속할까요?',
          multiSelect: false,
          options: [{ label: '계속' }],
        },
      ],
    });
    const screen = render(
      <ChatInputRequest event={event} sessionId="session-1" />,
    );

    act(() => {
      useChatStore.getState().mergeEvents('session-1', [
        {
          id: '713',
          type: 'input_request_responded',
          data: { request_id: '34d824962786' },
        },
      ]);
    });
    expect(screen.getByText(/응답 완료/)).toBeTruthy();

    act(() => {
      useChatStore.setState({ eventsBySession: {} });
    });
    mockTimerExpired = true;
    screen.rerender(
      <ChatInputRequest event={{ ...event }} sessionId="session-1" />,
    );
    expect(screen.getByText(/시간 초과/)).toBeTruthy();
  });
});
