import React from 'react';
import {
  ActivityIndicator,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { GlassSurface } from '../GlassSurface';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { useTokens } from '../../theme';
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
  const [multilineExpanded, setMultilineExpanded] = React.useState(false);
  const singleLineContentHeightRef = React.useRef<number | null>(null);

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
        <View testID="chat-composer-content-row" style={styles.composerContentRow}>
          <AttachmentPickerButton
            testID="chat-composer-attach-button"
            surfaceTestID="chat-composer-attach-visual"
            uploading={uploading}
            disabled={controlsDisabled}
            onPress={onPickAttachment}
          />
          <TextInput
            testID="chat-composer-text-input"
            style={styles.composerTextInput}
            value={input}
            onChangeText={onChangeInput}
            placeholder={placeholder}
            accessibilityLabel={inputAccessibilityLabel}
            placeholderTextColor={t.colors.textPlaceholder}
            multiline
            maxLength={4000}
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical={multilineExpanded ? 'top' : 'center'}
            onContentSizeChange={(event) => {
              const measuredHeight = event.nativeEvent.contentSize.height;
              const previousSingleLineHeight = singleLineContentHeightRef.current;
              if (previousSingleLineHeight === null || measuredHeight < previousSingleLineHeight) {
                singleLineContentHeightRef.current = measuredHeight;
              }
              const singleLineHeight = singleLineContentHeightRef.current ?? measuredHeight;
              const lineHeight = t.chatFontSize.body * t.lineHeightRatio;
              // iOS contentSize는 기기·폰트 설정에 따라 padding 포함 여부가 달라질 수 있다.
              // 최초 한 줄 실측값을 기준으로 반 줄 이상 늘어난 순간부터 multiline으로 본다.
              setMultilineExpanded(measuredHeight > singleLineHeight + lineHeight / 2);
            }}
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
