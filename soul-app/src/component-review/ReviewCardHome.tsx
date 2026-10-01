import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { CardBoardWorkspace } from '../components/planner/CardBoardWorkspace';
import { CardDetailContent } from '../components/planner/CardDetailSheet';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { useCardStore } from '../store/cardStore';
import { useTokens } from '../theme';
import { createReviewApi, folders } from './fixtures';

/** The production workspace and detail with injected public API; never a live transport. */
export function ReviewCardHome() {
  const t = useTokens();
  const [example, setExample] = useState<'normal' | 'emptyReview' | 'failWrites'>('normal');
  const [scope, setScope] = useState<'global' | 'folder'>('global');
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const api = useMemo(() => createReviewApi('normal', { home: true, emptyReview: example === 'emptyReview', failWrites: example === 'failWrites' }), [example]);
  return <View testID="review-card-home" style={{ flex: 1, gap: t.uiSpacing.sm }}>
    <SettingsSegmentedControl<'normal' | 'emptyReview' | 'failWrites'> id="card-home-scenario" value={example}
      onChange={(next) => { useCardStore.setState({ rows: {}, details: {} }); setExample(next); }}
      options={[{ value: 'normal', label: '기본' }, { value: 'emptyReview', label: '검수 0개' }, { value: 'failWrites', label: '저장 실패' }]} />
    <SettingsSegmentedControl<'global' | 'folder'> id="card-home-scope" value={scope} onChange={setScope}
      options={[{ value: 'global', label: '전체' }, { value: 'folder', label: '폴더' }]} />
    {selected ? <CardDetailContent api={api} cardId={selected} inline onClose={() => setSelected(null)} />
      : <CardBoardWorkspace key={`${example}:${scope}`} api={api} folderId={scope === 'folder' ? folders[0].id : undefined}
        cardDisplay={{ includeCompleted, onChange: setIncludeCompleted }} onOpen={setSelected} />}
    <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>공개 fixture · 길게 눌러 이동 / 상태 메뉴</Text>
  </View>;
}
