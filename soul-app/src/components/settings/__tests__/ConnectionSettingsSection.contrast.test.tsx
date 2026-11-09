import React from 'react';
import { StyleSheet } from 'react-native';
import { render, renderHook } from '@testing-library/react-native';
import { useTokens } from '../../../theme';
import { ConnectionSettingsSection } from '../ConnectionSettingsSection';

const noop = jest.fn();

function renderSection(saved: boolean) {
  return render(
    <ConnectionSettingsSection
      flattened={false}
      url="https://example.test"
      serverType="soul-server"
      testing={false}
      result={null}
      savedUrl="https://example.test"
      savedType="soul-server"
      saved={saved}
      runtimeMode="single"
      onUrlChange={noop}
      onServerTypeChange={noop}
      onTest={noop}
      onSave={noop}
    />,
  );
}

test('현재 연결 세 줄은 textPrimary 색으로 읽힌다', () => {
  const tokens = renderHook(() => useTokens()).result.current;
  const screen = renderSection(false);
  for (const text of [
    'https://example.test',
    '저장 유형: 소울 서버',
    '확인된 실행 모드: 단일 서버',
  ]) {
    expect(StyleSheet.flatten(screen.getByText(text).props.style).color)
      .toBe(tokens.colors.textPrimary);
  }
});

test('연결 확인 보조 단추는 활성에서 link, 비활성에서 textPrimary 글자를 쓴다', () => {
  const tokens = renderHook(() => useTokens()).result.current;
  const enabled = renderSection(false);
  expect(StyleSheet.flatten(enabled.getByText('연결 확인').props.style).color)
    .toBe(tokens.colors.link);
  enabled.unmount();
  const screen = render(
    <ConnectionSettingsSection
      flattened={false}
      url=""
      serverType="soul-server"
      testing={false}
      result={null}
      savedUrl="https://example.test"
      savedType="soul-server"
      saved={false}
      runtimeMode="single"
      onUrlChange={noop}
      onServerTypeChange={noop}
      onTest={noop}
      onSave={noop}
    />,
  );
  expect(StyleSheet.flatten(screen.getByText('연결 확인').props.style).color)
    .toBe(tokens.colors.textPrimary);
});

test('저장 완료 안내는 본문 크기와 successText 색을 쓴다', () => {
  const tokens = renderHook(() => useTokens()).result.current;
  const screen = renderSection(true);
  const style = StyleSheet.flatten(
    screen.getByText('이 기기에 연결 설정을 저장했습니다.').props.style,
  );
  expect(style.color).toBe(tokens.colors.successText);
  expect(style.fontSize).toBe(tokens.foundation.typography.body.fontSize);
});
