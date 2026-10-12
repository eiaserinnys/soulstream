import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ApiClient } from '../../api/client';
import type { MarkdownDocument } from '../../api/boardItemEndpoints';
import { useDeviceType, useTokens } from '../../theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassButton } from '../GlassSurface';
import { removeOverlappingDocumentHeading } from '../../../../packages/soul-ui/src/lib/markdown-document-heading';
import { cardDetailStyles } from './CardDetail.styles';
import { PlannerMarkdownText } from './PlannerMarkdownText';

export function MarkdownDocumentContent({ api, documentId, onClose }: {
  api: ApiClient | null;
  documentId: string;
  onClose(): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const phone = useDeviceType() === 'phone';
  const insets = useSafeAreaInsets();
  const [document, setDocument] = useState<MarkdownDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setDocument(null);
    setLoading(true);
    setFailed(false);
    if (!api) {
      setLoading(false);
      setFailed(true);
      return () => { active = false; };
    }
    void api.getMarkdownDocument(documentId)
      .then((result) => { if (active) setDocument(result); })
      .catch(() => { if (active) setFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, documentId]);

  return <View style={styles.frame}>
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <GlassButton iconOnly size="compact" borderRadius={t.foundation.radius.round}
          accessibilityLabel="뒤로" onPress={onClose}>
          <Ionicons name="chevron-back" size={t.foundation.typography.body.fontSize} color={t.colors.textPrimary} />
        </GlassButton>
        {document ? <Text testID="markdown-document-title" style={styles.heading} numberOfLines={3}>
          {document.title}
        </Text> : null}
      </View>
    </View>
    <View style={styles.bodyFrame}>
      <ScrollView testID="markdown-document-scroll" contentContainerStyle={phone
        ? [styles.content, { paddingBottom: insets.bottom + t.uiSpacing.xxl }]
        : [styles.content, { paddingBottom: t.uiSpacing.xxl }]}
        keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {loading ? <ActivityIndicator testID="markdown-document-loading" color={t.colors.accent} /> : null}
        {failed ? <Text testID="markdown-document-error" style={styles.error}>문서를 불러오지 못했습니다.</Text> : null}
        {document ? <PlannerMarkdownText testID="markdown-document-body"
          markdown={removeOverlappingDocumentHeading(document.body, document.title)} /> : null}
      </ScrollView>
    </View>
  </View>;
}
