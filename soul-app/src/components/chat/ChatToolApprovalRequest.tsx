import React, { memo, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type {
  SessionEvent,
  ToolApprovalPayload,
  ToolApprovalResolvedPayload,
} from '../../api/types';
import { createApiClient } from '../../api/client';
import { useSettingsStore } from '../../store/settingsStore';
import { useChatStore } from '../../store/chatStore';
import { useTokens, type DesignTokens } from '../../theme';
import { getChatRowHorizontalInset } from './ChatBody.styles';
import {
  approvalIdFromPayload,
  approvalIdFromResolved,
  getActiveRealtimeVoiceController,
} from '../../services/realtimeVoice';

interface Props {
  event: SessionEvent;
  sessionId: string;
  presentation?: 'default' | 'manuscript';
}

export const ChatToolApprovalRequest = memo(function ChatToolApprovalRequest({
  event,
  sessionId,
  presentation = 'default',
}: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t, presentation), [t, presentation]);
  const payload = event.data as unknown as ToolApprovalPayload;
  const approvalId = approvalIdFromPayload(payload);
  const [localDecision, setLocalDecision] = useState<'approved' | 'rejected' | null>(null);
  const isResolved = useChatStore((s) =>
    (s.eventsBySession[sessionId] ?? []).some((candidate) => {
      if (candidate.type !== 'tool_approval_resolved') return false;
      return approvalIdFromResolved(candidate.data as ToolApprovalResolvedPayload) === approvalId;
    }),
  );

  if (!approvalId) return null;

  const toolName = payload.tool_name || payload.toolName || 'tool';
  const agentName = payload.agent_name || payload.agentName;
  const disabled = !!localDecision || isResolved;

  async function decide(decision: 'approved' | 'rejected') {
    if (disabled) return;
    setLocalDecision(decision);
    try {
      const serverUrl = useSettingsStore.getState().serverUrl;
      if (!serverUrl) {
        setLocalDecision(null);
        return;
      }
      const api = createApiClient(serverUrl);
      const res = payload.realtime
        ? await api.resolveRealtimeToolApproval(sessionId, approvalId, {
            decision,
            source: 'tap',
            callId: payload.call_id || payload.callId,
          })
        : decision === 'approved'
          ? await api.approveTool(sessionId, approvalId)
          : await api.rejectTool(sessionId, approvalId);
      if (
        payload.realtime &&
        'dataChannelEvent' in res &&
        res.dataChannelEvent
      ) {
        getActiveRealtimeVoiceController(sessionId)?.sendDataChannelEvent(
          res.dataChannelEvent,
        );
      }
      if ('ok' in res && !res.ok) {
        setLocalDecision(null);
      }
    } catch {
      setLocalDecision(null);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.icon}>!</Text>
      <View style={styles.content}>
        <Text style={styles.label}>
          {payload.realtime ? '음성 도구 승인' : '도구 승인'}
        </Text>
        <Text style={styles.title} numberOfLines={2}>
          {agentName ? `${agentName} · ${toolName}` : toolName}
        </Text>
        {disabled ? (
          <Text style={styles.doneText}>
            {localDecision === 'rejected' ? '거부됨' : localDecision === 'approved' ? '승인됨' : '처리 완료'}
          </Text>
        ) : (
          <View style={styles.actionsRow}>
            <TouchableOpacity
              onPress={() => decide('approved')}
              style={[styles.actionButton, styles.approveButton]}
            >
              <Text style={[styles.actionText, styles.approveText]}>승인</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => decide('rejected')}
              style={[styles.actionButton, styles.rejectButton]}
            >
              <Text style={[styles.actionText, styles.rejectText]}>거부</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
});

function makeStyles(t: DesignTokens, presentation: 'default' | 'manuscript') {
  return StyleSheet.create({
    container: {
      flexDirection: 'row',
      paddingHorizontal: getChatRowHorizontalInset(t, presentation),
      paddingVertical: t.spacing.xs,
      gap: t.spacing.sm,
    },
    icon: {
      width: t.iconSize.action,
      height: t.iconSize.action,
      borderRadius: t.radius.lg,
      textAlign: 'center',
      lineHeight: t.iconSize.action,
      fontSize: t.iconSize.standard,
      fontWeight: '700',
      color: t.colors.accentText,
      backgroundColor: t.colors.warning ?? t.colors.accent,
    },
    content: {
      flex: 1,
    },
    label: {
      fontSize: t.chatFontSize.meta,
      color: t.colors.textMuted,
      marginBottom: t.spacing.xxs,
    },
    title: {
      fontSize: t.chatFontSize.body,
      fontWeight: '500',
      color: t.colors.textPrimary,
      marginBottom: t.spacing.sm,
    },
    actionsRow: {
      flexDirection: 'row',
      gap: t.spacing.sm,
    },
    actionButton: {
      minWidth: 68,
      minHeight: t.hitTarget.min,
      borderRadius: 6,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: t.spacing.md,
    },
    approveButton: {
      backgroundColor: t.colors.accent,
    },
    rejectButton: {
      backgroundColor: t.colors.surface,
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    actionText: {
      fontSize: t.chatFontSize.meta,
      fontWeight: '600',
    },
    approveText: {
      color: t.colors.accentText,
    },
    rejectText: {
      color: t.colors.textPrimary,
    },
    doneText: {
      fontSize: t.chatFontSize.meta,
      color: t.colors.accent,
    },
  });
}
