import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { ClaudeRuntimeTasksStrip, ClaudeRuntimeTaskOutputModal } from '../components/chat/ClaudeRuntimeTasksStrip';
import { CardBoardWorkspace, type CardBoardWorkspaceHandle } from '../components/planner/CardBoardWorkspace';
import { useChatStore } from '../store/chatStore';
import { useUIStore } from '../store/uiStore';
import { useTokens } from '../theme';
import { dialogueApi, reviewTask, reviewTaskOutput } from './dialogue-fixtures';
import type { DialogueSample } from './dialogue-inventory';
import { ReviewOwnedAgents } from './ReviewOwnedAgents';

// Owners keep their real internal open/close behavior, rather than copied forms.
export function ReviewDialogueOwners({ opened, preview = false, onClose }: { opened: DialogueSample | null; preview?: boolean; onClose(): void }) {
  const t = useTokens();
  const board = useRef<CardBoardWorkspaceHandle>(null);
  useEffect(() => {
    if (opened === 'board-expanded') board.current?.openExpanded();
    if (opened === 'task-output') useChatStore.getState().setClaudeRuntimeTasks('public-idle', {
      sessionId: 'public-idle', sessionState: 'idle', runtimeSessionId: null, updatedAt: 1, tasks: [reviewTask],
    });
  }, [opened]);
  if (opened === 'owned-agents') return <ReviewOwnedAgents />;
  if (opened === 'task-output' && preview) return <ClaudeRuntimeTaskOutputModal output={reviewTaskOutput} onClose={onClose} />;
  if (opened === 'task-output') return <ClaudeRuntimeTasksStrip sessionId="public-idle" api={dialogueApi} />;
  if (opened === 'board-expanded') return <View style={{ flex: 1, position: 'relative', gap: t.uiSpacing.md }}>
    <CardBoardWorkspace ref={board} api={dialogueApi} folderId="public-project" cardDisplay={{ includeCompleted: false, onChange() {} }}
      onExpandedClose={preview ? onClose : undefined} onOpen={id => useUIStore.getState().openCardOverlay(id)} />
  </View>;
  return null;
}
