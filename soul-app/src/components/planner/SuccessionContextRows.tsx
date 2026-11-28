import { Switch, Text, TouchableOpacity, View } from 'react-native';
import type { makeStyles } from './SessionSuccessionSheet.styles';

/** Switch row of 「함께 전달할 자료」; a failed lookup puts its retry under the detail. */
export function SuccessionSwitchRow({ testID, value, label, detail, onChange, onRetry, styles, disabled }: {
  testID?: string;
  value: boolean;
  disabled?: boolean;
  label: string;
  detail: string;
  onChange(value: boolean): void;
  onRetry?: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View testID={testID ? `${testID}-row` : undefined} style={styles.switchRow}>
      <View style={styles.checkBody}>
        <Text style={styles.rowTitle}>{label}</Text>
        <Text style={onRetry ? styles.failedDetail : styles.meta} numberOfLines={2}
          accessibilityRole={onRetry ? 'alert' : undefined}>{detail}</Text>
        {onRetry ? (
          <TouchableOpacity testID={testID ? `${testID}-retry` : undefined} accessibilityRole="button"
            style={styles.retryAction} onPress={onRetry}>
            <Text style={styles.retryText}>다시 시도</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <Switch testID={testID} accessibilityLabel={label} value={value} disabled={disabled} onValueChange={onChange} />
    </View>
  );
}

export function describeFolderContext(
  context: { guidance: readonly unknown[]; atomReferences: readonly unknown[] } | null,
  hasDefaults: boolean,
): string {
  const parts = [
    context && context.guidance.length > 0 ? '지침' : null,
    context && context.atomReferences.length > 0 ? `참고 자료 ${context.atomReferences.length}` : null,
    hasDefaults ? '기본 실행 환경' : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '연결된 맥락 없음';
}
