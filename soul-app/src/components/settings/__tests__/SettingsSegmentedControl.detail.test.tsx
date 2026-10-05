import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { SettingsSegmentedControl } from '../SettingsSegmentedControl';

test('상세 pill 탭은 기본 설정 트랙과 분리된 44pt 이상 선택 컨트롤이다', () => {
  const onChange = jest.fn();
  const screen = render(<SettingsSegmentedControl variant="detail" id="detail" value="items" onChange={onChange}
    options={[{ value: 'items', label: '확인 항목', count: 2 }, { value: 'comments', label: '커멘트', dot: true }]} />);
  const selected = screen.getByTestId('settings-segment-detail-items');
  expect(selected.props.accessibilityState).toMatchObject({ selected: true });
  expect(screen.getByText('2')).toBeTruthy();
  expect(screen.getByTestId('settings-segment-detail-comments-dot')).toBeTruthy();
  fireEvent.press(screen.getByTestId('settings-segment-detail-comments'));
  expect(onChange).toHaveBeenCalledWith('comments');
});
