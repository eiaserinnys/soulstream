import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { SettingsToggleRow } from '../SettingsFormParts';

function rowStyle(testID: string, screen: ReturnType<typeof render>) {
  let node = screen.getByTestId(testID) as { props: { style?: unknown }; parent: unknown } | null;
  while (node) {
    const style = StyleSheet.flatten(node.props.style as never) as Record<string, unknown> | undefined;
    if (style && style.borderBottomWidth !== undefined) return style;
    node = node.parent as typeof node;
  }
  throw new Error('토글 행 스타일을 찾지 못했습니다.');
}

test('토글 행은 기본으로 아래 구분선을 긋고 divider={false}면 긋지 않는다', () => {
  const props = { label: '캐릭터 표시', value: true, onValueChange: jest.fn() };
  const withDivider = render(<SettingsToggleRow {...props} testID="toggle-default" />);
  const withoutDivider = render(
    <SettingsToggleRow {...props} testID="toggle-plain" divider={false} />,
  );

  expect(rowStyle('toggle-default', withDivider).borderBottomWidth)
    .toBe(StyleSheet.hairlineWidth);
  expect(rowStyle('toggle-plain', withoutDivider).borderBottomWidth).toBe(0);
});
