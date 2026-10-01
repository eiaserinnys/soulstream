import React from 'react';
import { Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ChatAttachment } from '../../hooks/useChatAttachments';
import type { ChatBodyStyles } from './ChatBody.styles';
import { DESIGN_ICON_SIZE } from '../../theme';
import { CompactTouchTarget } from '../CompactTouchTarget';

interface Props {
  attachments: ChatAttachment[];
  styles: ChatBodyStyles;
  textSecondaryColor: string;
  textMutedColor: string;
  onRemove: (index: number) => void;
  disabled?: boolean;
}

export function AttachmentChips({
  attachments,
  styles,
  textSecondaryColor,
  textMutedColor,
  onRemove,
  disabled = false,
}: Props) {
  if (attachments.length === 0) return null;

  return (
    <View style={styles.attachmentRow}>
      {attachments.map((attachment, idx) => (
        <View key={`${attachment.path}-${idx}`} style={styles.attachmentTouchFrame}>
          <View style={styles.attachmentChip}>
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
      ))}
    </View>
  );
}
