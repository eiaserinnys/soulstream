import React, { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTokens, type DesignTokens } from '../../theme';
import { BackendNodeCard } from './BackendNodeCard';
import { NodeProviderSections } from './NodeProviderSections';
import { SettingsDivider, SettingsSection } from './SettingsSection';

type BackendNode = { nodeId: string };

export function AIBackendSettingsSection({
  flattened,
  serverUrl,
  mode,
  currentNodeId,
  nodes,
  loadingNodes,
}: {
  flattened: boolean;
  serverUrl: string;
  mode: 'single' | 'orchestrator' | null;
  currentNodeId: string;
  nodes: BackendNode[];
  loadingNodes: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const visibleNodes =
    mode === 'orchestrator'
      ? nodes
      : mode === 'single' && currentNodeId
        ? [{ nodeId: currentNodeId }]
        : [];

  return (
    <SettingsSection id="backends" title="AI 백엔드" flattened={flattened}>
      {!serverUrl || mode === null ? (
        <View style={styles.state}>
          {!serverUrl ? (
            <Text style={styles.notice}>연결 설정을 저장하면 노드를 표시합니다.</Text>
          ) : (
            <ActivityIndicator size="small" color={t.colors.accent} />
          )}
        </View>
      ) : loadingNodes ? (
        <View style={styles.state}>
          <ActivityIndicator size="small" color={t.colors.accent} />
        </View>
      ) : visibleNodes.length === 0 ? (
        <View style={styles.state}>
          <Text style={styles.notice}>연결된 노드가 없습니다.</Text>
        </View>
      ) : (
        visibleNodes.map((node, index) => (
          <React.Fragment key={node.nodeId}>
            {index > 0 ? <SettingsDivider /> : null}
            <BackendNodeCard
              nodeId={node.nodeId}
              defaultExpanded={node.nodeId === currentNodeId || visibleNodes.length === 1}
            >
              <NodeProviderSections
                nodeId={node.nodeId}
                serverUrl={serverUrl}
              />
            </BackendNodeCard>
          </React.Fragment>
        ))
      )}
    </SettingsSection>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    state: {
      minHeight: t.foundation.minHeight.row,
      alignItems: 'center',
      justifyContent: 'center',
      padding: t.cardLayout.padding,
    },
    notice: {
      ...t.foundation.typography.meta,
      color: t.colors.textMuted,
      textAlign: 'center',
    },
  });
}
