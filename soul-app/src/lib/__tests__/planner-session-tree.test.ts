import type { Session } from '../../api/types';
import { buildPlannerSessionTreeRows } from '../planner-session-tree';

describe('planner session tree', () => {
  test('root와 각 depth 형제를 최신순으로 두고 다단계 자식을 부모 바로 아래에 둔다', () => {
    const rows = buildPlannerSessionTreeRows([
      session('older-root', '2026-07-18T01:00:00Z'),
      session('newer-root', '2026-07-18T05:00:00Z'),
      session('older-child', '2026-07-18T02:00:00Z', 'newer-root'),
      session('newer-child', '2026-07-18T04:00:00Z', 'newer-root'),
      session('grandchild', '2026-07-18T03:00:00Z', 'newer-child'),
    ]);

    expect(rows.map(({ session: item, depth }) => [item.agentSessionId, depth])).toEqual([
      ['newer-root', 0],
      ['newer-child', 1],
      ['grandchild', 2],
      ['older-child', 1],
      ['older-root', 0],
    ]);
  });

  test('고아는 root로 보존하고 같은 시각 형제는 입력 순서를 유지한다', () => {
    const rows = buildPlannerSessionTreeRows([
      session('stable-a', '2026-07-18T01:00:00Z'),
      session('stable-b', '2026-07-18T01:00:00Z'),
      session('orphan', '2026-07-18T02:00:00Z', 'missing-parent'),
    ]);

    expect(rows.map(({ session: item, depth }) => [item.agentSessionId, depth])).toEqual([
      ['orphan', 0],
      ['stable-a', 0],
      ['stable-b', 0],
    ]);
  });

  test('웹과 동일하게 updatedAt을 createdAt보다 우선해 최신순을 결정한다', () => {
    const oldCreatedButActive = session('active', '2026-07-17T01:00:00Z');
    oldCreatedButActive.updatedAt = '2026-07-18T05:00:00Z';
    const newCreated = session('new', '2026-07-18T04:00:00Z');

    expect(buildPlannerSessionTreeRows([newCreated, oldCreatedButActive])
      .map(({ session: item }) => item.agentSessionId)).toEqual(['active', 'new']);
  });

  test.each([
    [
      'self cycle',
      [session('self', '2026-07-18T01:00:00Z', 'self')],
    ],
    [
      'three-node cycle',
      [
        session('cycle-a', '2026-07-18T01:00:00Z', 'cycle-b'),
        session('cycle-b', '2026-07-18T02:00:00Z', 'cycle-c'),
        session('cycle-c', '2026-07-18T03:00:00Z', 'cycle-a'),
      ],
    ],
  ])('%s 구성원을 각각 root로 격리하고 exactly once 렌더한다', (_label, input) => {
    const rows = buildPlannerSessionTreeRows(input);
    expect(rows).toHaveLength(input.length);
    expect(new Set(rows.map(({ session: item }) => item.agentSessionId)).size).toBe(input.length);
    expect(rows.every(({ depth }) => depth === 0)).toBe(true);
  });
});

function session(id: string, createdAt: string, callerSessionId?: string): Session {
  return {
    agentSessionId: id,
    displayName: id,
    status: 'completed',
    createdAt,
    updatedAt: createdAt,
    callerSessionId: callerSessionId ?? null,
  };
}
