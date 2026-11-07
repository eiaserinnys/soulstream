import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import {
  providerQuotaSlots,
  type ProviderQuotaSlotKind,
  type UsageSummaryProvider,
} from '../../../../packages/soul-ui/src/lib/usage-summary';
import { useDeviceType, useTokens } from '../../theme';
import { makeClaudePoolStyles } from './claudeAccountPoolStyles';

export type QuotaGridCell = {
  label: string;
  usedPercent: number;
  resetAt: number | string | null;
  short: boolean;
  kind: ProviderQuotaSlotKind;
};

const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
const DAY_MS = 24 * 60 * 60 * 1000;

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
  kind?: ProviderQuotaSlotKind,
): string {
  const date = resetDate(resetAt);
  if (!date) return '—';
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
  const longWindow = kind === 'monthly' || date.getTime() - Date.now() > 7 * DAY_MS;
  if (usedPercent >= 100) {
    return longWindow && !short ? `${monthDay} 해제` : `${localClock(date)} 해제`;
  }
  if (longWindow) return monthDay;
  if (!short) return `${weekdays[date.getDay()]} ${localClock(date)}`;
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
    kind: slot.kind,
  });
}

export function ProviderQuotaSkeleton({ testID = 'claude-gauge-loading' }: { testID?: string }) {
  const t = useTokens();
  const styles = useMemo(() => makeClaudePoolStyles(t), [t]);
  const compact = useDeviceType() === 'phone';
  return (
    <View testID={testID} style={styles.quotaGrid}>
      {[0, 1, 2].map(index => (
        <View key={index} style={styles.quotaColumn}>
          {compact ? (
            <>
              <View style={[styles.quotaSkeletonLine, { width: '45%' }]} />
              <View style={[styles.quotaSkeletonLine, { width: '70%' }]} />
            </>
          ) : (
            <View style={styles.quotaLabelRow}>
              <View style={[styles.quotaSkeletonLine, { width: '38%' }]} />
              <View style={[styles.quotaSkeletonLine, { width: '52%' }]} />
            </View>
          )}
          <View style={styles.quotaSkeletonTrack} />
        </View>
      ))}
    </View>
  );
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
        if (cell === null) {
          return (
            <View
              key={index}
              testID={`${prefix}-${index}`}
              style={styles.quotaColumn}
              accessibilityElementsHidden
            />
          );
        }
        const used = Math.max(0, Math.min(100, cell.usedPercent));
        const color = used >= 95 ? t.colors.error : used >= 80 ? t.colors.warning : t.colors.accent;
        return (
          <View key={index} testID={`${prefix}-${index}`} style={styles.quotaColumn}>
            {compact ? (
              <>
                <Text numberOfLines={1} style={styles.quotaName}>{cell.label}</Text>
                <View style={styles.quotaValueGroup}>
                  <Text style={styles.quotaPercent}>{`${Math.round(cell.usedPercent)}%`}</Text>
                  <Text numberOfLines={1} style={styles.quotaReset}>
                    {quotaResetLabel(cell.resetAt, cell.usedPercent, cell.short, cell.kind)}
                  </Text>
                </View>
              </>
            ) : (
              <View style={styles.quotaLabelRow}>
                <Text numberOfLines={1} style={styles.quotaName}>{cell.label}</Text>
                <View style={styles.quotaValueGroup}>
                  <Text style={styles.quotaPercent}>{`${Math.round(cell.usedPercent)}%`}</Text>
                  <Text numberOfLines={1} style={styles.quotaReset}>
                    {quotaResetLabel(cell.resetAt, cell.usedPercent, cell.short, cell.kind)}
                  </Text>
                </View>
              </View>
            )}
            <View testID={`${prefix}-bar-${index}`} style={styles.quotaTrack}>
              <View style={[styles.quotaFill, { width: `${used}%`, backgroundColor: color }]} />
            </View>
          </View>
        );
      })}
    </View>
  );
}
