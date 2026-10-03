import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { ClaudeRuntimeTasksStrip } from '../components/chat/ClaudeRuntimeTasksStrip';
import { CardBoardWorkspace, type CardBoardWorkspaceHandle } from '../components/planner/CardBoardWorkspace';
import { useChatStore } from '../store/chatStore';
import { useUIStore } from '../store/uiStore';
import { useTokens } from '../theme';
import { dialogueApi, reviewTask } from './dialogue-fixtures';
import type { DialogueSample } from './dialogue-inventory';

// Owners keep their real internal open/close behavior, rather than copied forms.
export function ReviewDialogueOwners({ opened }: { opened: DialogueSample | null }) {
  const t = useTokens();
  const board = useRef<CardBoardWorkspaceHandle>(null);
  useEffect(() => {
    if (opened === 'board-expanded') board.current?.openExpanded();
    if (opened === 'task-output') useChatStore.getState().setClaudeRuntimeTasks('public-idle', {
      sessionId: 'public-idle', sessionState: 'idle', runtimeSessionId: null, updatedAt: 1, tasks: [reviewTask],
    });
  }, [opened]);
  if (opened === 'task-output') return <ClaudeRuntimeTasksStrip sessionId="public-idle" api={dialogueApi} />;
  if (opened === 'board-expanded') return <View style={{ flex: 1, position: 'relative', gap: t.uiSpacing.md }}>
    <CardBoardWorkspace ref={board} api={dialogueApi} folderId="public-project" cardDisplay={{ includeCompleted: false, onChange() {} }}
      onOpen={id => useUIStore.getState().openCardOverlay(id)} />
  </View>;
  return null;
}
