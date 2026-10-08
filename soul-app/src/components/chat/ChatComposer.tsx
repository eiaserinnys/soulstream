import { useTextInputContentHeight } from './useTextInputContentHeight';
import React from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type LayoutRectangle,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { GlassSurface } from '../GlassSurface';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { createSessionVisualRoles, useTokens } from '../../theme';
import { ADD_GLYPH_INSET_RATIO, makeStyles } from './ChatBody.styles';
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
  onInputRef?: (input: TextInput | null) => void;
  onComposerBoxLayout?: (box: LayoutRectangle, row: LayoutRectangle) => void;
  presentation?: 'default' | 'manuscript';
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
  onInputRef,
  onComposerBoxLayout,
  presentation = 'default',
}: Props) {
  React.useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined' || document.getElementById('chat-composer-placeholder-style')) return;
    const style = document.createElement('style');
    style.id = 'chat-composer-placeholder-style';
    style.textContent = 'textarea[data-testid="chat-composer-text-input"]::placeholder{white-space:nowrap;text-overflow:ellipsis;overflow:hidden}';
    document.head.appendChild(style);
  }, []);

  const t = useTokens();
  const styles = React.useMemo(() => makeStyles(t), [t]);
  const canSend = input.trim().length > 0 && !hasPendingOptimistic && !disabled && !sendDisabled;
  const controlsDisabled = uploading || disabled;
  const { fontScale } = useWindowDimensions();
  const composer = createSessionVisualRoles(t).chat.composer;
  const manuscriptAttachmentOutset = (composer.hitTarget - t.iconSize.action) / 2
    + t.iconSize.action * ADD_GLYPH_INSET_RATIO;
  const manuscriptSendOutset = (composer.hitTarget - composer.controlVisualSize) / 2;
  const lineHeight = t.chatFontSize.body * t.lineHeightRatio * fontScale;
  const singleLineHeight = Math.max(composer.contentMinHeight, lineHeight + composer.inputPaddingVertical * 2);
  const isEmpty = input.length === 0;
  const measurement = useTextInputContentHeight(input, lineHeight);
  const composerRowLayout = React.useRef<LayoutRectangle | null>(null);
  const composerBoxLayout = React.useRef<LayoutRectangle | null>(null);
  const reportComposerBoxLayout = React.useCallback(() => {
    const row = composerRowLayout.current;
    const box = composerBoxLayout.current;
    if (row && box) onComposerBoxLayout?.(box, row);
  }, [onComposerBoxLayout]);
  const handleComposerRowLayout = React.useCallback((event: LayoutChangeEvent) => {
    composerRowLayout.current = event.nativeEvent.layout;
    reportComposerBoxLayout();
  }, [reportComposerBoxLayout]);
  const handleComposerSurfaceLayout = React.useCallback((event: LayoutChangeEvent) => {
    composerBoxLayout.current = event.nativeEvent.layout;
    reportComposerBoxLayout();
  }, [reportComposerBoxLayout]);
  const measuredHeight = input ? measurement.contentHeight : 0;
  const multilineExpanded = measuredHeight > singleLineHeight + 1;
  const inputHeight = Math.min(styles.composerTextInput.maxHeight, Math.max(singleLineHeight, measuredHeight));
  const inputPadding = multilineExpanded ? composer.inputPaddingVertical : (singleLineHeight - lineHeight) / 2;
  const [stacked, setStacked] = React.useState(false);
  const effectiveStacked = !isEmpty && stacked;
  const [iosAtMaxHeight, setIOSAtMaxHeight] = React.useState(false);
  const composerSurfaceStyle = presentation === 'manuscript'
    ? [styles.manuscriptComposerBox, {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: t.persistentSession.line,
      }]
    : styles.composerBox;
  React.useLayoutEffect(() => {
    if (isEmpty) setStacked(false);
    else if (!stacked && multilineExpanded) setStacked(true);
  }, [isEmpty, multilineExpanded, stacked]);
  React.useLayoutEffect(() => {
    if (isEmpty) setIOSAtMaxHeight(false);
  }, [isEmpty]);

  return (
    <View
      {...(embedded ? { testID: 'chat-composer-row' } : {})}
      style={[
        presentation === 'manuscript' ? styles.manuscriptInputRow : styles.inputRow,
        embedded ? { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0 }
          : { paddingBottom: Math.max(t.spacing.sm, minimumBottomPadding) },
      ]}
      onLayout={onComposerBoxLayout ? handleComposerRowLayout : undefined}
    >
      <ComposerSurface
        presentation={presentation}
        testID="chat-composer-box"
        style={composerSurfaceStyle}
        onLayout={onComposerBoxLayout ? handleComposerSurfaceLayout : undefined}
      >
        <View
          testID="chat-composer-content-row"
          collapsable={false}
          style={[styles.composerContentRow, effectiveStacked && styles.composerContentRowStacked]}
        >
          <View
            testID="chat-composer-attach-slot"
            style={[
              styles.composerAttachmentSlot,
              effectiveStacked && styles.composerAttachmentSlotStacked,
              ...(presentation === 'manuscript'
                ? [effectiveStacked
                  ? { left: -manuscriptAttachmentOutset }
                  : { marginLeft: -manuscriptAttachmentOutset }]
                : []),
            ]}
          >
            <AttachmentPickerButton
              testID="chat-composer-attach-button"
              surfaceTestID="chat-composer-attach-visual"
              uploading={uploading}
              disabled={controlsDisabled}
              presentation={presentation}
              onPress={onPickAttachment}
            />
          </View>
          <View
            testID="chat-composer-input-row"
            collapsable={false}
            style={[styles.composerInputRow, effectiveStacked && styles.composerInputRowStacked]}
          >
            <TextInput
              ref={(input) => {
                measurement.ref.current = input;
                onInputRef?.(input);
              }}
              onContentSizeChange={measurement.onContentSizeChange}
              testID="chat-composer-text-input"
              // Empty iOS inputs collapse immediately; text keeps native intrinsic growth.
              style={[styles.composerTextInput, {
                ...(Platform.OS === 'ios'
                  ? { minHeight: singleLineHeight, ...(isEmpty ? { height: singleLineHeight } : {}) }
                  : { height: inputHeight }),
                paddingVertical: inputPadding,
                ...(presentation === 'manuscript' && effectiveStacked ? { paddingHorizontal: 0 } : {}),
                ...(Platform.OS === 'web'
                  ? isEmpty
                    ? { whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }
                    : { whiteSpace: 'pre-wrap' }
                  : {}),
              }]}
              onLayout={Platform.OS === 'ios' ? (event) => {
                // Once capped, content may change without another contentSize event.
                setIOSAtMaxHeight(event.nativeEvent.layout.height >= styles.composerTextInput.maxHeight);
              } : undefined}
              value={input}
              onChangeText={onChangeInput}
              placeholder={presentation === 'manuscript' ? undefined : placeholder}
              accessibilityLabel={presentation === 'manuscript'
                ? inputAccessibilityLabel ?? '메시지'
                : inputAccessibilityLabel}
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
          </View>
          <View
            testID="chat-composer-controls-row"
            collapsable={false}
            pointerEvents={effectiveStacked ? 'box-none' : undefined}
            style={styles.composerControlsRow}
          >
            <Pressable
              testID="chat-composer-controls-spacer"
              accessible={false}
              focusable={false}
              tabIndex={-1}
              disabled={disabled}
              style={[styles.composerControlsSpacer, effectiveStacked && styles.composerControlsSpacerStacked]}
              onPress={() => {
                if (!disabled) measurement.ref.current?.focus();
              }}
            />
            <View style={styles.composerRightControls}>
              {interruptControls}
              <View
                testID="chat-composer-voice-slot"
                style={effectiveStacked && voiceControls == null ? styles.voiceSlotStackedEmpty : styles.voiceSlot}
              >
                {voiceControls}
              </View>
              <CompactTouchTarget
                testID="chat-composer-send-button"
                surfaceTestID="chat-composer-send-visual"
                accessibilityRole="button"
                accessibilityLabel={sendAccessibilityLabel}
                accessibilityState={{ disabled: !canSend || sending, busy: sending }}
                disabled={!canSend || sending}
                frameStyle={presentation === 'manuscript'
                  ? [styles.composerControlFrame, { marginRight: -manuscriptSendOutset }]
                  : styles.composerControlFrame}
                surfaceStyle={presentation === 'manuscript'
                  ? styles.composerSecondaryControl
                  : [styles.sendBtn, !sending && !canSend && styles.sendBtnDisabled]}
                onPress={() => {
                  if (canSend && !sending) onSend();
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
                    name={presentation === 'manuscript' ? 'send-outline' : 'send'}
                    size={t.iconSize.standard}
                    color={canSend ? (presentation === 'manuscript' ? t.colors.textPrimary : t.colors.accentText) : t.colors.textMuted}
                  />
                )}
              </CompactTouchTarget>
            </View>
          </View>
        </View>
      </ComposerSurface>
    </View>
  );
}

function ComposerSurface({
  presentation,
  testID,
  style,
  children,
  onLayout,
}: {
  presentation: 'default' | 'manuscript';
  testID: string;
  style: React.ComponentProps<typeof View>['style'];
  children: React.ReactNode;
  onLayout?: React.ComponentProps<typeof View>['onLayout'];
}) {
  return presentation === 'manuscript'
    ? <View testID={testID} style={style} onLayout={onLayout}>{children}</View>
    : <GlassSurface role="glassDense" testID={testID} style={style} onLayout={onLayout}>{children}</GlassSurface>;
}
