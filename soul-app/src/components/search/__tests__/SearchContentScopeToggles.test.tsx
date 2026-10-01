import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { SearchContentScopeToggles } from '../SearchContentScopeToggles';

test('턴 요약·하이라이트·줄거리 토글은 각각 독립된 기본 off 계약을 가진다', () => {
  const onChange = jest.fn();
  const screen = render(
    <SearchContentScopeToggles
      includeTurnSummaries={false}
      includeHighlight={false}
      includeStory={false}
      onChange={onChange}
    />,
  );

  expect(screen.getByLabelText('턴 요약 포함').props.accessibilityState)
    .toEqual(expect.objectContaining({ checked: false }));
  expect(screen.getByLabelText('하이라이트 포함').props.accessibilityState)
    .toEqual(expect.objectContaining({ checked: false }));
  expect(screen.getByLabelText('줄거리 포함').props.accessibilityState)
    .toEqual(expect.objectContaining({ checked: false }));

  fireEvent.press(screen.getByLabelText('턴 요약 포함'));
  fireEvent.press(screen.getByLabelText('하이라이트 포함'));
  fireEvent.press(screen.getByLabelText('줄거리 포함'));
  expect(onChange.mock.calls).toEqual([
    [{ includeTurnSummaries: true }],
    [{ includeHighlight: true }],
    [{ includeStory: true }],
  ]);
});
