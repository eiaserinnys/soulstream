import {
  runPlannerMutationTransaction,
} from '../planner-mutation-transaction';

test('성공은 before→projection→server→merge 단일 순서를 지킨다', async () => {
  const order: string[] = [];
  const result = await runPlannerMutationTransaction({
    capture: () => {
      order.push('capture');
      return { value: 'before' };
    },
    project: () => order.push('project'),
    mutate: async () => {
      order.push('server');
      return 'server-result';
    },
    merge: () => order.push('merge'),
    restore: () => order.push('restore'),
  });

  expect(result).toBe('server-result');
  expect(order).toEqual(['capture', 'project', 'server', 'merge']);
});

test('실패는 정확한 before snapshot을 복원한 뒤 타깃만 재검증한다', async () => {
  const before = { stableReference: {} };
  const restored: unknown[] = [];
  const order: string[] = [];

  await expect(runPlannerMutationTransaction({
    capture: () => before,
    project: () => order.push('project'),
    mutate: async () => {
      order.push('server');
      throw new Error('conflict');
    },
    restore: (snapshot) => {
      order.push('restore');
      restored.push(snapshot);
    },
    revalidate: async () => order.push('revalidate-task-1'),
  })).rejects.toThrow('conflict');

  expect(restored).toEqual([before]);
  expect(restored[0]).toBe(before);
  expect(order).toEqual(['project', 'server', 'restore', 'revalidate-task-1']);
});
