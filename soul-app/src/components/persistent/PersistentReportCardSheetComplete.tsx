import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { PersistentReportEntry } from '../../api/types';
import { useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { cardDetailStyles } from '../planner/CardDetail.styles';
import { isReviewCardEntry } from '../../lib/persistent-report-card';
import { reportStyles } from './persistentReportStyles';
import type { CardCompletion } from './usePersistentCardCompletion';

export function PersistentReportCardSheetComplete({ entry, completion, onCompleted }: {
  entry: PersistentReportEntry; completion: CardCompletion; onCompleted(): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const reportText = useMemo(() => reportStyles(t, t.foundation.pageInset, false), [t]);
  const [failedEntryKey, setFailedEntryKey] = useState<string | null>(null);
  if (!isReviewCardEntry(entry)) return null;

  return <View style={{ alignItems: 'flex-end', marginTop: t.uiSpacing.lg }}>
    {failedEntryKey === entry.key ? <Text style={styles.error}>카드를 완료하지 못했어.</Text> : null}
    <GlassButton testID="persistent-report-card-sheet-complete" variant="paper" size="compact" disabled={completion.busy}
      accessibilityLabel="완료" onPress={() => {
        setFailedEntryKey(null);
        void completion.complete(entry).then(ok => {
          if (ok) onCompleted();
          else setFailedEntryKey(entry.key);
        });
      }}>
      <Text style={reportText.buttonLabel}>완료</Text>
    </GlassButton>
  </View>;
}
