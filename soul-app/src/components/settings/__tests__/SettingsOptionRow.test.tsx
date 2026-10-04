import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { SettingsOptionRow } from '../SettingsOptionRow';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

test('긴 목록 검색은 저장된 누락 값과 가용성 사유를 보존하며 선택을 임의 차단하지 않는다', () => {
  const onSelect = jest.fn();
  const screen = render(<SettingsOptionRow label="모델" selected="saved-model" options={Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, label: `모델 ${i}`, available: false, reason: '한도 소진' }))} emptyLabel="없음" onSelect={onSelect}/>);
  expect(screen.getByText(/saved-model/)).toBeTruthy();
  fireEvent.press(screen.getByLabelText('모델: saved-model'));
  fireEvent.changeText(screen.getByLabelText('모델 검색'), '모델 3');
  expect(screen.queryByText('모델 2')).toBeNull();
  fireEvent.press(screen.getByLabelText('모델 3 · 한도 소진'));
  expect(onSelect).toHaveBeenCalledWith('m3');
});
