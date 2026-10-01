import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import {
  projectSessionStory,
  SessionStoryPanel,
} from '../SessionStoryPanel';

function makeApi(
  getSessionStory: jest.Mock = jest.fn(),
): ApiClient {
  return { getSessionStory } as unknown as ApiClient;
}

const story = {
  highlight: '핵심 결정은 단일 정본으로 모으는 것이다.',
  narrative: '[T1] 세션 스토리 설계를 시작했다.',
  unfolded_turn_summaries: [
    {
      event_id: 20,
      turn_number: 2,
      content: 'API 계약을 확정했다.',
      turn_start_event_id: 11,
      final_response_event_id: 19,
      created_at: '2026-07-31T00:00:00.000Z',
      future_field: 'ignored',
    },
    {
      event_id: 30,
      turn_number: 3,
      content: '클라이언트 표시를 구현했다.',
      turn_start_event_id: 21,
      final_response_event_id: 29,
      created_at: '2026-07-31T00:01:00.000Z',
    },
  ],
  narrative_through_event_id: 10,
  fold_count: 1,
  updated_at: '2026-07-31T00:02:00.000Z',
  unknown_top_level_field: true,
};

test('접힌 상태에서는 fetch하지 않고 펼칠 때 한 번만 하이라이트와 전체 줄거리를 불러온다', async () => {
  const getSessionStory = jest.fn().mockResolvedValue(story);
  const screen = render(
    <SessionStoryPanel sessionId="session-1" api={makeApi(getSessionStory)} />,
  );

  expect(getSessionStory).not.toHaveBeenCalled();

  fireEvent.press(screen.getByLabelText('세션 스토리 펼치기'));

  await waitFor(() => {
    expect(screen.getByText('핵심 결정은 단일 정본으로 모으는 것이다.')).toBeTruthy();
  });
  expect(getSessionStory).toHaveBeenCalledTimes(1);
  expect(getSessionStory).toHaveBeenCalledWith('session-1');

  const orderedCopy = screen.getAllByTestId('session-story-copy');
  expect(orderedCopy.map((node) => node.props.children)).toEqual([
    '핵심 결정은 단일 정본으로 모으는 것이다.',
    '[T1] 세션 스토리 설계를 시작했다.',
    'API 계약을 확정했다.',
    '클라이언트 표시를 구현했다.',
  ]);

  fireEvent.press(screen.getByLabelText('세션 스토리 접기'));
  fireEvent.press(screen.getByLabelText('세션 스토리 펼치기'));
  expect(getSessionStory).toHaveBeenCalledTimes(1);
});

test('외부 열기 요청은 기존 패널을 펼치고 같은 요청을 한 번만 소비한다', async () => {
  const getSessionStory = jest.fn().mockResolvedValue(story);
  const onOpenRequestHandled = jest.fn();
  const api = makeApi(getSessionStory);
  const screen = render(
    <SessionStoryPanel
      sessionId="session-1"
      api={api}
      openRequestId={1}
      onOpenRequestHandled={onOpenRequestHandled}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText('핵심 결정은 단일 정본으로 모으는 것이다.')).toBeTruthy();
  });
  expect(getSessionStory).toHaveBeenCalledTimes(1);
  expect(onOpenRequestHandled).toHaveBeenCalledTimes(1);

  screen.rerender(
    <SessionStoryPanel
      sessionId="session-1"
      api={api}
      openRequestId={2}
      onOpenRequestHandled={onOpenRequestHandled}
    />,
  );
  await waitFor(() => {
    expect(onOpenRequestHandled).toHaveBeenCalledTimes(2);
  });
  expect(getSessionStory).toHaveBeenCalledTimes(1);
});

test('다른 세션의 외부 열기 요청은 이전 스토리를 재사용하지 않고 다시 조회한다', async () => {
  const getSessionStory = jest.fn(async (sessionId: string) => ({
    ...story,
    highlight: `${sessionId} story`,
  }));
  const api = makeApi(getSessionStory);
  const screen = render(
    <SessionStoryPanel
      sessionId="session-1"
      api={api}
      openRequestId={1}
    />,
  );
  await waitFor(() => {
    expect(screen.getByText('session-1 story')).toBeTruthy();
  });

  screen.rerender(
    <SessionStoryPanel
      sessionId="session-2"
      api={api}
      openRequestId={2}
    />,
  );
  await waitFor(() => {
    expect(screen.getByText('session-2 story')).toBeTruthy();
  });
  expect(getSessionStory.mock.calls).toEqual([
    ['session-1'],
    ['session-2'],
  ]);
});

test.each([
  ['404/미배포', null],
  ['digest 필드 null', {
    ...story,
    highlight: null,
  }],
] as const)('%s 응답은 오류 UI 없이 패널을 숨긴다', async (
  _label,
  response,
) => {
  const getSessionStory = jest.fn().mockResolvedValue(response);
  const screen = render(
    <SessionStoryPanel sessionId="session-1" api={makeApi(getSessionStory)} />,
  );

  fireEvent.press(screen.getByLabelText('세션 스토리 펼치기'));

  await waitFor(() => {
    expect(screen.queryByTestId('session-story-panel')).toBeNull();
  });
});

test('api가 없으면 패널을 표시하지 않는다', () => {
  const screen = render(
    <SessionStoryPanel sessionId="session-1" api={null} />,
  );

  expect(screen.queryByTestId('session-story-panel')).toBeNull();
});

test('예상하지 못한 digest 필드 타입은 개발에서 드러내고 프로덕션 투영에서는 숨긴다', () => {
  const malformed = {
    ...story,
    highlight: 42,
  };

  expect(() => projectSessionStory(malformed as never, true)).toThrow(
    /highlight\/narrative wire shape is invalid/,
  );
  expect(projectSessionStory(malformed as never, false)).toBeNull();
});
