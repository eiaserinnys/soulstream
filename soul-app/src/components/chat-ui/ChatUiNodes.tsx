import React from 'react';
import { Platform, Text, View } from 'react-native';
import { isNodeVisible, renderParts, unreferencedSourceKeys, type Node, type NormalizedChatUiDocumentV1 } from '@soulstream/chat-ui';
import { useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { ChatUiField } from './ChatUiFields';
import { ChatUiSlider } from './ChatUiSlider';
import { ChatUiSourceLink } from './ChatUiSourceLink';
import type { ChatUiController } from './ChatUiControllerProvider';

type Props = { doc: NormalizedChatUiDocumentV1; controller: ChatUiController; presentation: 'default' | 'manuscript' };
export function ChatUiNodes({ doc, controller, presentation }: Props) {
  const t = useTokens();
  const body = { fontSize: t.chatFontSize.body, lineHeight: t.chatFontSize.body * (presentation === 'manuscript' ? 1.6 : t.lineHeightRatio), color: t.colors.textPrimary };
  const meta = { fontSize: t.chatFontSize.meta, lineHeight: t.chatFontSize.meta * t.lineHeightRatio, color: t.colors.textSecondary };
  const stack = { gap: t.spacing.md, minWidth: 0 };
  const row = { flexDirection: 'row' as const, alignItems: 'center' as const, flexWrap: 'wrap' as const, gap: t.spacing.sm, minWidth: 0 };
  const remaining = unreferencedSourceKeys(doc);
  // Source membership is defined by the public contract. This display set only
  // avoids repeating an uncited source both in an expanded entity and the footer.
  const expandedSources = new Set<string>();
  const collectExpanded = (nodes: Node[]) => nodes.forEach(node => {
    if (!isNodeVisible(doc, controller.state, node)) return;
    if (node.kind === 'group') collectExpanded(node.children);
    if (node.kind === 'entity' && node.source && controller.expanded[node.id]) expandedSources.add(node.source);
  });
  collectExpanded(doc.body);
  const button = (label: string, press: () => void) => <GlassButton
    variant={presentation === 'manuscript' ? 'paper' : 'secondary'} size="compact" accessibilityLabel={label}
    onPress={press} style={{ maxWidth: '100%' }}><Text style={[body, { flexShrink: 1 }]}>{label}</Text></GlassButton>;
  const nodes = (items: Node[]): React.ReactNode => items.filter(node => isNodeVisible(doc, controller.state, node)).map(node => {
    switch (node.kind) {
      case 'heading': return <Text key={node.id} accessibilityRole="header" {...(Platform.OS === 'web' ? { 'aria-level': node.level } : {})} style={[body, { fontWeight: '700' }]}>{renderParts(doc, controller.state, node.parts)}</Text>;
      case 'text': return <Text key={node.id} testID={`chat-ui-node-${node.id}`} style={[body, node.emphasis === 'strong' && { fontWeight: '700' }]}>{renderParts(doc, controller.state, node.parts)}</Text>;
      case 'caption': return <Text key={node.id} style={meta}>{renderParts(doc, controller.state, node.parts)}</Text>;
      case 'group': return <View key={node.id} style={node.layout === 'stack' ? stack : row}>{nodes(node.children)}</View>;
      case 'slider': return <ChatUiSlider key={node.id} doc={doc} fieldKey={node.field} label={node.label} controller={controller} presentation={presentation} />;
      case 'checkbox': return <ChatUiField key={node.id} fieldKey={node.field} field={doc.fields[node.field]} label={node.label} controller={controller} presentation={presentation} />;
      case 'form': return <View key={node.id} style={stack}>
        {node.items.map(item => <ChatUiField key={item.field} fieldKey={item.field} field={doc.fields[item.field]} label={item.label} controller={controller} presentation={presentation} />)}
        <View style={row}>{button(node.submitLabel, () => { void controller.action(node.id, node.action); })}</View>
      </View>;
      case 'button': return <View key={node.id} style={{ alignSelf: 'flex-start', maxWidth: '100%' }}>{button(node.label, () => { void controller.action(node.id, node.action); })}</View>;
      case 'entity': return <View key={node.id} style={{ gap: t.spacing.sm, minWidth: 0 }}>
        <GlassButton variant={presentation === 'manuscript' ? 'paper' : 'secondary'} size="compact"
          accessibilityLabel={node.label} accessibilityState={{ expanded: !!controller.expanded[node.id] }}
          onPress={() => controller.toggleEntity(node.id)} style={{ alignSelf: 'stretch' }} contentStyle={{ justifyContent: 'space-between' }}>
          <Text style={[body, { flexShrink: 1 }]}>{node.label}</Text>
        </GlassButton>
        {controller.expanded[node.id] && <>
          <Text style={body}>{renderParts(doc, controller.state, node.details)}</Text>
          {node.source && remaining.includes(node.source) && <ChatUiSourceLink source={doc.sources[node.source]} />}
        </>}
      </View>;
      case 'citation': return <ChatUiSourceLink key={node.id} source={doc.sources[node.source]} />;
    }
  });
  return <View testID="chat-ui-rich" style={stack}>
    {doc.title && <Text accessibilityRole="header" style={[body, { fontWeight: '700' }]}>{doc.title}</Text>}
    {nodes(doc.body)}
    {doc.assumptions.map((assumption, index) => <Text key={`assumption-${index}`} style={meta}>{assumption}</Text>)}
    {remaining.filter(key => !expandedSources.has(key)).map(key => <ChatUiSourceLink key={key} source={doc.sources[key]} />)}
  </View>;
}
