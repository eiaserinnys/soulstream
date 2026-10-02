import React, { useEffect, useMemo, useState } from 'react';
import { ActionSheetIOS, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { CardAssignment } from '../../api/cardTypes';
import { useSettingsStore } from '../../store/settingsStore';
import { useSessionStore } from '../../store/sessionStore';
import { buildPlannerContextPresentation } from '../../lib/planner-context-presentation';
import { useNewSessionSelection } from '../sheets/useNewSessionSelection';
import { buildNodeActionSheet, buildAgentActionSheet, buildModelPresetActionSheet,
  resolveNodeActionSheetSelection, resolveAgentActionSheetSelection, resolveModelPresetActionSheetSelection } from '../sheets/newSessionSelection';
import { AppModalSurface } from '../AppModalSurface';
import { GlassButton } from '../GlassSurface';
import { useTokens } from '../../theme';
import { FolderSelectionSheet } from './FolderSelectionSheet';
import { cardStyles } from './Card.styles';

export function CardAssignmentSheet({ api, value, onClose, onSave, mode = 'assignment', includeFolder = true, folderOnly = false, draftScope }: {
  draftScope?: string;
  api: ApiClient | null; value: CardAssignment; onClose(): void;
  onSave(value: CardAssignment): Promise<void>; mode?: 'assignment' | 'move' | 'edit'; includeFolder?: boolean; folderOnly?: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => cardStyles(t), [t]);
  const folders = useSessionStore((state) => state.catalog.folders).filter((folder) => !folder.archived && folder.id !== 'llm' && folder.id !== 'claude');
  const settingsNodeId = useSettingsStore((state) => state.nodeId);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [defaults, setDefaults] = useState(value);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selection = useNewSessionSelection({ visible: true, api, folders, settingsNodeId,
    preserveAgentOnNodeChange: mode === 'edit', defaultFolderId: defaults.folderId, defaultNodeId: mode === 'edit' ? defaults.nodeId : defaults.nodeId ?? settingsNodeId,
    defaultAgentId: defaults.agentId, defaultModelPresetId: defaults.modelPreset });
  const [pickedFolderId, setPickedFolderId] = useState<string | null>(mode === 'assignment' && !value.agentId && value.folderId ? value.folderId : null);
  useEffect(() => {
    if (!api || !pickedFolderId) return;
    let current = true;
    setPending(true);
    setError(null);
    void api.getPlannerFolder(pickedFolderId,{includeCompleted:false}).then(async (detail) => {
      const parent = folders.find((folder) => folder.id === detail.folder.parentFolderId);
      const inherited = parent?.projectPageId ? await api.getPage(parent.projectPageId) : null;
      const { assignment } = buildPlannerContextPresentation({ projectName: parent?.name ?? '폴더',
        projectBlocks: inherited?.blocks ?? [], folderBlocks: detail.blocks });
      if (current) setDefaults({ folderId: pickedFolderId, nodeId: assignment?.nodeId ?? null,
        agentId: assignment?.agentId ?? null, modelPreset: assignment?.modelPreset ?? null });
    }).catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (current) setPending(false); });
    return () => { current = false; };
  // Catalog is already the selection inventory; changing it must not reset a draft.
  }, [api, pickedFolderId]);
  const pickFolder = () => setPickingFolder(true);
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
      const result = resolveModelPresetActionSheetSelection(index, selection.modelPresets, sheet.cancelButtonIndex);
      if (!result.cancelled) selection.setSelectedModelPresetId(result.modelPresetId);
    });
  };
  const save = async () => {
    if (!selection.selectedFolderId || pending) return;
    setPending(true); setError(null);
    try {
      await onSave({ folderId: selection.selectedFolderId, nodeId: mode === 'edit' ? selection.selectedNodeId : selection.effectiveNodeId ?? null,
        agentId: selection.agentId, modelPreset: selection.selectedModelPresetId });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  const rows = [...(includeFolder || mode === 'move' ? [{ label: '폴더', value: selection.selectedFolderName, pick: pickFolder }] : []),
    ...(mode === 'move' || folderOnly ? [] : [{ label: '노드', value: selection.selectedNodeName, pick: pickNode },
      { label: '에이전트', value: selection.selectedAgentName, pick: pickAgent },
      { label: '모델', value: selection.selectedModelPresetName, pick: pickModel }])];
  if (pickingFolder) return <FolderSelectionSheet draftScope={draftScope ?? `assignment:${mode}:${value.folderId ?? 'all'}`} api={api} onClose={() => setPickingFolder(false)} onSelect={(id) => {
    if (mode !== 'assignment' || folderOnly) selection.setSelectedFolderId(id);
    else setPickedFolderId(id);
  }} />;
  return <AppModalSurface visible modalId="modal_card_assignment" variant="expanded" presentationStyle="pageSheet" onRequestClose={onClose}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>{folderOnly ? '폴더 선택' : mode === 'move' ? '폴더 이동' : '맡길 대상'}</Text>
      {rows.map((row) => <TouchableOpacity key={row.label} style={styles.row} disabled={pending} onPress={row.pick}>
        <Text style={styles.body}>{row.label}</Text><Text style={[styles.body, { flex: 1, textAlign: 'right' }]} numberOfLines={1}>{row.value}</Text>
      </TouchableOpacity>)}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {selection.modelPresetSelectionInvalid && mode !== 'move' && !folderOnly ? <Text style={styles.error}>선택한 모델을 이 노드에서 사용할 수 없습니다.</Text> : null}
      <View style={styles.actions}>
        <GlassButton onPress={onClose}><Text style={styles.body}>취소</Text></GlassButton>
        <GlassButton onPress={() => { void save(); }} disabled={pending || !selection.selectedFolderId || (mode !== 'move' && !folderOnly && ((mode !== 'edit' && !selection.agentId) || selection.modelPresetSelectionInvalid))}>
          <Text style={styles.actionText}>확인</Text>
        </GlassButton>
      </View>
    </ScrollView>
  </AppModalSurface>;
}
