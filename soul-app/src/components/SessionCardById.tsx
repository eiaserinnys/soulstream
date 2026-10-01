import React, { memo, useCallback } from 'react';
import { useSessionStore } from '../store/sessionStore';
import { SessionCard } from './SessionCard';

interface Props {
  sessionId: string;
  onPress: (sessionId: string) => void;
  onLongPress?: (sessionId: string) => void;
  accessibilityLabelPrefix?: string;
}

export const SessionCardById = memo(function SessionCardById({
  sessionId,
  onPress,
  onLongPress,
  accessibilityLabelPrefix,
}: Props) {
  const session = useSessionStore((s) => s.sessions[sessionId]);
  const handlePress = useCallback(() => onPress(sessionId), [onPress, sessionId]);
  const handleLongPress = useCallback(
    () => onLongPress?.(sessionId),
    [onLongPress, sessionId],
  );

  if (!session) return null;
  return (
    <SessionCard
      session={session}
      onPress={handlePress}
      onLongPress={onLongPress ? handleLongPress : undefined}
      accessibilityLabelPrefix={accessibilityLabelPrefix}
    />
  );
});
