import { useTextInputContentHeight } from './useTextInputContentHeight';
import React from 'react';
import {
  ActivityIndicator,
  Platform,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { GlassSurface } from '../GlassSurface';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { createSessionVisualRoles, useTokens } from '../../theme';
import { makeStyles } from './ChatBody.styles';
import { AttachmentPickerButton } from './AttachmentPickerButton';

interface Props {
  placeholder?: string;
  inputAccessibilityLabel?: string;
  sendAccessibilityLabel?: string;
  sendDisabled?: boolean;
  input: string;
  onChangeInput: (text: string) => void;
  onPickAttachment: () => void;
  onSend: () => void;
  uploading: boolean;
  sending: boolean;
  hasPendingOptimistic?: boolean;
  disabled?: boolean;
  interruptControls?: React.ReactNode;
  voiceControls: React.ReactNode;
  minimumBottomPadding?: number;
  embedded?: boolean;
}

export function ChatComposer({
  input,
  onChangeInput,
  onPickAttachment,
  onSend,
  uploading,
  sending,
  hasPendingOptimistic = false,
  disabled = false,
  interruptControls,
  voiceControls,
  minimumBottomPadding = 0,
  embedded = false,
  placeholder = '메시지 입력...',
  inputAccessibilityLabel,
  sendAccessibilityLabel = '메시지 보내기',
  sendDisabled = false,
}: Props) {
  const t = useTokens();
  const styles = React.useMemo(() => makeStyles(t), [t]);
  const canSend = input.trim().length > 0 && !hasPendingOptimistic && !disabled && !sendDisabled;
  const controlsDisabled = uploading || disabled;
  const { fontScale } = useWindowDimensions();
  const composer = createSessionVisualRoles(t).chat.composer;
  const lineHeight = t.chatFontSize.body * t.lineHeightRatio * fontScale;
  const singleLineHeight = Math.max(composer.contentMinHeight, lineHeight + composer.inputPaddingVertical * 2);
  const isEmpty = input.length === 0;
  const measurement = useTextInputContentHeight(input, lineHeight);
  const measuredHeight = input ? measurement.contentHeight : 0;
  const multilineExpanded = measuredHeight > singleLineHeight + 1;
  const inputHeight = Math.min(styles.composerTextInput.maxHeight, Math.max(singleLineHeight, measuredHeight));
  const inputPadding = multilineExpanded ? composer.inputPaddingVertical : (singleLineHeight - lineHeight) / 2;
  const [iosAtMaxHeight, setIOSAtMaxHeight] = React.useState(false);
  React.useLayoutEffect(() => {
    if (isEmpty) setIOSAtMaxHeight(false);
  }, [isEmpty]);

  return (
    <View
      {...(embedded ? { testID: 'chat-composer-row' } : {})}
      style={[
        styles.inputRow,
        embedded ? { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0 }
          : { paddingBottom: Math.max(t.spacing.sm, minimumBottomPadding) },
      ]}
    >
      <GlassSurface
        role="glassDense"
        testID="chat-composer-box"
        style={styles.composerBox}
      >
        <View testID="chat-composer-content-row" style={[styles.composerContentRow, { alignItems: multilineExpanded ? 'flex-end' : 'center' }]}>
          <AttachmentPickerButton
            testID="chat-composer-attach-button"
            surfaceTestID="chat-composer-attach-visual"
            uploading={uploading}
            disabled={controlsDisabled}
            onPress={onPickAttachment}
          />
          <TextInput
            ref={measurement.ref}
            onContentSizeChange={measurement.onContentSizeChange}
            testID="chat-composer-text-input"
            // Empty iOS inputs collapse immediately; text keeps native intrinsic growth.
            style={[styles.composerTextInput, {
              ...(Platform.OS === 'ios'
                ? { minHeight: singleLineHeight, ...(isEmpty ? { height: singleLineHeight } : {}) }
                : { height: inputHeight }),
              paddingVertical: inputPadding,
              ...(Platform.OS === 'web' ? { whiteSpace: 'pre-wrap' } : {}),
            }]}
            onLayout={Platform.OS === 'ios' ? (event) => {
              // Once capped, content may change without another contentSize event.
              setIOSAtMaxHeight(event.nativeEvent.layout.height >= styles.composerTextInput.maxHeight);
            } : undefined}
            value={input}
            onChangeText={onChangeInput}
            placeholder={placeholder}
            accessibilityLabel={inputAccessibilityLabel}
            placeholderTextColor={t.colors.textPlaceholder}
            multiline
            {...(Platform.OS === 'web' ? { rows: 1 } : {})}
            scrollEnabled={Platform.OS === 'ios' ? !isEmpty && iosAtMaxHeight : measuredHeight > styles.composerTextInput.maxHeight}
            maxLength={4000}
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical={multilineExpanded ? 'top' : 'center'}
            editable={!disabled}
            accessibilityState={{ disabled }}
          />
          {interruptControls}
          <View testID="chat-composer-voice-slot" style={styles.voiceSlot}>
            {voiceControls}
          </View>
          <CompactTouchTarget
            testID="chat-composer-send-button"
            surfaceTestID="chat-composer-send-visual"
            accessibilityRole="button"
            accessibilityLabel={sendAccessibilityLabel}
            accessibilityState={{ disabled: !canSend }}
            disabled={!canSend}
            frameStyle={styles.composerControlFrame}
            surfaceStyle={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
            onPress={() => {
              if (canSend) onSend();
            }}
          >
            {sending ? (
              <ActivityIndicator
                testID="chat-composer-send-spinner"
                size="small"
                color={t.colors.accentText}
              />
            ) : (
              <Ionicons
                name="send"
                size={t.iconSize.standard}
                color={canSend ? t.colors.accentText : t.colors.textMuted}
              />
            )}
          </CompactTouchTarget>
        </View>
      </GlassSurface>
    </View>
  );
}
