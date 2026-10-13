import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ChatAttachment } from '../../hooks/useChatAttachments';
import type { ChatBodyStyles } from './ChatBody.styles';
import { DESIGN_ICON_SIZE } from '../../theme';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { useTokens } from '../../theme';
import { getChatRowHorizontalInset } from './ChatBody.styles';

interface Props {
  attachments: ChatAttachment[];
  styles: ChatBodyStyles;
  textSecondaryColor: string;
  textMutedColor: string;
  onRemove: (index: number) => void;
  disabled?: boolean;
  presentation?: 'default' | 'manuscript';
  containerStyle?: StyleProp<ViewStyle>;
  trailingAccessory?: React.ReactNode;
}

export function AttachmentChips({
  attachments,
  styles,
  textSecondaryColor,
  textMutedColor,
  onRemove,
  disabled = false,
  presentation = 'default',
  containerStyle,
  trailingAccessory,
}: Props) {
  const t = useTokens();
  if (attachments.length === 0) return null;

  const renderAttachment = (
    attachment: ChatAttachment,
    idx: number,
    frameStyle?: StyleProp<ViewStyle>,
  ) => (
    <View key={`${attachment.path}-${idx}`} style={[styles.attachmentTouchFrame, frameStyle]}>
      <View style={presentation === 'manuscript'
        ? [styles.attachmentChip, {
            backgroundColor: t.persistentSession.paper,
            borderColor: t.persistentSession.line,
            borderWidth: StyleSheet.hairlineWidth,
          }]
        : styles.attachmentChip}>
        <Ionicons
          name="document-outline"
          color={textSecondaryColor}
          size={DESIGN_ICON_SIZE.compact}
        />
        <Text style={styles.attachmentName} numberOfLines={1}>
          {attachment.name}
        </Text>
        <View style={styles.attachmentRemoveSpacer} />
      </View>
      <CompactTouchTarget
        testID={`chat-attachment-remove-${idx}`}
        onPress={() => onRemove(idx)}
        disabled={disabled}
        accessibilityState={{ disabled }}
        accessibilityLabel={`${attachment.name} 첨부 제거`}
        frameStyle={styles.attachmentRemoveFrame}
        surfaceStyle={styles.attachmentRemove}
      >
        <Ionicons name="close" color={textMutedColor} size={DESIGN_ICON_SIZE.standard} />
      </CompactTouchTarget>
    </View>
  );
  const hasTrailingAccessory = trailingAccessory !== undefined && trailingAccessory !== null;
  const baseContainerStyle = containerStyle ?? (presentation === 'manuscript'
    ? [styles.attachmentRow, { paddingHorizontal: getChatRowHorizontalInset(t, presentation) }]
    : styles.attachmentRow);

  return (
    <View style={hasTrailingAccessory ? [baseContainerStyle, { alignItems: 'center' }] : baseContainerStyle}>
      {hasTrailingAccessory ? (
        <>
          {attachments.slice(0, -1).map((attachment, idx) => renderAttachment(attachment, idx))}
          <View style={styles.generatedAttachmentActionRow}>
            {renderAttachment(attachments[attachments.length - 1], attachments.length - 1,
              { flexShrink: 1, minWidth: 0, maxWidth: '100%' },
            )}
            <View style={{ marginLeft: 'auto', flexShrink: 0 }}>{trailingAccessory}</View>
          </View>
        </>
      ) : attachments.map((attachment, idx) => renderAttachment(attachment, idx))}
    </View>
  );
}
