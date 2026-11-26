import { Text } from 'react-native';
import { render, renderHook } from '@testing-library/react-native';
import { useTokens } from '../../../theme';
import type { ModelPresetAvailability } from '../../../../../packages/soul-ui/src/lib/model-preset-availability';
import { SelectedModelPresetName } from '../SelectedModelPresetName';

const exhausted: ModelPresetAvailability = {
  id: 'sol',
  label: 'Sol',
  backend: 'codex',
  available: true,
  reason: 'quota_exhausted',
  reason_label: '7일 사용량 제한',
  resets_at: new Date(2030, 10, 28, 12, 20).toISOString(),
  usage_warning: false,
};

function renderName(selectedModelPresetId: string | null, preset: ModelPresetAvailability = exhausted) {
  return render(
    <Text testID="row">
      <SelectedModelPresetName selection={{
        effectiveModelPreset: preset,
        selectedModelPresetId,
        selectedModelPresetName: 'unused',
      }} />
    </Text>,
  );
}

describe('SelectedModelPresetName', () => {
  const errorText = renderHook(() => useTokens()).result.current.colors.errorText;

  test('직접 고른 소진 모델은 이름만 빨갛고 사유와 해제 시각이 뒤따른다', () => {
    const screen = renderName('sol');

    expect(screen.getByTestId('row')).toHaveTextContent('Sol (7일 사용량 제한) · 11/28 12:20 해제');
    expect(screen.getByText('Sol')).toHaveStyle({ color: errorText });
  });

  test('자동 선택은 자동 ( ) 로 감싸고 이름만 빨갛다', () => {
    const screen = renderName(null);

    expect(screen.getByTestId('row')).toHaveTextContent('자동 (Sol (7일 사용량 제한) · 11/28 12:20 해제)');
    expect(screen.getByText('Sol')).toHaveStyle({ color: errorText });
  });

  test('사유와 해제 시각이 없으면 이름만 보인다', () => {
    const screen = renderName('sol', { ...exhausted, reason_label: null, resets_at: null });

    expect(screen.getByTestId('row')).toHaveTextContent(/^Sol$/);
  });

  test('소진이 아닌 모델은 준비된 이름을 그대로 보인다', () => {
    const screen = renderName('sol', { ...exhausted, reason: null });

    expect(screen.getByTestId('row')).toHaveTextContent('unused');
  });
});
