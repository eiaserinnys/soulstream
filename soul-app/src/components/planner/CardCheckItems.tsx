import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import type { CardCheckItem } from '../../api/cardTypes';
import { useTokens } from '../../theme';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { CardCheckItemRow } from './CardCheckItemRow';

export function CardCheckItems({
  items,
  pendingConfirmations,
  onConfirm,
  onSetTarget,
  paneWidth,
}: {
  items: CardCheckItem[];
  pendingConfirmations: Record<number, { confirmed: boolean; requestId: string }>;
  onConfirm(itemId: number, confirmed: boolean): Promise<boolean>;
  onSetTarget(item: CardCheckItem): void;
  paneWidth: number;
}) {
  const t = useTokens();
  const [newlyConfirmed, setNewlyConfirmed] = useState<number[]>([]);
  const [locallyUnconfirmed, setLocallyUnconfirmed] = useState<number[]>([]);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [confirmedExpanded, setConfirmedExpanded] = useState(false);
  const initiallyConfirmed = items.filter((item) => item.display === 'confirmed'
    && !newlyConfirmed.includes(item.id) && !locallyUnconfirmed.includes(item.id));
  const groupedIds = initiallyConfirmed.length >= 3 ? new Set(initiallyConfirmed.map((item) => item.id)) : new Set<number>();
  const visibleItems = items.filter((item) => !groupedIds.has(item.id));
  return (
    <View testID="card-check-items" style={{ gap: t.uiSpacing.xxs }}>
      {visibleItems.map((item) => {
        const pending = pendingConfirmations[item.id];
        const checked = pending?.confirmed ?? (newlyConfirmed.includes(item.id)
          || (item.display === 'confirmed' && !locallyUnconfirmed.includes(item.id)));
        return (
          <CardCheckItemRow
            key={item.id}
            item={item}
            checked={checked}
            pending={Boolean(pending)}
            expanded={expanded[item.id] ?? (item.display !== 'confirmed')}
            paneWidth={paneWidth}
            onToggle={() => setExpanded((current) => ({ ...current, [item.id]: !(current[item.id] ?? (item.display !== 'confirmed')) }))}
            onConfirm={(confirmed) => {
              const previousExpanded = expanded[item.id] ?? (item.display !== 'confirmed');
              if (confirmed) {
                setNewlyConfirmed((current) => current.includes(item.id) ? current : [...current, item.id]);
                setExpanded((current) => ({ ...current, [item.id]: false }));
              } else {
                const wasNewlyConfirmed = newlyConfirmed.includes(item.id);
                setNewlyConfirmed((current) => current.filter((id) => id !== item.id));
                setLocallyUnconfirmed((current) => current.includes(item.id) ? current : [...current, item.id]);
                setExpanded((current) => ({ ...current, [item.id]: true }));
                onSetTarget(item);
                void onConfirm(item.id, confirmed).then((ok) => {
                  if (!ok) {
                    setLocallyUnconfirmed((current) => current.filter((id) => id !== item.id));
                    if (wasNewlyConfirmed) setNewlyConfirmed((current) => current.includes(item.id) ? current : [...current, item.id]);
                    setExpanded((current) => ({ ...current, [item.id]: previousExpanded }));
                  }
                });
                return;
              }
              void onConfirm(item.id, confirmed).then((ok) => {
                if (!ok) {
                  if (confirmed) setNewlyConfirmed((current) => current.filter((id) => id !== item.id));
                  else setLocallyUnconfirmed((current) => current.filter((id) => id !== item.id));
                  setExpanded((current) => ({ ...current, [item.id]: previousExpanded }));
                }
              });
            }}
            onSetTarget={onSetTarget}
          />
        );
      })}
      {groupedIds.size ? (
        <View testID="card-check-items-confirmed-group">
          <PlannerSectionHeader
            title={`확인함 ${groupedIds.size}개`}
            variant="compact"
            expanded={confirmedExpanded}
            onToggle={() => setConfirmedExpanded((value) => !value)}
          />
          {confirmedExpanded ? initiallyConfirmed.map((item) => (
            <CardCheckItemRow
              key={item.id}
              item={item}
              checked={pendingConfirmations[item.id]?.confirmed ?? true}
              pending={Boolean(pendingConfirmations[item.id])}
              expanded={expanded[item.id] ?? false}
              paneWidth={paneWidth}
              onToggle={() => setExpanded((current) => ({ ...current, [item.id]: !(current[item.id] ?? false) }))}
              onConfirm={(confirmed) => {
                const previousExpanded = expanded[item.id] ?? false;
                const wasNewlyConfirmed = newlyConfirmed.includes(item.id);
                if (!confirmed) {
                  setNewlyConfirmed((current) => current.filter((id) => id !== item.id));
                  setLocallyUnconfirmed((current) => current.includes(item.id) ? current : [...current, item.id]);
                  setExpanded((current) => ({ ...current, [item.id]: true }));
                  setConfirmedExpanded(false);
                  onSetTarget(item);
                }
                void onConfirm(item.id, confirmed).then((ok) => {
                  if (!ok && !confirmed) {
                    setLocallyUnconfirmed((current) => current.filter((id) => id !== item.id));
                    if (wasNewlyConfirmed) setNewlyConfirmed((current) => current.includes(item.id) ? current : [...current, item.id]);
                    setExpanded((current) => ({ ...current, [item.id]: previousExpanded }));
                  }
                });
              }}
              onSetTarget={onSetTarget}
            />
          )) : null}
        </View>
      ) : null}
    </View>
  );
}
