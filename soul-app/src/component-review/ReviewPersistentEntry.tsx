import React, { useEffect, useRef } from 'react';
import { Text } from 'react-native';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
import { PersistentSessionProvider, usePersistentSessionHost } from '../navigation/PersistentSessionContext';
import { useTokens } from '../theme';

function Entry({ onOpen, choose }: { onOpen(): void; choose: boolean }) {
  const t = useTokens();
  const { requestEntry } = usePersistentSessionHost();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void requestEntry(onOpen, false, choose);
  }, [choose, onOpen, requestEntry]);
  return <LiquidGlassButton accessibilityLabel="영구 세션 선택 열기" onPress={() => void requestEntry(onOpen, false, choose)}>
    <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>영구 세션 선택</Text>
  </LiquidGlassButton>;
}
export function ReviewPersistentEntry({ onOpen, choose = true }: { onOpen(): void; choose?: boolean }) {
  return <PersistentSessionProvider><Entry onOpen={onOpen} choose={choose} /></PersistentSessionProvider>;
}
