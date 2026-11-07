import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import {
  providerQuotaSlots,
  type UsageSummaryProvider,
} from '../../../../packages/soul-ui/src/lib/usage-summary';
import { useDeviceType, useTokens } from '../../theme';
import { makeClaudePoolStyles } from './claudeAccountPoolStyles';

export type QuotaGridCell = {
  label: string;
  usedPercent: number;
  resetAt: number | string | null;
  short: boolean;
};

const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
// A whitespace-only Text collapses to zero height on RN web, which would make
// an empty window's track sit higher than its filled neighbours. A no-break
// space keeps the same two text lines in every cell.
const blank = ' ';

function resetDate(resetAt: number | string | null): Date | null {
  if (resetAt === null) return null;
  const date = typeof resetAt === 'number' ? new Date(resetAt * 1000) : new Date(resetAt);
  return Number.isFinite(date.getTime()) ? date : null;
}

function localClock(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function quotaResetLabel(
  resetAt: number | string | null,
  usedPercent: number,
  short: boolean,
): string {
  const date = resetDate(resetAt);
  if (!date) return '—';
  if (!short) return `${weekdays[date.getDay()]} ${localClock(date)}`;
  if (usedPercent >= 100) return `${localClock(date)} 해제`;
  const minutes = Math.max(0, Math.ceil((date.getTime() - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}분 후`;
  return `${Math.ceil(minutes / 60)}시간 후`;
}

export function providerQuotaCells(provider: UsageSummaryProvider | null): (QuotaGridCell | null)[] {
  return providerQuotaSlots(provider).map(slot => slot === null ? null : {
    label: slot.label,
    usedPercent: slot.usedPercent,
    resetAt: slot.resetAt,
    short: slot.kind === 'short',
  });
}

export function ProviderQuotaGrid({
  cells,
  prefix,
}: {
  cells: readonly (QuotaGridCell | null)[];
  prefix: string;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeClaudePoolStyles(t), [t]);
  const compact = useDeviceType() === 'phone';
  return (
    <View style={styles.quotaGrid}>
      {cells.map((cell, index) => {
        const used = cell === null ? 0 : Math.max(0, Math.min(100, cell.usedPercent));
        const color = used >= 95 ? t.colors.error : used >= 80 ? t.colors.warning : t.colors.accent;
        return (
          <View
            key={index}
            testID={`${prefix}-${index}`}
            style={styles.quotaColumn}
            accessibilityElementsHidden={cell === null}
          >
            {compact ? (
              <>
                <Text numberOfLines={1} style={styles.quotaName}>{cell?.label ?? blank}</Text>
                <View style={styles.quotaValueGroup}>
                  <Text style={styles.quotaPercent}>{cell ? `${Math.round(cell.usedPercent)}%` : blank}</Text>
                  <Text numberOfLines={1} style={styles.quotaReset}>
                    {cell ? quotaResetLabel(cell.resetAt, cell.usedPercent, cell.short) : blank}
                  </Text>
                </View>
              </>
            ) : (
              <View style={styles.quotaLabelRow}>
                <Text numberOfLines={1} style={styles.quotaName}>{cell?.label ?? blank}</Text>
                <View style={styles.quotaValueGroup}>
                  <Text style={styles.quotaPercent}>{cell ? `${Math.round(cell.usedPercent)}%` : blank}</Text>
                  <Text numberOfLines={1} style={styles.quotaReset}>
                    {cell ? quotaResetLabel(cell.resetAt, cell.usedPercent, cell.short) : blank}
                  </Text>
                </View>
              </View>
            )}
            <View testID={cell ? `${prefix}-bar-${index}` : undefined} style={styles.quotaTrack}>
              {cell ? <View style={[styles.quotaFill, { width: `${used}%`, backgroundColor: color }]} /> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}
