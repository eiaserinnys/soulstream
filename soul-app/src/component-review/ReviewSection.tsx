import React from 'react';
import { View } from 'react-native';
import { useTokens } from '../theme';
import { PlannerSectionHeader } from '../components/planner/PlannerSectionHeader';

export function ReviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTokens();
  return <View style={{ gap: t.spacing.md }}>
    <PlannerSectionHeader title={title} />
    {children}
  </View>;
}
