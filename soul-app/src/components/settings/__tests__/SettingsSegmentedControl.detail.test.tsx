import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SettingsSegmentedControl } from '../SettingsSegmentedControl';

test('상세 pill 탭은 기본 설정 트랙과 분리된 44pt 이상 선택 컨트롤이다', () => {
  const onChange = jest.fn();
  const screen = render(<SettingsSegmentedControl variant="detail" id="detail" value="items" onChange={onChange}
    options={[{ value: 'items', label: '확인 항목', count: 2, countBadge: true }, { value: 'comments', label: '커멘트', dot: true }]} />);
  const selected = screen.getByTestId('settings-segment-detail-items');
  expect(selected.props.accessibilityState).toMatchObject({ selected: true });
  expect(screen.getByText('2')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('settings-segment-detail-comments-dot').props.style)).toMatchObject({ width: 8, height: 8 });
  fireEvent.press(screen.getByTestId('settings-segment-detail-comments'));
  expect(onChange).toHaveBeenCalledWith('comments');
});


test('상세 탭의 배지는 선택 prop으로만 켜고 선택 전후 글자 굵기와 테두리 폭을 유지한다', () => {
  const options = [{ value: 'items', label: '확인 항목', count: 2, countBadge: true }, { value: 'notes', label: '노트', count: 5 }];
  const screen = render(<SettingsSegmentedControl variant="detail" id="stable" value="items" onChange={() => {}} options={options} />);
  const label = () => StyleSheet.flatten(screen.getByText('확인 항목').props.style);
  const visual = () => StyleSheet.flatten(screen.getByTestId('settings-segment-stable-items-visual').props.style);
  const before = { weight: label().fontWeight, border: visual().borderWidth };
  const badge = StyleSheet.flatten(screen.getByTestId('settings-segment-stable-items-count').props.style);
  const plain = StyleSheet.flatten(screen.getByTestId('settings-segment-stable-notes-count').props.style);
  expect(badge.backgroundColor).toBeTruthy();
  expect(plain.backgroundColor).toBeUndefined();
  screen.rerender(<SettingsSegmentedControl variant="detail" id="stable" value="notes" onChange={() => {}} options={options} />);
  expect({ weight: label().fontWeight, border: visual().borderWidth }).toEqual(before);
});
