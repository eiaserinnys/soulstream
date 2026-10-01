import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import {
  buildAgentActionSheet,
  buildModelPresetActionSheet,
  buildNodeActionSheet,
  resolveAgentActionSheetSelection,
  resolveModelPresetActionSheetSelection,
  resolveNodeActionSheetSelection,
} from '../sheets/newSessionSelection';
import { useNewSessionSelection } from '../sheets/useNewSessionSelection';
import { useSettingsStore } from '../../store/settingsStore';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { captureAuthScope, useAuthScopeGeneration } from '../../lib/auth-scope';

export function FolderDefaultAssignment({
  api,
  agentId,
  nodeId,
  modelPreset,
  sourceLabel,
  onSave,
}: {
  api: ApiClient | null;
  agentId: string | null;
  nodeId: string | null;
  modelPreset: string | null;
  sourceLabel: string;
  onSave(value: {
    agentId: string;
    nodeId: string;
    modelPreset?: string;
  }): Promise<void>;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const settingsNodeId = useSettingsStore((state) => state.nodeId);
  const scopeGeneration = useAuthScopeGeneration();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownerGeneration = useRef(scopeGeneration);
  const ownsEditor = ownerGeneration.current === scopeGeneration;
  const visibleEditing = ownsEditor && editing;
  useEffect(() => {
    if (ownerGeneration.current === scopeGeneration) return;
    ownerGeneration.current = scopeGeneration;
    setEditing(false);
    setPending(false);
    setError(null);
  }, [scopeGeneration]);
  const selection = useNewSessionSelection({
    visible: visibleEditing,
    api,
    folders: [],
    settingsNodeId,
    defaultNodeId: nodeId,
    defaultAgentId: agentId,
    defaultModelPresetId: modelPreset,
  });

  const pickNode = () => {
    const sheet = buildNodeActionSheet(selection.nodes);
    ActionSheetIOS.showActionSheetWithOptions(sheet, (index) => {
      const result = resolveNodeActionSheetSelection(index, selection.nodes, sheet.cancelButtonIndex);
      if (!result.cancelled) selection.setSelectedNodeId(result.nodeId);
    });
  };
  const pickAgent = () => {
    const sheet = buildAgentActionSheet(selection.agents);
    ActionSheetIOS.showActionSheetWithOptions(sheet, (index) => {
      const result = resolveAgentActionSheetSelection(index, selection.agents, sheet.cancelButtonIndex);
      if (!result.cancelled) selection.setAgentId(result.agentId);
    });
  };
  const pickModel = () => {
    const sheet = buildModelPresetActionSheet(selection.modelPresets);
    ActionSheetIOS.showActionSheetWithOptions(sheet, (index) => {
      const result = resolveModelPresetActionSheetSelection(
        index,
        selection.modelPresets,
        sheet.cancelButtonIndex,
      );
      if (!result.cancelled) selection.setSelectedModelPresetId(result.modelPresetId);
    });
  };
  const save = async () => {
    if (
      !selection.effectiveNodeId
      || !selection.agentId
      || selection.modelPresetSelectionInvalid
    ) return;
    const submittedGeneration = scopeGeneration;
    setPending(true);
    setError(null);
    try {
      await onSave({
        agentId: selection.agentId,
        nodeId: selection.effectiveNodeId,
        ...(selection.selectedModelPresetId
          ? { modelPreset: selection.selectedModelPresetId }
          : {}),
      });
      if (captureAuthScope().generation === submittedGeneration) setEditing(false);
    } catch (cause) {
      if (captureAuthScope().generation === submittedGeneration) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (captureAuthScope().generation === submittedGeneration) setPending(false);
    }
  };

  if (!visibleEditing) {
    return (
      <TouchableOpacity
        style={styles.summary}
        onPress={() => setEditing(true)}
        accessibilityLabel="기본 담당 수정"
      >
        <Text style={styles.person}>👤</Text>
        <Text style={styles.assignment} numberOfLines={1}>
          {agentId || nodeId
            ? `${agentId ?? 'agent 미지정'}@${nodeId ?? 'node 미지정'}${modelPreset ? ' · 모델 지정' : ''}`
            : '없음'}
        </Text>
        <Text style={styles.source} numberOfLines={1}>· {sourceLabel}</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.editor}>
      <TouchableOpacity style={styles.row} onPress={pickNode}>
        <Text style={styles.label}>노드</Text>
        <Text style={styles.value}>{selection.selectedNodeName}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.row} onPress={pickAgent}>
        <Text style={styles.label}>에이전트</Text>
        <Text style={styles.value}>{selection.selectedAgentName}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.row} onPress={pickModel}>
        <Text style={styles.label}>모델</Text>
        <Text style={styles.value}>{selection.selectedModelPresetName}</Text>
      </TouchableOpacity>
      {selection.selectedModelPresetUsageWarning ? (
        <Text style={styles.warningBadge}>사용량 확인 지연</Text>
      ) : null}
      {selection.modelPresetSelectionInvalid ? (
        <Text style={styles.error} accessibilityRole="alert">
          선택한 모델을 이 노드에서 사용할 수 없습니다. 모델을 다시 선택해 주세요.
        </Text>
      ) : null}
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
      <View style={styles.actions}>
        <TouchableOpacity style={styles.action} onPress={() => setEditing(false)} disabled={pending}>
          <Text style={styles.cancel}>취소</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.action}
          onPress={save}
          disabled={
            pending
            || !selection.effectiveNodeId
            || !selection.agentId
            || selection.modelPresetSelectionInvalid
          }
          testID="task-default-assignment-save"
        >
          <Text style={styles.save}>{pending ? '저장 중…' : '직접 지정'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    summary: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.xs,
      minHeight: t.hitTarget.min,
    },
    person: {
      width: planner.contentIconFrame,
      height: planner.contentIconFrame,
      ...planner.typography.body,
      textAlign: 'center',
    },
    assignment: { color: t.colors.textPrimary, ...planner.typography.body, flexShrink: 1 },
    source: { color: t.colors.textTertiary, ...planner.typography.meta, marginLeft: 'auto', flexShrink: 1 },
    editor: { gap: t.spacing.xs },
    row: { flexDirection: 'row', alignItems: 'center', minHeight: planner.minHeight.context, gap: t.spacing.sm },
    label: { width: planner.statusColumn, color: t.colors.textSecondary, ...planner.typography.meta },
    value: { flex: 1, color: t.colors.textPrimary, ...planner.typography.body, textAlign: 'right' },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: t.spacing.md },
    action: {
      minWidth: planner.actionColumn,
      minHeight: planner.actionColumn,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancel: { color: t.colors.textSecondary, ...planner.typography.body },
    save: { color: t.colors.accent, ...planner.typography.body, fontWeight: '700' },
    error: { color: t.colors.errorText, ...planner.typography.meta },
    warningBadge: {
      alignSelf: 'flex-end',
      color: t.colors.textSecondary,
      ...planner.typography.meta,
    },
  });
}
