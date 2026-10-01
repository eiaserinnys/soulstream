import React, { useMemo } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { CardAssignment } from '../../api/cardTypes';
import { useSettingsStore } from '../../store/settingsStore';
import { useSessionStore } from '../../store/sessionStore';
import { useNewSessionSelection } from '../sheets/useNewSessionSelection';
import { useTokens } from '../../theme';
import { AppModalSurface } from '../AppModalSurface';
import { GlassButton } from '../GlassSurface';
import { GroupedGlassRow, GroupedGlassSheet } from './GroupedGlassSheet';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { cardStyles } from './Card.styles';

export function ExecutionSelectionSheet({ api, value, onSave, onClose }: {
  api: ApiClient | null; value: CardAssignment; onSave(value: CardAssignment): void; onClose(): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => cardStyles(t), [t]);
  const settings = useSettingsStore();
  const folders = useSessionStore((state) => state.catalog.folders);
  const selection = useNewSessionSelection({ visible: true, api, folders, settingsNodeId: settings.nodeId,
    defaultFolderId: value.folderId, defaultNodeId: value.nodeId, defaultAgentId: value.agentId,
    defaultModelPresetId: value.modelPreset, preserveAgentOnNodeChange: true });
  return <AppModalSurface visible modalId="modal_card_assignment" variant="expanded" presentationStyle="pageSheet" onRequestClose={onClose}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>실행 대상</Text>
      <View testID="execution-agents" style={styles.section}><PlannerSectionHeader title="에이전트" />
        <GroupedGlassSheet>{selection.agents.map((agent) => <GroupedGlassRow compact testID={`execution-agent-${agent.id}`} key={agent.id} accessibilityLabel={`에이전트 ${agent.name ?? agent.id}`} selected={selection.agentId === agent.id}
          style={styles.padded} onPress={() => { selection.setAgentId(agent.id); selection.setSelectedModelPresetId(agent.default_preset ?? null); }}>
          <View style={styles.actions}>{agent.portraitUrl ? <Image source={{ uri: agent.portraitUrl.startsWith('/') ? `${settings.serverUrl}${agent.portraitUrl}` : agent.portraitUrl }}
            style={{ width: t.avatarSize.compact, height: t.avatarSize.compact, borderRadius: t.foundation.radius.round }} /> : null}<Text style={styles.body}>{agent.name ?? agent.id}</Text></View>
        </GroupedGlassRow>)}</GroupedGlassSheet>
      </View>
      <View testID="execution-nodes" style={styles.section}><PlannerSectionHeader title="노드" />
        <GroupedGlassSheet>{selection.nodes.map((node) => <GroupedGlassRow compact testID={`execution-node-${node.nodeId}`} key={node.nodeId} accessibilityLabel={`노드 ${node.nodeId}`} selected={selection.effectiveNodeId === node.nodeId} style={styles.padded}
          onPress={() => selection.setSelectedNodeId(node.nodeId)}><Text style={styles.body}>{node.nodeId}</Text></GroupedGlassRow>)}</GroupedGlassSheet>
      </View>
      <View testID="execution-models" style={styles.section}><PlannerSectionHeader title="모델" />
        <GroupedGlassSheet>{selection.modelPresets.map((model) => <GroupedGlassRow compact testID={`execution-model-${model.id}`} key={model.id} accessibilityLabel={`모델 ${model.label}`} selected={selection.effectiveModelPresetId === model.id}
          disabled={!model.available} style={styles.padded} onPress={() => selection.setSelectedModelPresetId(model.id)}><Text style={styles.body}>{model.label}</Text>
          {!model.available && model.reason_label ? <Text style={styles.meta}>{model.reason_label}</Text> : null}</GroupedGlassRow>)}</GroupedGlassSheet>
      </View>
      <View style={styles.actions}><GlassButton onPress={onClose}><Text style={styles.body}>닫기</Text></GlassButton>
        <GlassButton accessibilityLabel="실행 대상 확인" disabled={!selection.agentId || !selection.effectiveNodeId || selection.modelPresetSelectionInvalid}
          onPress={() => { onSave({ folderId: value.folderId, agentId: selection.agentId, nodeId: selection.effectiveNodeId ?? null, modelPreset: selection.effectiveModelPresetId }); onClose(); }}><Text style={styles.actionText}>확인</Text></GlassButton>
      </View>
    </ScrollView>
  </AppModalSurface>;
}
