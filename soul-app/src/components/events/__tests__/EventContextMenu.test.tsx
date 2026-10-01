jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(() => Promise.resolve()),
}));

import React from 'react';
import { ActionSheetIOS, Text } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import type { SessionEvent } from '../../../api/types';
import {
  createEventActionSheetOptions,
  createEventMenuActions,
  EventContextMenu,
} from '../EventContextMenu';

const showActionSheetMock = jest.fn();
(ActionSheetIOS as any).showActionSheetWithOptions = showActionSheetMock;

function event(
  type: SessionEvent['type'] = 'assistant_message',
  data: Record<string, unknown> = { content: '메시지' },
): SessionEvent {
  return { id: 'event-1', type, data };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('EventContextMenu', () => {
  test('메시지 메뉴 순서는 내용 복사, 선택하기, 이벤트 주소 복사다', () => {
    const actions = createEventMenuActions(
      'session-1',
      event(),
      undefined,
      jest.fn(),
    );

    expect(actions.map((action) => action.text)).toEqual([
      '내용 복사',
      '선택하기',
      '이벤트 주소 복사',
    ]);
  });

  test('내용 복사는 선택 진입과 분리된 기존 clipboard 경로를 유지한다', async () => {
    const actions = createEventMenuActions(
      'session-1',
      event(),
      undefined,
      jest.fn(),
    );

    await actions[0].run();
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('메시지');
  });

  test('빈 본문에는 선택하기를, live-only 이벤트에는 주소 복사를 넣지 않는다', () => {
    expect(
      createEventMenuActions(
        'session-1',
        event('assistant_message', { content: '   ', _live_only: true }),
        undefined,
        jest.fn(),
      ).map((action) => action.text),
    ).toEqual(['내용 복사']);
  });

  test('iPad action sheet options에 message anchor를 보존한다', () => {
    const actions = createEventMenuActions(
      'session-1',
      event(),
      undefined,
      jest.fn(),
    );

    expect(createEventActionSheetOptions(actions, 77)).toMatchObject({
      anchor: 77,
      options: ['내용 복사', '선택하기', '이벤트 주소 복사', '취소'],
      cancelButtonIndex: 3,
    });
  });

  test('한 번의 롱프레스는 ActionSheetIOS를 한 번만 연다', () => {
    const { getByTestId } = render(
      <EventContextMenu
        sessionId="session-1"
        event={event()}
        onSelectText={jest.fn()}
      >
        <Text>메시지</Text>
      </EventContextMenu>,
    );

    fireEvent(getByTestId('event-context-menu-anchor'), 'longPress');
    expect(showActionSheetMock).toHaveBeenCalledTimes(1);
  });

  test('선택하기 action은 해당 메시지의 선택 모델을 전달한다', async () => {
    const onSelectText = jest.fn();
    const { getByTestId } = render(
      <EventContextMenu
        sessionId="session-1"
        event={event()}
        onSelectText={onSelectText}
      >
        <Text>메시지</Text>
      </EventContextMenu>,
    );

    fireEvent(getByTestId('event-context-menu-anchor'), 'longPress');
    const callback = showActionSheetMock.mock.calls[0][1];
    callback(1);

    await waitFor(() => {
      expect(onSelectText).toHaveBeenCalledWith({
        kind: 'markdown',
        text: '메시지',
      });
    });
  });
});
