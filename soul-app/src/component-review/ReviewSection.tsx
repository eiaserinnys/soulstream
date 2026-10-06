import React from 'react';
import { View } from 'react-native';
import { useTokens } from '../theme';
import { PlannerSectionHeader } from '../components/planner/PlannerSectionHeader';

export function ReviewSection({ title, children, testID }: { title: string; children: React.ReactNode; testID?: string }) {
  const t = useTokens();
  return <View testID={testID} style={{ gap: t.spacing.md }}>
    <PlannerSectionHeader title={title} />
    {children}
  </View>;
}
