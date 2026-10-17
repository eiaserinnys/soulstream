import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import type { AttachmentView } from '../lib/attachment-view';
import { useTokens } from '../theme';
import { GlassButton } from './GlassSurface';

/** Metadata is resolved inside the viewer, so transient failures remain retryable. */
export function AttachmentMetadataPreview({ item, onResolved }: {
  item: AttachmentView; onResolved(key: string, view: AttachmentView): void;
}) {
  const t = useTokens();
  const [failure, setFailure] = useState<{ message: string; retryable: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setFailure(null);
    void item.loadMetadata!().then(view => { if (active) onResolved(item.key, { ...view, key: item.key }); })
      .catch((error: unknown) => {
        if (!active) return;
        const status = (error as { status?: number } | null)?.status;
        setFailure({ retryable: status === undefined || status >= 500,
          message: status === 401 ? '로그인이 필요합니다.' : status === 403 ? '접근 권한이 없습니다.'
            : status === 404 ? '찾을 수 없음' : '첨부를 불러오지 못했습니다.' });
      });
    return () => { active = false; };
  }, [item, attempt, onResolved]);
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: t.spacing.sm }}>
    {failure ? <>
      <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary, textAlign: 'center' }}>{failure.message}</Text>
      {failure.retryable ? <GlassButton size="card" onPress={() => setAttempt(value => value + 1)}>
        <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>다시 시도</Text>
      </GlassButton> : null}
    </> : <ActivityIndicator testID="attachment-metadata-loading" color={t.colors.accent} />}
  </View>;
}
