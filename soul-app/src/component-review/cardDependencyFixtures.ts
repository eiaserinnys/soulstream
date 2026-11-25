import type { CardDetail, CardDto } from '../api/cardTypes';
import type { CardDependency } from '../../../packages/wire-schema/src/card_dependency_display';
import { CARD_COLOR_KEYS, type CardColor } from '../../../packages/wire-schema/src/card_colors';
import { makeCard } from './fixtures';

const dependency = (number: number | null, title: string, status: CardDependency['status'], flags: Partial<CardDependency> = {}): CardDependency =>
  ({ id: `dep-${number ?? 'x'}-${status}`, number, title, status, archived: false, met: status === 'done', ...flags });

// 운영 응답 형태: 선행이 있을 때만 dependsOn이 실리고, 충족 여부 met는 서버가 판정한다.
const running = dependency(1864, '앱 선행 카드 화면 구현', 'running');
const queued = dependency(1861, '서버 선행 투영 마련', 'queued');
const review = dependency(1859, '웹 선행 카드 상세 검수', 'review');
const done = dependency(1857, '선행 카드 설계 확정', 'done');
const cancelled = dependency(1860, '이전 방식 정리', 'cancelled');
const archived = dependency(1858, '오래된 준비 작업', 'queued', { archived: true });
const LONGEST_TITLE = '소울스트림 앱 카드 상세와 보드에서 선행 카드를 기다리는 카드의 상태를 한눈에 알아보고 실행 전에 한 번 확인받도록 하는 긴 제목 작업의선행카드제목이공백없이길게이어지는경우도확인';

export const dependencyCardTitle = '선행 카드를 기다리는 작업';
export const dependencyNow = { text: '선행 카드가 끝나기를 기다립니다', turn: 'user' as const, ask: '시작해도 될지 확인해 주세요', updatedAt: '2026-11-25T10:00:00Z', sessionId: 'public-shell-session-0' };

export type DependencyScene = { name: string; deps: CardDependency[]; status?: CardDto['status']; title?: string; color?: CardColor };

/** 포스트잇과 상세에 같은 장면 이름을 쓴다. */
export const dependencyScenes: DependencyScene[] = [
  { name: 'wait1', deps: [running] },
  { name: 'wait2', deps: [running, queued] },
  { name: 'wait3', deps: [running, queued, review, done] },
  { name: 'cancelled', deps: [cancelled, running] },
  { name: 'archived', deps: [archived, running] },
  { name: 'mixed', deps: [done, running, cancelled, archived] },
  { name: 'started', deps: [running, done], status: 'running' },
  { name: 'met', deps: [done, dependency(1856, '서버 배포', 'done')] },
  { name: 'longest', deps: [dependency(1855, LONGEST_TITLE, 'running'), dependency(null, LONGEST_TITLE, 'queued')], title: LONGEST_TITLE },
  { name: 'many', deps: Array.from({ length: 10 }, (_, index) => dependency(1840 + index, `선행 작업 ${index + 1}`, index < 3 ? 'done' : 'running')) },
  { name: 'todo', deps: [running], status: 'todo' },
];

export function dependencyCard(scene: DependencyScene, color: CardColor = scene.color ?? 'yellow'): CardDto {
  return { ...makeCard(scene.status ?? 'queued'), id: `dep-card-${scene.name}-${color}`, number: 1865, color,
    title: scene.title ?? dependencyCardTitle, assigneeKind: 'session', assigneeSessionId: 'public-shell-session-0',
    assigneeAgentId: 'public-agent', nodeId: 'public-node', now: dependencyNow, dependsOn: scene.deps };
}

/** 종이 색마다 중립 띠(wait)와 오류 띠(cancelled)를 한 장씩 둔다. */
export const dependencyPaperScenes = CARD_COLOR_KEYS.flatMap(color => (['wait1', 'cancelled'] as const).map(name =>
  ({ color, scene: dependencyScenes.find(scene => scene.name === name)! })));

export function dependencyDetail(scene: DependencyScene): CardDetail {
  return { card: { ...dependencyCard(scene), status: scene.status ?? 'queued' }, reports: [], comments: [], questions: [], sessions: [], notes: [], nowHistory: [] };
}
