import React, { useEffect, useRef } from 'react';
import { EnrichedMarkdownTextInput, type EnrichedMarkdownTextInputInstance } from 'react-native-enriched-markdown';

export type MarkdownSelectionInputProps = Pick<
  React.ComponentProps<typeof EnrichedMarkdownTextInput>,
  'defaultValue' | 'style' | 'markdownStyle' | 'selectionColor' | 'onBlur'
>;

export function MarkdownSelectionInput(props: MarkdownSelectionInputProps) {
  const ref = useRef<EnrichedMarkdownTextInputInstance>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.setSelection(0, props.defaultValue?.length ?? 0);
  }, [props.defaultValue]);
  return <EnrichedMarkdownTextInput {...props} ref={ref} editable={false}
    autoFocus={false} multiline scrollEnabled={false} />;
}
