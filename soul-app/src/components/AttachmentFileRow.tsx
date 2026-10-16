import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AttachmentView } from '../lib/attachment-view';
import { createSessionVisualRoles, useTokens } from '../theme';
import { CompactTouchTarget } from './CompactTouchTarget';

export function AttachmentFileRow({ item, onPress, testID, presentation = 'default' }: {
  item: AttachmentView;
  onPress(): void;
  testID?: string;
  presentation?: 'default' | 'manuscript';
}) {
  const t = useTokens();
  const attachment = createSessionVisualRoles(t).chat.attachment;
  const status = item.source.kind === 'unavailable'
    ? item.source.availability === 'missing' ? '찾을 수 없음'
      : item.source.availability === 'unavailable' ? '사용할 수 없음' : undefined
    : undefined;
  const size = status ?? formatAttachmentByteSize(item.byteSize);

  return <CompactTouchTarget
    testID={testID}
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={`${item.name} 열기`}
    frameStyle={{ width: '100%', alignSelf: 'stretch' }}
    surfaceStyle={{
      width: '100%',
      minHeight: t.hitTarget.min,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.md,
      paddingHorizontal: t.spacing.md,
      borderRadius: attachment.radius,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: presentation === 'manuscript' ? t.persistentSession.line : attachment.border,
      backgroundColor: presentation === 'manuscript' ? t.persistentSession.paper : attachment.surface,
    }}
  >
    <Ionicons name="document-outline" size={t.foundation.iconFrame.compact} color={attachment.textMuted} />
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} ellipsizeMode="tail" style={{
        ...t.foundation.typography.body,
        color: t.colors.textPrimary,
      }}>{item.name}</Text>
      {size ? <Text numberOfLines={1} ellipsizeMode="tail" style={{
        ...attachment.metadata,
        color: attachment.textMuted,
      }}>{size}</Text> : null}
    </View>
  </CompactTouchTarget>;
}

export function formatAttachmentByteSize(byteSize: number | null): string | null {
  if (byteSize === null || !Number.isSafeInteger(byteSize) || byteSize < 0) return null;
  if (byteSize < 1024) return `${byteSize} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = byteSize;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
