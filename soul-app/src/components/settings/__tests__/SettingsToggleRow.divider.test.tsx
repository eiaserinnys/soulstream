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

test('토글 행은 error를 이름 아래 alert 글로 그리고 구분선은 기본값을 지킨다', () => {
  const screen = render(
    <SettingsToggleRow
      label="중앙 풀 받기"
      value={false}
      onValueChange={jest.fn()}
      error="계정 설정을 저장하지 못했습니다. 다시 시도해 주세요."
      testID="toggle-error"
    />,
  );

  const error = screen.getByText('계정 설정을 저장하지 못했습니다. 다시 시도해 주세요.');
  expect(error.props.accessibilityRole).toBe('alert');
  expect(error.props.lineBreakStrategyIOS).toBe('hangul-word');
  expect(rowStyle('toggle-error', screen).borderBottomWidth).toBe(StyleSheet.hairlineWidth);
});
