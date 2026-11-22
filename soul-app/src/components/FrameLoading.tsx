import { ActivityIndicator, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTokens } from '../theme';

type Props = {
  /** 짧은 로딩 글자. 주지 않으면 스피너만 선다. */
  text?: string;
  testID?: string;
  accessibilityLabel?: string;
  /** 내용 높이로 자라는 상자(설정 섹션 등)에서 쓰는 모드. 프레임을 채우지 않는다. */
  inline?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** 프레임 로딩: 스피너(왼쪽)와 짧은 글자(오른쪽)를 한 줄로 묶어 부모 프레임 가운데에 세운다. */
export function FrameLoading({ text, testID, accessibilityLabel, inline = false, style }: Props) {
  const t = useTokens();
  return (
    <View
      testID={testID}
      pointerEvents="none"
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel ?? text ?? '불러오는 중'}
      accessibilityState={{ busy: true }}
      style={[
        inline
          ? { paddingTop: t.spacing.lg, paddingBottom: t.spacing.lg }
          : { flex: 1, minHeight: t.foundation.minHeight.row },
        { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.spacing.sm },
        style,
      ]}
    >
      <ActivityIndicator size="small" color={t.colors.accent} />
      {text ? (
        <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>{text}</Text>
      ) : null}
    </View>
  );
}
