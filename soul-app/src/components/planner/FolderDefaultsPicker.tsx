import React, { useMemo, useRef } from 'react';
import { ActionSheetIOS, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { InitialFolderSessionDefaults } from '../../api/initialFolderContext';
import { useTokens } from '../../theme';
import { useNewSessionSelection } from '../sheets/useNewSessionSelection';
import { buildAgentActionSheet, buildModelPresetActionSheet, buildNodeActionSheet,
  resolveAgentActionSheetSelection, resolveModelPresetActionSheetSelection, resolveNodeActionSheetSelection } from '../sheets/newSessionSelection';
import { GroupedGlassSheet } from './GroupedGlassSheet';
import { SessionSelectionRow } from './SessionSelectionRow';
import { makeStyles } from './SessionSuccessionSheet.styles';

/** Inline content of NewFolderSheet: confirmation owns the only parent write. */
export function FolderDefaultsPicker({ api, value, onSave, onClose }: {
  api: ApiClient | null; value?: InitialFolderSessionDefaults;
  onSave(value: InitialFolderSessionDefaults | undefined): void; onClose(): void;
}) {
  const t = useTokens(); const styles = useMemo(() => makeStyles(t), [t]);
  const finished = useRef(false);
  const selection = useNewSessionSelection({ visible: true, api, folders: [], settingsNodeId: null,
    defaultNodeId: value?.nodeId ?? null, defaultAgentId: value?.agentId ?? null, defaultModelPresetId: value?.modelPreset ?? null });
  const node = selection.selectedNodeId;
  const agent = selection.agentId;
  const empty = !node && !agent && !selection.selectedModelPresetId;
  const valid = empty || Boolean(node && agent && selection.agents.some(item => item.id === agent)
    && selection.nodes.some(item => item.nodeId === node) && !selection.modelPresetSelectionInvalid
    && (!selection.selectedModelPresetId || selection.modelPresets.some(item => item.id === selection.selectedModelPresetId && item.available)));
  const finish = (next: InitialFolderSessionDefaults | undefined) => {
    if (finished.current) return; finished.current = true; onSave(next); onClose();
  };
  const pickNode = () => {
    const sheet = buildNodeActionSheet(selection.nodes);
    ActionSheetIOS.showActionSheetWithOptions(sheet, index => {
      const picked = resolveNodeActionSheetSelection(index, selection.nodes, sheet.cancelButtonIndex);
      if (!picked.cancelled) { selection.setSelectedNodeId(picked.nodeId); selection.setAgentId(null); selection.setSelectedModelPresetId(null); }
    });
  };
  const pickAgent = () => {
    const sheet = buildAgentActionSheet(selection.agents);
    ActionSheetIOS.showActionSheetWithOptions(sheet, index => {
      const picked = resolveAgentActionSheetSelection(index, selection.agents, sheet.cancelButtonIndex);
      if (!picked.cancelled) selection.setAgentId(picked.agentId);
    });
  };
  const pickModel = () => {
    const sheet = buildModelPresetActionSheet(selection.modelPresets);
    ActionSheetIOS.showActionSheetWithOptions(sheet, index => {
      const picked = resolveModelPresetActionSheetSelection(index, selection.modelPresets, sheet.cancelButtonIndex);
      if (!picked.cancelled) selection.setSelectedModelPresetId(picked.modelPresetId);
    });
  };
  return <>
    <View style={styles.header}>
      <TouchableOpacity accessibilityLabel="기본 환경 취소" style={styles.headerButton} onPress={onClose}><Text style={styles.headerAction}>취소</Text></TouchableOpacity>
      <Text style={styles.title}>기본 실행 환경</Text>
      <TouchableOpacity accessibilityLabel="기본 환경 확인" style={styles.headerButton} disabled={!valid} onPress={() => {
        if (!valid) return;
        finish(empty ? undefined : { nodeId: node!, agentId: agent!, ...(selection.selectedModelPresetId ? { modelPreset: selection.selectedModelPresetId } : {}) });
      }}><Text style={[styles.headerAction, !valid && styles.disabled]}>확인</Text></TouchableOpacity>
    </View>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.purpose}>확인한 설정만 폴더에 반영됩니다. 지정하지 않으면 상위 설정을 따릅니다.</Text>
      <GroupedGlassSheet>
        <SessionSelectionRow testID="new-task-default-node" label="노드" value={node ?? '미지정'} accessibilityLabel="기본 노드" styles={styles} onPress={pickNode} />
        <SessionSelectionRow testID="new-task-default-agent" label="에이전트" value={agent ?? '미지정'} accessibilityLabel="기본 에이전트" styles={styles} disabled={!node} onPress={pickAgent} />
        <SessionSelectionRow testID="new-task-default-model" label="모델" value={selection.selectedModelPresetId ?? '미지정'} accessibilityLabel="기본 모델" styles={styles} disabled={!node} onPress={pickModel} />
      </GroupedGlassSheet>
      {!valid ? <Text style={styles.selectionError} accessibilityRole="alert">기본 담당은 노드와 에이전트를 모두 선택하고 사용 가능한 모델을 지정해야 합니다.</Text> : null}
      <TouchableOpacity accessibilityLabel="기본 환경 제거" style={styles.headerButton} onPress={() => finish(undefined)}><Text style={styles.headerAction}>제거하고 상속 사용</Text></TouchableOpacity>
    </ScrollView>
  </>;
}
