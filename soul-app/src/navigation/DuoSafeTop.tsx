import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDuoSideBand } from './duoSideBand';

export function DuoSafeTop({ children }: { children: React.ReactNode }) {
  const duo = useDuoSideBand();
  return duo ? <SafeAreaView edges={['top']} style={{ flex: 1 }}>{children}</SafeAreaView> : <>{children}</>;
}
