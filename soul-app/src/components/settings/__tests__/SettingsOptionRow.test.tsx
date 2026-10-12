import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { SettingsOptionRow, type SettingsOption } from '../SettingsOptionRow';
import { PHONE_FOUNDATION } from '../../../theme';

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
