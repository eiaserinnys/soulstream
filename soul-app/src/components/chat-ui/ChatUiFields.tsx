import React, { useEffect, useId, useState } from 'react';
import { Text, View } from 'react-native';
import type { Field } from '@soulstream/chat-ui';
import { useTokens } from '../../theme';
import { SettingsInput, useSettingsFormStyles } from '../settings/SettingsFormParts';
import { SettingsOptionRow } from '../settings/SettingsOptionRow';
import { CardItemCheckbox } from '../CardItemCheckbox';
import type { ChatUiController } from './ChatUiControllerProvider';

export function ChatUiFieldLabel({ children, inline = false }: { children: string; inline?: boolean }) {
  const t = useTokens();
  const styles = useSettingsFormStyles();
  return <Text style={[styles.label, inline && { marginBottom: 0 }, { fontSize: t.chatFontSize.body, lineHeight: t.chatFontSize.body * t.lineHeightRatio }]}>{children}</Text>;
}

type Props = { fieldKey: string; field: Field; label: string; controller: ChatUiController; presentation: 'default' | 'manuscript' };
export function ChatUiField({ fieldKey, field, label, controller, presentation }: Props) {
  const t = useTokens();
  const value = controller.state.values[fieldKey];
  if (field.type === 'number') return <ChatUiNumberInput fieldKey={fieldKey} label={label} controller={controller} presentation={presentation} />;
  if (field.type === 'text') return <SettingsInput variant="chat" presentation={presentation} label={label} value={String(value)}
    onChangeText={text => controller.set(fieldKey, text)} />;
  if (field.type === 'boolean') return <CardItemCheckbox variant="chat" label={label} checked={value === true}
    onPress={() => controller.set(fieldKey, !value)} />;
  if (field.type === 'choice') return <View>
    <ChatUiFieldLabel>{label}</ChatUiFieldLabel>
    <SettingsOptionRow variant="chat" presentation={presentation} label={label} selected={String(value)} options={field.options}
      emptyLabel="선택 없음" onSelect={id => controller.set(fieldKey, id)} />
  </View>;
  const selected = value as string[];
  return <View style={{ gap: t.spacing.sm }}>
    <ChatUiFieldLabel>{label}</ChatUiFieldLabel>
    <View>{field.options.map(option => <CardItemCheckbox key={option.id} variant="chat" label={option.label}
      checked={selected.includes(option.id)} onPress={() => controller.set(fieldKey,
        selected.includes(option.id) ? selected.filter(id => id !== option.id) : [...selected, option.id])} />)}</View>
  </View>;
}

export function ChatUiNumberInput({ fieldKey, label, accessibilityLabel = label, controller, presentation }: {
  fieldKey: string; label: string; accessibilityLabel?: string; controller: ChatUiController; presentation: 'default' | 'manuscript';
}) {
  const value = controller.state.values[fieldKey] as number;
  const [draft, setDraft] = useState(String(value));
  const editorId = useId();
  // Typing updates the common state without replacing this editor's draft.
  // Outside controls sync the registered editor even when the value is unchanged.
  useEffect(() => { setDraft(String(value)); }, [controller.sessionId, controller.resetEpoch]);
  useEffect(() => controller.registerNumberEditor(editorId, fieldKey, next => setDraft(String(next))),
    [controller.registerNumberEditor, editorId, fieldKey]);
  const commit = () => setDraft(String(value));
  return <SettingsInput variant="chat" presentation={presentation} label={label} accessibilityLabel={accessibilityLabel} value={draft}
    keyboardType="decimal-pad" inputMode="decimal"
    onChangeText={text => {
      setDraft(text);
      if (text.trim() && Number.isFinite(Number(text))) controller.set(fieldKey, Number(text), editorId);
    }}
    onBlur={commit} onSubmitEditing={commit} />;
}
