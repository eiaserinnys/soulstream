import React from 'react';
import { render } from '@testing-library/react-native';
import { ROOT_TAB_ORDER } from '../tabContract';
import {
  PhonePanelHistoryProvider,
  createPhonePanelHistory,
  type PhonePanelHistory,
  usePhonePanelHistory,
} from '../phonePanelHistory';

const NON_CHAT_TABS = ROOT_TAB_ORDER.filter((name) => name !== 'ChatTab');

describe('phone panel history', () => {
  test.each(NON_CHAT_TABS)('%s에서 ChatTab으로 들어오면 정확한 직전 root tab을 반환한다', (name) => {
    const history = createPhonePanelHistory();

    history.recordFocus(name);
    history.recordFocus('ChatTab');

    expect(history.getReturnTab()).toBe(name);
  });

  test('ChatTab 재포커스와 같은 Chat stack 안의 세션 전환은 직전 panel을 덮지 않는다', () => {
    const history = createPhonePanelHistory();

    history.recordFocus('FolderTab');
    history.recordFocus('ChatTab');
    history.recordFocus('ChatTab');

    expect(history.getReturnTab()).toBe('FolderTab');
  });

  test('이력 없는 최초 ChatTab 진입은 FeedTab으로 귀결한다', () => {
    const history = createPhonePanelHistory();

    history.recordFocus('ChatTab');

    expect(history.getReturnTab()).toBe('FeedTab');
  });

  test('Provider remount는 이전 인스턴스의 복귀 panel을 버리고 FeedTab으로 초기화한다', () => {
    let captured: PhonePanelHistory | null = null;

    function Capture() {
      captured = usePhonePanelHistory();
      return null;
    }

    const screen = render(
      <PhonePanelHistoryProvider key="account-a">
        <Capture />
      </PhonePanelHistoryProvider>,
    );
    const first = captured!;
    first.recordFocus('FolderTab');
    first.recordFocus('ChatTab');
    expect(first.getReturnTab()).toBe('FolderTab');

    screen.rerender(
      <PhonePanelHistoryProvider key="account-b">
        <Capture />
      </PhonePanelHistoryProvider>,
    );

    expect(captured).not.toBe(first);
    expect(captured!.getReturnTab()).toBe('FeedTab');
  });
});
