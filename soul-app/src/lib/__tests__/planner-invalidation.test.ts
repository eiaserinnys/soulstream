import {
  createPlannerInvalidationCounters,
  incrementPlannerInvalidation,
  plannerSourceForStreamEvent,
  selectPlannerInvalidationKeys,
} from '../planner-invalidation';

test.each([
  ['session_created', 'session_created'],
  ['session_updated', 'session_updated'],
  ['session_deleted', 'session_deleted'],
  ['metadata_updated', 'metadata_updated'],
  ['catalog_updated', 'catalog'],
  ['folder_updated', 'folder'],
  ['card_updated', 'folder'],
  ['custom_view_updated', 'custom_view'],
  ['replay_gap', 'replay'],
  ['session_list', null],
  ['stream_meta', null],
])('%s 스트림 이벤트는 %s source로 매핑된다', (event, source) => {
  expect(plannerSourceForStreamEvent(event)).toBe(source);
});

test('daily/project/starred/runHistory/pageDetail은 source 표에 지정된 변경만 관찰한다', () => {
  let counters = createPlannerInvalidationCounters();
  const initial = selectPlannerInvalidationKeys(counters);

  counters = incrementPlannerInvalidation(counters, 'session_updated');
  expect(selectPlannerInvalidationKeys(counters)).toEqual(initial);

  counters = incrementPlannerInvalidation(counters, 'folder');
  expect(selectPlannerInvalidationKeys(counters)).toEqual({
    ...initial,
    daily: initial.daily + 1,
    project: initial.project + 1,
    starred: initial.starred + 1,
  });

  counters = incrementPlannerInvalidation(counters, 'page');
  expect(selectPlannerInvalidationKeys(counters)).toEqual({
    daily: initial.daily + 2,
    project: initial.project + 2,
    starred: initial.starred + 2,
    runHistory: initial.runHistory,
    pageDetail: initial.pageDetail + 1,
  });

  counters = incrementPlannerInvalidation(counters, 'session_created');
  expect(selectPlannerInvalidationKeys(counters)).toEqual({
    daily: initial.daily + 3,
    project: initial.project + 3,
    starred: initial.starred + 3,
    runHistory: initial.runHistory + 1,
    pageDetail: initial.pageDetail + 1,
  });

  counters = incrementPlannerInvalidation(counters, 'replay');
  expect(selectPlannerInvalidationKeys(counters)).toEqual({
    daily: initial.daily + 4,
    project: initial.project + 4,
    starred: initial.starred + 4,
    runHistory: initial.runHistory + 2,
    pageDetail: initial.pageDetail + 2,
  });
});

test.each([
  ['session_created', ['daily', 'project', 'starred', 'runHistory']],
  ['session_updated', []],
  ['session_deleted', ['daily', 'project', 'starred', 'runHistory']],
  ['metadata_updated', []],
  ['catalog', []],
  ['folder', ['daily', 'project', 'starred']],
  ['custom_view', []],
  ['replay', ['daily', 'project', 'starred', 'runHistory', 'pageDetail']],
  ['page', ['daily', 'project', 'starred', 'pageDetail']],
] as const)('%s source는 지정된 selector만 무효화한다', (source, expectedChanged) => {
  const initial = selectPlannerInvalidationKeys(createPlannerInvalidationCounters());
  const next = selectPlannerInvalidationKeys(
    incrementPlannerInvalidation(createPlannerInvalidationCounters(), source),
  );
  const changed = (Object.keys(initial) as (keyof typeof initial)[])
    .filter((key) => next[key] !== initial[key]);

  expect(changed).toEqual(expectedChanged);
});
