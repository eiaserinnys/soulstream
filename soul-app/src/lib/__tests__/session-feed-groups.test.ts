import type { Session } from '../../api/types';
import { classifySessionFeed } from '../session-feed-groups';

function session(
  agentSessionId: string,
  status: string,
  nodeId?: string,
  reviewState: Session['reviewState'] = 'not_required',
  reviewRequired = false,
): Session {
  return {
    agentSessionId,
    displayName: agentSessionId,
    status,
    nodeId,
    reviewState,
    reviewRequired,
    createdAt: '2026-07-17T00:00:00Z',
    updatedAt: '2026-07-17T00:00:00Z',
  };
}

const pendingAttention = {
  id: 'input_request:req-7',
  sourceEventId: 1001,
  sessionId: 'attention',
  kind: 'input_request' as const,
  requestedAt: '2026-08-06T00:00:02Z',
  title: '입력 요청',
  body: '배포할까요?',
  requestId: 'req-7',
  requiresDetail: false,
};

test('phone과 iPad가 공유하는 피드 projection은 offline running을 숨기고 missing nodeId를 보존한다', () => {
  const groups = classifySessionFeed([
    session('running-online', 'running', 'node-a'),
    session('running-offline', 'running', 'node-b'),
    session('running-without-node', 'running'),
    session('review', 'completed', 'node-a', 'needs_review'),
    session('done', 'completed', 'node-a', 'acknowledged'),
  ], { ready: true, connectedNodeIds: new Set(['node-a']) });

  expect(groups.running.map((item) => item.agentSessionId)).toEqual([
    'running-online',
    'running-without-node',
  ]);
  expect(groups).not.toHaveProperty('offline');
  expect(groups.review.map((item) => item.agentSessionId)).toEqual(['review']);
});

test('노드 목록을 아직 못 읽었을 때 running을 임의로 offline 처리하지 않는다', () => {
  const groups = classifySessionFeed([
    session('running', 'running', 'node-a'),
  ], { ready: false, connectedNodeIds: new Set() });

  expect(groups.running).toHaveLength(1);
});

test('검수 대기는 status·reviewRequired가 아니라 reviewState 정본으로 판정한다', () => {
  const groups = classifySessionFeed([
    session('review-error', 'error', 'node-a', 'needs_review', true),
    session('review-partial', 'unknown', 'node-a', 'needs_review', false),
    session('acknowledged', 'completed', 'node-a', 'acknowledged', true),
  ], { ready: true, connectedNodeIds: new Set(['node-a']) });

  expect(groups.review.map((item) => item.agentSessionId)).toEqual([
    'review-error',
    'review-partial',
  ]);
});

test('응답 필요는 status와 무관한 첫 그룹이며 running/review에 중복되지 않는다', () => {
  const groups = classifySessionFeed([
    {
      ...session('attention', 'completed', 'node-a', 'needs_review', true),
      pendingAttentions: [pendingAttention],
      attentionRevision: 1001,
    },
    session('running', 'running', 'node-a'),
    session('review', 'completed', 'node-a', 'needs_review'),
  ], { ready: true, connectedNodeIds: new Set(['node-a']) });

  expect(groups.attention.map((item) => item.agentSessionId)).toEqual(['attention']);
  expect(groups.running.map((item) => item.agentSessionId)).toEqual(['running']);
  expect(groups.review.map((item) => item.agentSessionId)).toEqual(['review']);
});
