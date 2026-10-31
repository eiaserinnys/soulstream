import React from 'react';
import { Platform } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { FloatingSessionComposer } from '../FloatingSessionComposer';

jest.mock('../TodayCardComposer', () => ({
  TodayCardComposer: ({ onCollapse, onCreated }: { onCollapse(): void; onCreated(id: string): void }) => {
    const [attached, setAttached] = require('react').useState(false);
    const { Text: MockText } = require('react-native');
    return <><MockText onPress={onCollapse}>접기</MockText><MockText onPress={() => setAttached(true)}>첨부</MockText>
      {attached ? <MockText>첨부 유지</MockText> : null}<MockText onPress={() => onCreated('session')}>생성</MockText></>;
  },
}));

test('새 대화를 펼치고 접거나 생성하면 버튼으로 돌아간다', () => {
  const created = jest.fn();
  const screen = render(<FloatingSessionComposer api={null} onCoveredHeightChange={() => {}} onSessionCreated={created} />);
  expect(screen.getByTestId('home-session-composer-trigger')).toBeTruthy();
  expect(screen.getByTestId('home-session-composer-trigger-surface')).toBeTruthy();
  expect(screen.queryByText('접기')).toBeNull();
  fireEvent.press(screen.getByTestId('home-session-composer-trigger'));
  fireEvent.press(screen.getByText('첨부'));
  fireEvent.press(screen.getByText('접기'));
  fireEvent.press(screen.getByTestId('home-session-composer-trigger'));
  expect(screen.getByText('첨부 유지')).toBeTruthy();
  fireEvent.press(screen.getByText('생성'));
  expect(created).toHaveBeenCalledWith('session');
  expect(screen.getByTestId('home-session-composer-trigger')).toBeTruthy();
});

test('안드로이드에서는 기존 입력창을 바로 보여 준다', () => {
  const original = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  try {
    const screen = render(<FloatingSessionComposer api={null} onCoveredHeightChange={() => {}} />);
    expect(screen.queryByTestId('home-session-composer-trigger')).toBeNull();
    expect(screen.getByText('첨부')).toBeTruthy();
  } finally {
    Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
  }
});
