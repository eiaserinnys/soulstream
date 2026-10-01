import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextInputSelectionChangeEventData,
  type TextStyle,
} from 'react-native';
import type { MarkdownTextInputStyle } from 'react-native-enriched-markdown';
import { MarkdownSelectionInput } from './MarkdownSelectionInput';
import {
  DESIGN_SPACING,
  DESIGN_TYPOGRAPHY,
  useTokens,
} from '../../theme';
import type { MessageSelectionModel } from './message-selection-model';

interface Props {
  model: MessageSelectionModel;
  onDone: () => void;
  textStyle?: StyleProp<TextStyle>;
  markdownStyle?: MarkdownTextInputStyle;
  actionColor?: string;
  variant?: 'assistant' | 'user' | 'intervention';
}

export function MessageTextSelectionView({
  model,
  onDone,
  textStyle,
  markdownStyle,
  actionColor,
  variant = 'assistant',
}: Props) {
  const t = useTokens();
  const plainRef = useRef<TextInput>(null);
  const completedRef = useRef(false);
  const [selection, setSelection] = useState({
    start: 0,
    end: model.text.length,
  });
  const selectionColor = resolveMessageSelectionColor(t, variant);

  const complete = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    onDone();
  }, [onDone]);

  useEffect(() => {
    completedRef.current = false;
    setSelection({ start: 0, end: model.text.length });
    if (model.kind === 'markdown') {
      return;
    }
    plainRef.current?.focus();
  }, [model.kind, model.text]);

  const handleSelectionChange = useCallback((
    event: NativeSyntheticEvent<TextInputSelectionChangeEventData>,
  ) => {
    setSelection(event.nativeEvent.selection);
  }, []);

  return (
    <View
      testID="message-selection-view"
      onTouchStart={(event) => event.stopPropagation()}
    >
      {model.kind === 'markdown' ? (
        <MarkdownSelectionInput
          defaultValue={model.text}
          style={StyleSheet.flatten([styles.input, textStyle])}
          markdownStyle={markdownStyle}
          selectionColor={selectionColor}
          onBlur={complete}
        />
      ) : (
        <TextInput
          ref={plainRef}
          testID="message-selection-plain"
          value={model.text}
          editable={false}
          autoFocus={false}
          showSoftInputOnFocus={false}
          multiline
          scrollEnabled={false}
          selection={selection}
          selectionColor={selectionColor}
          onSelectionChange={handleSelectionChange}
          onBlur={complete}
          style={[styles.input, textStyle]}
        />
      )}
      <Pressable
        testID="message-selection-done"
        accessibilityRole="button"
        accessibilityLabel="텍스트 선택 완료"
        onPress={complete}
        style={[
          styles.doneButton,
          { minWidth: t.foundation.hitTarget, minHeight: t.foundation.hitTarget },
        ]}
      >
        <Text
          style={[styles.doneText, { color: actionColor ?? t.colors.accent }]}
        >
          완료
        </Text>
      </Pressable>
    </View>
  );
}

export function resolveMessageSelectionColor(
  t: ReturnType<typeof useTokens>,
  variant: NonNullable<Props['variant']>,
): string {
  if (variant === 'user') return t.colors.accentText;
  if (variant === 'intervention') return t.colors.interventionText;
  return t.colors.accent;
}

const styles = StyleSheet.create({
  input: {
    padding: 0,
    margin: 0,
    minHeight: 24,
  },
  doneButton: {
    alignSelf: 'flex-end',
    marginTop: DESIGN_SPACING.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: DESIGN_SPACING.sm,
  },
  doneText: {
    fontSize: DESIGN_TYPOGRAPHY.body,
    fontWeight: '600',
  },
});
