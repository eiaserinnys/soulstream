import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useRef, useState } from 'react';
import { findNodeHandle, Platform, Text, View } from 'react-native';
import { createSessionVisualRoles, useDeviceType, useTokens } from '../theme';
import { GlassButton } from './GlassSurface';

/** One footer owns navigation, original saving and save failures for every viewer. */
export function AttachmentViewerFooter({ count, currentIndex, onIndexChange, onSaveOriginal, overlay = false }: {
  count: number;
  currentIndex: number;
  onIndexChange(index: number): void;
  onSaveOriginal?: (index: number, anchor?: number) => Promise<unknown>;
  overlay?: boolean;
}) {
  const t = useTokens();
  const phone = useDeviceType() === 'phone';
  const attachment = createSessionVisualRoles(t).chat.attachment;
  const anchorRef = useRef<View | null>(null);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ index: number; message: string } | null>(null);
  const save = async () => {
    if (savingRef.current || !onSaveOriginal) return;
    savingRef.current = true;
    setSaving(true);
    setFailure(null);
    const anchor = Platform.OS === 'ios' ? findNodeHandle(anchorRef.current) ?? undefined : undefined;
    try {
      await onSaveOriginal(currentIndex, anchor);
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/\s*\(\d{3}\)/g, '').trim() : '';
      setFailure({ index: currentIndex, message: message || '원본을 저장하지 못했습니다.' });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  if (count < 2 && !onSaveOriginal) return null;
  return <View testID="attachment-viewer-footer" style={{ gap: t.spacing.sm }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs }}>
      <View style={{ flex: 1 }} />
      {count > 1 ? <View testID="attachment-viewer-navigation" style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs }}>
        <GlassButton iconOnly size="card" borderRadius={t.foundation.radius.round}
          accessibilityLabel="이전 이미지" testID="chat-image-viewer-previous"
          accessibilityState={{ disabled: currentIndex === 0 }}
          onPress={() => { if (currentIndex > 0) onIndexChange(currentIndex - 1); }}>
          <Ionicons name="chevron-back" size={t.foundation.iconFrame.compact} color={t.colors.textMuted} />
        </GlassButton>
        <Text testID="chat-image-viewer-index" style={{ ...attachment.metadata,
          color: overlay ? t.colors.textPrimary : attachment.textMuted,
          backgroundColor: overlay ? t.colors.surface : undefined,
          borderRadius: attachment.radius,
          minWidth: t.foundation.minHeight.secondary, textAlign: 'center',
        }}>{currentIndex + 1} / {count}</Text>
        <GlassButton iconOnly size="card" borderRadius={t.foundation.radius.round}
          accessibilityLabel="다음 이미지" testID="chat-image-viewer-next"
          accessibilityState={{ disabled: currentIndex === count - 1 }}
          onPress={() => { if (currentIndex < count - 1) onIndexChange(currentIndex + 1); }}>
          <Ionicons name="chevron-forward" size={t.foundation.iconFrame.compact} color={t.colors.textMuted} />
        </GlassButton>
      </View> : null}
      <View style={{ flex: 1, minWidth: 0, alignItems: 'flex-end' }}>
        {onSaveOriginal ? <View ref={anchorRef} collapsable={false}>
          <GlassButton iconOnly={phone} size="card" disabled={saving}
            accessibilityLabel="원본 저장" testID="chat-image-viewer-save-original" onPress={() => { void save(); }}>
            <Ionicons name="download-outline" size={t.foundation.iconFrame.compact} color={t.colors.textMuted} />
            {!phone ? <Text numberOfLines={1} style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>
              {saving ? '저장 중…' : '원본 저장'}
            </Text> : null}
          </GlassButton>
        </View> : null}
      </View>
    </View>
    {failure?.index === currentIndex ? <Text accessibilityLiveRegion="polite" style={{ ...attachment.metadata, color: t.colors.textMuted }}>
      {failure.message}
    </Text> : null}
  </View>;
}
