import React from 'react';
import { Text, View } from 'react-native';
import NativeSlider from '@react-native-community/slider';
import { renderParts, type NormalizedChatUiDocumentV1 } from '@soulstream/chat-ui';
import { useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { ChatUiFieldLabel, ChatUiNumberInput } from './ChatUiFields';
import type { ChatUiController } from './ChatUiControllerProvider';

export function ChatUiSlider({ doc, fieldKey, label, controller, presentation }: {
  doc: NormalizedChatUiDocumentV1; fieldKey: string; label: string; controller: ChatUiController; presentation: 'default' | 'manuscript';
}) {
  const t = useTokens();
  const field = doc.fields[fieldKey];
  if (field.type !== 'number') throw Error('slider 필드는 숫자여야 합니다.');
  const value = controller.state.values[fieldKey] as number;
  const body = { fontSize: t.chatFontSize.body, lineHeight: t.chatFontSize.body * t.lineHeightRatio, color: t.colors.textPrimary };
  return <View style={{ gap: t.spacing.sm }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.spacing.sm }}>
      <ChatUiFieldLabel inline>{label}</ChatUiFieldLabel>
      <Text style={body}>{renderParts(doc, controller.state, [{ value: { field: fieldKey } }])}</Text>
    </View>
    <NativeSlider testID={`chat-ui-slider-${fieldKey}`} accessibilityLabel={`${label} 슬라이더`}
      value={value} minimumValue={field.min} maximumValue={field.max} step={field.step}
      onValueChange={next => controller.set(fieldKey, next)}
      minimumTrackTintColor={t.colors.accent} maximumTrackTintColor={t.colors.border} thumbTintColor={t.colors.accent}
      style={{ width: '100%', height: t.hitTarget.min }} />
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
      <GlassButton variant={presentation === 'manuscript' ? 'paper' : 'secondary'} size="compact" iconOnly
        accessibilityLabel={`${label} 줄이기`} onPress={() => controller.set(fieldKey, value - field.step)}><Text style={body}>−</Text></GlassButton>
      <View style={{ flex: 1, minWidth: 0 }}><ChatUiNumberInput fieldKey={fieldKey} label="" accessibilityLabel={label} controller={controller} presentation={presentation} /></View>
      <GlassButton variant={presentation === 'manuscript' ? 'paper' : 'secondary'} size="compact" iconOnly
        accessibilityLabel={`${label} 늘리기`} onPress={() => controller.set(fieldKey, value + field.step)}><Text style={body}>+</Text></GlassButton>
    </View>
  </View>;
}
