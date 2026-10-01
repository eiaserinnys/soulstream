import {
  getStarredFolderMoveTarget,
  moveStarredFolderBefore,
  reconcileStarredFolderLayouts,
  resolveStarredFolderBoundaryTarget,
} from '../starred-folder-order';

const folders = (...ids: string[]) => ids.map((id) => ({ page: { id } }));

test.each([
  ['a', 180, 'c'],
  ['c', 20, 'a'],
  ['b', 320, null],
])('드롭 위치는 source를 제외한 다음 이웃을 target으로 계산한다 (%s, y=%s)', (source, y, expected) => {
  expect(getStarredFolderMoveTarget(
    folders('a', 'b', 'c'),
    source,
    [
      { pageId: 'a', top: 0, height: 80 },
      { pageId: 'b', top: 81, height: 80 },
      { pageId: 'c', top: 162, height: 80 },
    ],
    y,
  )).toBe(expected);
});

test('낙관적 목록 이동은 loaded target 앞에만 삽입한다', () => {
  expect(moveStarredFolderBefore(folders('a', 'b', 'c'), 'a', 'c').map((folder) => folder.page.id))
    .toEqual(['b', 'a', 'c']);
  expect(moveStarredFolderBefore(folders('a', 'b', 'c'), 'a', null).map((folder) => folder.page.id))
    .toEqual(['b', 'c', 'a']);
  expect(() => moveStarredFolderBefore(folders('a', 'b'), 'a', 'not-loaded'))
    .toThrow();
  expect(moveStarredFolderBefore(folders('a', 'b'), 'a', 'next-page', true).map((folder) => folder.page.id))
    .toEqual(['b', 'a']);
});

test('부분목록 경계 target은 다음 cursor 페이지 첫 ID를 쓴다', () => {
  expect(resolveStarredFolderBoundaryTarget(
    ['a', 'b', 'c'],
    'b',
    { items: folders('d', 'e'), nextCursor: 'cursor-2' },
  )).toBe('d');
});

test('aggregate reorder는 index가 같아도 실제 top이 바뀐 row geometry를 재사용하지 않는다', () => {
  const measuredLayouts = {
    a: { pageId: 'a', top: 0, height: 70 },
    b: { pageId: 'b', top: 71, height: 80 },
    c: { pageId: 'c', top: 152, height: 80 },
    d: { pageId: 'd', top: 233, height: 80 },
    e: { pageId: 'e', top: 314, height: 80 },
  };

  const layouts = reconcileStarredFolderLayouts(
    ['d', 'b', 'a', 'c', 'e'],
    measuredLayouts,
    0,
    1,
  );

  expect(layouts.b).toBeUndefined();
  expect(layouts.e).toEqual(measuredLayouts.e);
});

test.each([
  ['빈 다음 페이지', []],
  ['이미 로딩된 항목 중복', ['c', 'd']],
  ['source 재등장', ['b', 'd']],
])('%s인 오래된 경계는 추론하지 않고 실패한다', (_label, nextIds) => {
  expect(() => resolveStarredFolderBoundaryTarget(
    ['a', 'b', 'c'],
    'b',
    { items: folders(...nextIds), nextCursor: null },
  )).toThrow();
});
