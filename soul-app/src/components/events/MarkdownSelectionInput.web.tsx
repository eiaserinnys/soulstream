import React, { useEffect, useRef } from 'react';
import { TextInput } from 'react-native';
import type { MarkdownSelectionInputProps } from './MarkdownSelectionInput';

// EnrichedMarkdownTextInput has no web implementation. This boundary shows
// selectable source text; it does not represent the iOS formatted selection UI.
export function MarkdownSelectionInput({ defaultValue, style, selectionColor, onBlur }: MarkdownSelectionInputProps) {
  const ref = useRef<TextInput>(null);
  useEffect(() => { ref.current?.focus(); }, [defaultValue]);
  return <TextInput ref={ref} testID="message-selection-markdown-source"
    value={defaultValue} editable={false} multiline scrollEnabled={false}
    style={style} selectionColor={selectionColor} onBlur={onBlur}
    selection={{ start: 0, end: defaultValue?.length ?? 0 }} />;
}
