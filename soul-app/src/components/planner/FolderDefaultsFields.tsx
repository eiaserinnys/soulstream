import { useEffect, useMemo, useRef } from 'react';
import { ActionSheetIOS, Text } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { FolderExecutionDefaults } from '../../lib/folder-settings';
import { useTokens } from '../../theme';
import { SelectedModelPresetName } from '../sheets/SelectedModelPresetName';
import { useNewSessionSelection } from '../sheets/useNewSessionSelection';
import {
  buildAgentActionSheet,
  buildModelPresetActionSheet,
  buildNodeActionSheet,
  resolveAgentActionSheetSelection,
  resolveModelPresetActionSheetSelection,
  resolveNodeActionSheetSelection,
} from '../sheets/newSessionSelection';
import { GroupedGlassSheet } from './GroupedGlassSheet';
import { SessionSelectionRow } from './SessionSelectionRow';
import { makeStyles } from './SessionSuccessionSheet.styles';

export interface FolderDefaultsFieldsChange {
  value: FolderExecutionDefaults;
  valid: boolean;
}

/** Node, agent and model rows of the folder's own execution defaults. The value at mount is read once. */
export function FolderDefaultsFields({ api, initial, disabled, onChange }: {
  api: ApiClient | null;
  initial: FolderExecutionDefaults;
  disabled?: boolean;
  onChange(change: FolderDefaultsFieldsChange): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const opening = useRef(initial).current;
  const selection = useNewSessionSelection({
    visible: true, api, folders: [], settingsNodeId: null,
    defaultNodeId: opening.nodeId, defaultAgentId: opening.agentId, defaultModelPresetId: opening.modelPreset,
  });
  const node = selection.selectedNodeId;
  const agent = selection.agentId;
  const model = selection.selectedModelPresetId;
  const agentKnown = !agent || selection.agents.length === 0 || selection.agents.some((item) => item.id === agent);
  const valid = Boolean(node && agent && agentKnown && !selection.modelPresetSelectionInvalid);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    onChangeRef.current({ value: { nodeId: node, agentId: agent, modelPreset: model }, valid });
  }, [agent, model, node, valid]);

  const pickNode = () => {
    const sheet = buildNodeActionSheet(selection.nodes);
    ActionSheetIOS.showActionSheetWithOptions(sheet, (index) => {
      const picked = resolveNodeActionSheetSelection(index, selection.nodes, sheet.cancelButtonIndex);
      if (!picked.cancelled) {
        selection.setSelectedNodeId(picked.nodeId);
        selection.setAgentId(null);
        selection.setSelectedModelPresetId(null);
      }
    });
  };
  const pickAgent = () => {
    const sheet = buildAgentActionSheet(selection.agents);
    ActionSheetIOS.showActionSheetWithOptions(sheet, (index) => {
      const picked = resolveAgentActionSheetSelection(index, selection.agents, sheet.cancelButtonIndex);
      if (!picked.cancelled) selection.setAgentId(picked.agentId);
    });
  };
  const pickModel = () => {
    const sheet = buildModelPresetActionSheet(selection.modelPresets);
    ActionSheetIOS.showActionSheetWithOptions(sheet, (index) => {
      const picked = resolveModelPresetActionSheetSelection(index, selection.modelPresets, sheet.cancelButtonIndex);
      if (!picked.cancelled) selection.setSelectedModelPresetId(picked.modelPresetId);
    });
  };
  const unset = (muted: boolean | undefined) => <Text style={{ color: muted ? t.colors.textMuted : t.colors.textTertiary }}>선택</Text>;
  return <GroupedGlassSheet testID="folder-defaults-fields">
    <SessionSelectionRow testID="folder-defaults-node" label="노드" accessibilityLabel="기본 노드" styles={styles}
      value={node ?? unset(disabled)} disabled={disabled} onPress={pickNode} />
    <SessionSelectionRow testID="folder-defaults-agent" label="에이전트" accessibilityLabel="기본 에이전트" styles={styles}
      value={agent ? selection.selectedAgentName : unset(disabled || !node)} disabled={disabled || !node} onPress={pickAgent} />
    <SessionSelectionRow testID="folder-defaults-model" label="모델" accessibilityLabel="기본 모델" styles={styles} valueLines={2}
      value={agent || model ? <SelectedModelPresetName selection={selection} /> : unset(disabled || !node)} disabled={disabled || !node} onPress={pickModel} />
  </GroupedGlassSheet>;
}
