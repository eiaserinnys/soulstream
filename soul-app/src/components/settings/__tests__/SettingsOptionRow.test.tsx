import React from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { SettingsOptionRow, type SettingsOption } from '../SettingsOptionRow';
import { PHONE_CHAT_TYPOGRAPHY, PHONE_FOUNDATION, TABLET_CHAT_TYPOGRAPHY } from '../../../theme';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

test('긴 목록 검색은 저장된 누락 값과 가용성 사유를 보존하며 선택을 임의 차단하지 않는다', () => {
  const onSelect = jest.fn();
  const screen = render(<SettingsOptionRow label="모델" selected="saved-model" options={Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, label: `모델 ${i}`, available: false, reason: '한도 소진' }))} emptyLabel="없음" onSelect={onSelect}/>);
  expect(screen.getByText(/saved-model/)).toBeTruthy();
  const trigger = screen.getByLabelText('모델: saved-model');
  const frame = StyleSheet.flatten(typeof trigger.props.style === 'function' ? trigger.props.style({ pressed: false }) : trigger.props.style);
  expect(frame.minWidth).toBeGreaterThanOrEqual(44);
  expect(frame.minHeight).toBeGreaterThanOrEqual(44);
  fireEvent.press(trigger);
  fireEvent.changeText(screen.getByLabelText('모델 검색'), '모델 3');
  expect(screen.queryByText('모델 2')).toBeNull();
  fireEvent.press(screen.getByLabelText('모델 3 · 한도 소진'));
  expect(onSelect).toHaveBeenCalledWith('m3');
});

test('칩과 긴 목록의 사유는 이름보다 meta 위계로 표시한다', () => {
  const reason = '7일 한도 거부 중 · 10/15 13:19 해제';
  const screen = render(<SettingsOptionRow label="모델" selected="rejected" options={[
    { id: 'rejected', label: 'Claude - Fable', available: false, reason },
    { id: 'normal', label: 'Codex - Sol', available: true },
  ]} emptyLabel="없음" onSelect={jest.fn()}/>);

  expect(StyleSheet.flatten(screen.getByText(reason, { exact: true }).props.style))
    .toMatchObject(PHONE_FOUNDATION.typography.meta);
});

test('긴 목록의 reason과 접힌 선택 버튼은 사유에 meta 위계를 쓴다', () => {
  const options: SettingsOption[] = [
    { id: 'rejected', label: 'Claude - Fable', available: false, reason: '7일 한도 거부 중 · 10/15 13:19 해제' },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, label: `모델 ${i}`, available: true })),
  ];
  const screen = render(<SettingsOptionRow label="모델" selected="rejected" options={options} emptyLabel="없음" onSelect={jest.fn()}/>);
  const trigger = screen.getByLabelText('모델: Claude - Fable');
  const collapsedReason = screen.UNSAFE_getAllByType(Text)
    .find(node => node.props.children === options[0].reason)!;
  expect(StyleSheet.flatten(collapsedReason.props.style))
    .toMatchObject(PHONE_FOUNDATION.typography.meta);

  fireEvent.press(trigger);
  const reasonTexts = screen.UNSAFE_getAllByType(Text)
    .filter(node => node.props.children === options[0].reason);
  expect(reasonTexts).toHaveLength(2);
  const popupReason = reasonTexts[1];
  expect(StyleSheet.flatten(popupReason.props.style))
    .toMatchObject(PHONE_FOUNDATION.typography.meta);
});

test('채팅용 짧은 선택지는 본문 크기와 presentation 버튼으로 선택 상태를 전달한다', () => {
  const onSelect = jest.fn();
  const screen = render(<SettingsOptionRow variant="chat" presentation="manuscript" label="결제 주기" selected="monthly" options={[
    { id: 'monthly', label: '월간' },
    { id: 'annual', label: '연간' },
  ]} emptyLabel="없음" onSelect={onSelect}/>);

  const selected = screen.getByLabelText('결제 주기: 월간');
  expect(selected.props.accessibilityState).toMatchObject({ selected: true });
  expect([PHONE_CHAT_TYPOGRAPHY.body, TABLET_CHAT_TYPOGRAPHY.body])
    .toContain(StyleSheet.flatten(screen.getByText('월간').props.style).fontSize);
  const styleOf = (button: typeof selected) => StyleSheet.flatten(
    typeof button.props.style === 'function' ? button.props.style({ pressed: false }) : button.props.style,
  );
  const selectedStyle = styleOf(selected);
  const unselectedStyle = styleOf(screen.getByLabelText('결제 주기: 연간'));
  for (const property of ['width', 'height', 'minWidth', 'minHeight', 'paddingHorizontal', 'paddingVertical', 'borderWidth', 'borderColor'] as const) {
    expect(selectedStyle[property]).toBe(unselectedStyle[property]);
  }
  fireEvent.press(screen.getByLabelText('결제 주기: 연간'));
  expect(onSelect).toHaveBeenCalledWith('annual');
});

test('채팅용 긴 선택은 본문 크기 검색 입력을 쓰고 선택 뒤 modal을 닫는다', () => {
  const onSelect = jest.fn();
  const options = Array.from({ length: 6 }, (_, index) => ({
    id: `plan-${index + 1}`,
    label: `요금제 ${index + 1}`,
  }));
  const screen = render(<SettingsOptionRow variant="chat" presentation="default" label="요금제" selected="plan-1" options={options} emptyLabel="없음" onSelect={onSelect}/>);

  fireEvent.press(screen.getByLabelText('요금제: 요금제 1'));
  const search = screen.getByLabelText('요금제 검색');
  expect([PHONE_CHAT_TYPOGRAPHY.body, TABLET_CHAT_TYPOGRAPHY.body])
    .toContain(StyleSheet.flatten(search.props.style).fontSize);
  fireEvent.changeText(search, '요금제 6');
  expect(screen.queryByText('요금제 2')).toBeNull();
  fireEvent.press(screen.getByLabelText('요금제 6'));
  expect(onSelect).toHaveBeenCalledWith('plan-6');
  expect(screen.queryByLabelText('요금제 검색')).toBeNull();
});

test('채팅용 선택 modal은 닫기 후 원래 선택 행으로 돌아온다', () => {
  const options = Array.from({ length: 6 }, (_, index) => ({ id: `v${index}`, label: `선택 ${index}` }));
  const screen = render(<SettingsOptionRow variant="chat" presentation="manuscript" label="선택" selected="v0" options={options} emptyLabel="없음" onSelect={jest.fn()}/>);

  fireEvent.press(screen.getByLabelText('선택: 선택 0'));
  expect(screen.UNSAFE_getByType(ScrollView).props.showsVerticalScrollIndicator).toBe(false);
  fireEvent.press(screen.getByText('닫기'));
  expect(screen.queryByLabelText('선택 검색')).toBeNull();
  expect(screen.getByLabelText('선택: 선택 0')).toBeTruthy();
});

test('기본 설정 선택 modal은 세로 indicator 기본 동작을 유지한다', () => {
  const options = Array.from({ length: 6 }, (_, index) => ({ id: `v${index}`, label: `선택 ${index}` }));
  const screen = render(<SettingsOptionRow label="선택" selected="v0" options={options} emptyLabel="없음" onSelect={jest.fn()}/>);

  fireEvent.press(screen.getByLabelText('선택: 선택 0'));
  expect(screen.UNSAFE_getByType(ScrollView).props.showsVerticalScrollIndicator).toBeUndefined();
});
