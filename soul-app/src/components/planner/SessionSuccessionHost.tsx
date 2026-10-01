import React from 'react';
import type { ApiClient } from '../../api/client';
import type { SessionSuccessionRequest } from '../../hooks/usePlannerContextMenus';
import { markClaudeRuntimeListsFresh } from '../../store/claudeRuntimeListLifecycleStore';
import { SessionSuccessionSheet } from './SessionSuccessionSheet';

export function SessionSuccessionHost({
  api,
  request,
  onClose,
  onCreated,
}: {
  api: ApiClient | null;
  request: SessionSuccessionRequest | null;
  onClose(): void;
  onCreated(sessionId: string): void;
}) {
  if (!request) return null;
  const handleCreated = (sessionId: string) => {
    markClaudeRuntimeListsFresh(sessionId);
    onCreated(sessionId);
  };
  return (
    <SessionSuccessionSheet
      api={api}
      folder={request.folder}
      predecessorSessionId={request.predecessorSessionId}
      visible
      onClose={onClose}
      onCreated={handleCreated}
    />
  );
}
