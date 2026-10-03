import { StyleSheet } from 'react-native';
import type { DesignTokens } from '../../theme';

/** Shared today/folder card rows and today session composer. */
export function todayCardStyles(t: DesignTokens) {
  const s = t.uiSpacing;
  const type = t.foundation.typography;
  const round = t.foundation.radius.round;
  return StyleSheet.create({
    groups: { gap: s.lg },
    section: { gap: s.sm },
    empty: { borderWidth: StyleSheet.hairlineWidth, borderStyle: 'dashed', borderColor: t.colors.border,
      borderRadius: t.radius.lg, paddingVertical: t.controlHeight.chip, paddingHorizontal: s.lg, gap: s.xs },
    emptyTitle: { ...type.body, color: t.colors.textSecondary, textAlign: 'center' },
    emptyText: { ...type.meta, color: t.colors.textMuted, textAlign: 'center' },
    frame: { borderRadius: t.radius.lg },
    composerLayout: { paddingHorizontal: t.spacing.md, paddingTop: s.lg, paddingBottom: s.lg, gap: s.xxs },
    chips: { minWidth: 0, flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', gap: s.xs + s.xxs },
    chipFrame: { minWidth: 0, maxWidth: '100%', flexShrink: 1 },
    chip: { minWidth: 0, flexShrink: 1, height: t.controlHeight.chip, maxWidth: '100%', paddingHorizontal: s.sm + s.xxs,
      borderRadius: round, backgroundColor: t.colors.surfaceCode, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border },
    chipText: { ...type.meta, color: t.colors.textSecondary, flexShrink: 1 },
    disabled: { opacity: 0.45 },
  });
}
