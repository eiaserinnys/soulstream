import React from 'react';
import { ScrollView } from 'react-native';
import { initializeReview } from '../../component-review/ComponentReview';
import { ReviewRows } from '../../component-review/ReviewRows';
import { useTokens } from '../../theme';
import { MockupShell } from '../MockupShell';

initializeReview();

function Rows() {
  const t = useTokens();
  return <ScrollView testID="mockup-proof-343" style={{ flex: 1, backgroundColor: t.colors.background }}
    contentContainerStyle={{ padding: t.cardLayout.padding, gap: t.uiSpacing.xl, backgroundColor: t.colors.background }}
    showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
    <ReviewRows />
  </ScrollView>;
}

export default function Proof343() {
  return <MockupShell><Rows /></MockupShell>;
}
