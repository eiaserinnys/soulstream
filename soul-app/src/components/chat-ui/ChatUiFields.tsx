import React, { useEffect, useId, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
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
  if (field.type === 'number') return <ChatUiNumberInput fieldKey={fieldKey} label={label} controller={controller} />;
  if (field.type === 'text') return <SettingsInput variant="chat" label={label} value={String(value)}
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

export function ChatUiNumberInput({ fieldKey, label, accessibilityLabel = label, controller }: {
  fieldKey: string; label: string; accessibilityLabel?: string; controller: ChatUiController;
}) {
  const value = controller.state.values[fieldKey] as number;
  const [draft, setDraft] = useState(String(value));
  const input = useRef<TextInput | null>(null);
  const editorId = useId();
  useEffect(() => { setDraft(String(value)); }, [value, controller.resetEpoch]);
  const commit = (focusInvalid = true) => {
    if (!draft.trim() || !Number.isFinite(Number(draft))) { if (focusInvalid) input.current?.focus(); return false; }
    const next = controller.set(fieldKey, Number(draft));
    setDraft(String(next.values[fieldKey]));
    return true;
  };
  const commitRef = useRef(commit); commitRef.current = commit;
  useEffect(() => controller.registerNumberEditor(editorId, () => commitRef.current()), [controller.registerNumberEditor, editorId]);
  return <SettingsInput variant="chat" label={label} accessibilityLabel={accessibilityLabel} value={draft}
    keyboardType="decimal-pad" inputMode="decimal"
    onChange={event => { input.current = event.currentTarget as unknown as TextInput; }}
    onChangeText={text => {
      setDraft(text);
      // Preserve incomplete edits such as an empty string or a trailing decimal.
      // Range and step normalization always belong to the common reducer.
      if (/^-?\d+(\.\d+)?$/.test(text) && Number.isFinite(Number(text))) controller.set(fieldKey, Number(text));
    }}
    onEndEditing={() => commit(false)} onSubmitEditing={() => commit()} />;
}
