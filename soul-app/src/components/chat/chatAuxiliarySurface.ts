import { StyleSheet, type ViewStyle } from 'react-native';
import type { DesignTokens } from '../../theme';

/** 원고형만 종이 위 패널 표면을 선택하고 기본 대화의 표면은 소유하지 않는다. */
export function chatAuxiliarySurface(t: DesignTokens, presentation: 'default' | 'manuscript', separateBelow = true): ViewStyle | undefined {
  return presentation === 'manuscript' ? { backgroundColor: t.persistentSession.panel,
    borderBottomWidth: separateBelow ? StyleSheet.hairlineWidth : 0, borderBottomColor: t.persistentSession.line } : undefined;
}
