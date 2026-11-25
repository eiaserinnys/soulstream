import { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { PostItCard } from '../components/planner/PostItCard';
import { CardDetailContent } from '../components/planner/CardDetailSheet';
import { useTokens } from '../theme';
import type { ApiClient } from '../api/client';
import { createReviewApi } from './fixtures';
import { dependencyCard, dependencyDetail, dependencyPaperScenes, dependencyScenes } from './cardDependencyFixtures';

/** 선행 카드 장면. ?view=postits(포스트잇 띠), ?view=papers(종이 색별 띠), ?view=detail&scene=이름(폰 상세). 태블릿 오버레이는 cardChecks 진입에 state=dependencies로 붙는다. */
export function ReviewCardDependencies() {
  const t = useTokens();
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view') ?? 'postits';
  const scene = dependencyScenes.find(entry => entry.name === (params.get('scene') ?? 'wait1')) ?? dependencyScenes[0];
  const api = useMemo(() => ({ ...createReviewApi('normal', { home: true }),
    getCard: async () => dependencyDetail(scene) }) as unknown as ApiClient, [scene]);
  const label = { ...t.foundation.typography.meta, color: t.colors.textSecondary };
  return <View testID="card-dependencies-review" style={{ flex: 1, backgroundColor: t.colors.background }}>
    {view === 'detail' ? <CardDetailContent visible api={api} cardId={dependencyCard(scene).id} onClose={() => {}} />
      : <ScrollView contentContainerStyle={{ padding: t.foundation.pageInset, gap: t.uiSpacing.lg }} showsVerticalScrollIndicator={false}>
        {(view === 'papers' ? dependencyPaperScenes.map(({ color, scene: entry }) => ({ key: `${entry.name}-${color}`, scene: entry, color }))
          : dependencyScenes.map(entry => ({ key: entry.name, scene: entry, color: undefined }))).map(({ key, scene: entry, color }) =>
          <View key={key} testID={`dep-scene-${key}`} style={{ gap: t.uiSpacing.xs, alignItems: 'flex-start' }}>
            <Text style={label}>{key}</Text>
            <PostItCard api={null} card={dependencyCard(entry, color)} variant="compact" onOpen={() => {}} />
          </View>)}
      </ScrollView>}
  </View>;
}
