import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import type { CardCheckItem } from '../../api/cardTypes';
import { useTokens } from '../../theme';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { CardCheckItemRow } from './CardCheckItemRow';

export function CardCheckItems({
  items,
  pendingConfirmations,
  initiallyConfirmedIds,
  newlyConfirmedIds,
  onConfirm,
  onSetTarget,
  onRecentConfirmation,
  paneWidth,
}: {
  items: CardCheckItem[];
  pendingConfirmations: Record<number, { confirmed: boolean; requestId: string }>;
  initiallyConfirmedIds: readonly number[];
  newlyConfirmedIds: readonly number[];
  onConfirm(itemId: number, confirmed: boolean): Promise<boolean>;
  onSetTarget(item: CardCheckItem): void;
  onRecentConfirmation(itemId: number, confirmed: boolean): void;
  paneWidth: number;
}) {
  const t = useTokens();
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [confirmedExpanded, setConfirmedExpanded] = useState(false);
  const initialIds = useMemo(() => new Set(initiallyConfirmedIds), [initiallyConfirmedIds]);
  const recentIds = useMemo(() => new Set(newlyConfirmedIds), [newlyConfirmedIds]);
  const groupedCandidates = items.filter((item) => initialIds.has(item.id)
    && !recentIds.has(item.id)
    && (pendingConfirmations[item.id]?.confirmed ?? item.display === 'confirmed'));
  const groupedIds = groupedCandidates.length >= 3
    ? new Set(groupedCandidates.map((item) => item.id))
    : new Set<number>();
  const visibleItems = items.filter((item) => !groupedIds.has(item.id));

  const renderItem = (item: CardCheckItem, grouped = false) => {
    const pending = pendingConfirmations[item.id];
    const checked = pending?.confirmed ?? item.display === 'confirmed';
    const defaultExpanded = grouped ? false : item.display !== 'confirmed';
    const isExpanded = expanded[item.id] ?? defaultExpanded;
    return (
      <CardCheckItemRow
        key={item.id}
        item={item}
        checked={checked}
        pending={Boolean(pending)}
        expanded={isExpanded}
        paneWidth={paneWidth}
        onToggle={() => setExpanded((current) => ({ ...current, [item.id]: !isExpanded }))}
        onConfirm={(confirmed) => {
          const previousExpanded = isExpanded;
          const wasRecentlyConfirmed = recentIds.has(item.id);
          onRecentConfirmation(item.id, confirmed);
          if (confirmed) {
            setExpanded((current) => ({ ...current, [item.id]: false }));
          } else {
            setExpanded((current) => ({ ...current, [item.id]: true }));
            onSetTarget(item);
            if (grouped) setConfirmedExpanded(false);
          }
          void onConfirm(item.id, confirmed).then((ok) => {
            if (!ok) {
              onRecentConfirmation(item.id, wasRecentlyConfirmed);
              setExpanded((current) => ({ ...current, [item.id]: previousExpanded }));
            }
          });
        }}
        onSetTarget={onSetTarget}
      />
    );
  };

  return (
    <View testID="card-check-items" style={{ gap: t.uiSpacing.xxs }}>
      {visibleItems.map((item) => renderItem(item))}
      {groupedIds.size ? (
        <View testID="card-check-items-confirmed-group">
          <PlannerSectionHeader
            title={`확인함 ${groupedIds.size}개`}
            variant="compact"
            expanded={confirmedExpanded}
            onToggle={() => setConfirmedExpanded((value) => !value)}
          />
          {confirmedExpanded ? groupedCandidates.map((item) => renderItem(item, true)) : null}
        </View>
      ) : null}
    </View>
  );
}
