import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { CardBoardWorkspace } from '../components/planner/CardBoardWorkspace';
import { CardDetailContent } from '../components/planner/CardDetailSheet';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { useCardStore } from '../store/cardStore';
import { useTokens } from '../theme';
import { createReviewApi, folders,type AssignmentScenario } from './fixtures';
import { useCardDisplay } from '../hooks/useCardDisplay';
import { CardHomeScreen } from '../screens/CardHomeScreen';

/** The production workspace and detail with injected public API; never a live transport. */
export function ReviewCardHome() {
  const t = useTokens();
  const [example, setExample] = useState<'normal' | 'emptyReview' | 'failWrites' | 'noCompleted' | 'onlyCompleted'>('normal');
  const [assignment,setAssignment]=useState<AssignmentScenario>('assigned');
  const [scope, setScope] = useState<'global' | 'folder'>('global');
  const folderId = scope === 'folder' ? folders[0].id : undefined;
  const cardDisplay = useCardDisplay(folderId);
  const [selected, setSelected] = useState<string | null>(null);
  const [created, setCreated] = useState<unknown>(null);
  const api = useMemo(() => createReviewApi('normal', { assignment, home: true, emptyReview: example === 'emptyReview', failWrites: example === 'failWrites',
    completed: example === 'noCompleted' ? 'none' : example === 'onlyCompleted' ? 'only' : undefined,
    onCreateCard: setCreated }), [example,assignment]);
  return <View testID="review-card-home" style={{ flex: 1, gap: t.uiSpacing.sm }}>
    <SettingsSegmentedControl<typeof example> id="card-home-scenario" value={example}
      onChange={(next) => { useCardStore.setState({ rows: {}, details: {} }); setExample(next); }}
      options={[{ value: 'normal', label: '기본' }, { value: 'emptyReview', label: '검수 0개' }, { value: 'failWrites', label: '저장 실패' },
        { value: 'noCompleted', label: '완료 0개' }, { value: 'onlyCompleted', label: '전부 완료' }]} />
    <SettingsSegmentedControl<AssignmentScenario> id="card-assignment-scenario" value={assignment} onChange={value=>{setSelected(null);useCardStore.setState({rows:{},details:{}});setAssignment(value);}}
      options={[{value:'unassigned',label:'담당 없음'},{value:'partial',label:'부분 설정'},{value:'agent',label:'에이전트 지정'},{value:'assigned',label:'담당 연결'},{value:'live',label:'실행 중'}]}/>
    <SettingsSegmentedControl<'global' | 'folder'> id="card-home-scope" value={scope} onChange={setScope}
      options={[{ value: 'global', label: '전체' }, { value: 'folder', label: '폴더' }]} />
    {selected ? <CardDetailContent api={api} cardId={selected} inline onClose={() => setSelected(null)} />
      : scope === 'global' ? <CardHomeScreen key={`${example}:${assignment}`} api={api as any} cardDisplay={cardDisplay}
        onOpen={setSelected} onSessionCreated={() => {}} />
        : <CardBoardWorkspace key={`${example}:${scope}:${assignment}`} api={api} folderId={folderId}
          cardDisplay={cardDisplay} onOpen={setSelected} />}
    <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>공개 fixture · 길게 눌러 이동 / 상태 메뉴</Text>
    {created ? <Text testID="review-card-create-result" style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>
      {JSON.stringify(created)}
    </Text> : null}
  </View>;
}
