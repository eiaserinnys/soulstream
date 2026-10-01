import { boardLaneGeometry, boardDropStatus, BOARD_COLUMNS } from '../card-board-layout';

test.each([390, 430])('phone %s: compact paper remains fixed with two peeks and lane snap', (width) => {
  const g = boardLaneGeometry(width, 256, 8, true);
  expect(g.laneWidth).toBeLessThan(width);
  expect(g.inset - g.gap).toBeGreaterThan(0);
  expect(g.stride).toBe(g.laneWidth + g.gap);
  expect(BOARD_COLUMNS[4][0]).toBe('review');
});

test('drop uses viewport and scroll position, excludes outside and source lane', () => {
  const g = boardLaneGeometry(390, 256, 8, true);
  const frame = { x: 10, y: 100, width: 390, height: 600 };
  expect(boardDropStatus(390, 300, frame, g, 4 * g.stride, 'review')).toBe('done');
  expect(boardDropStatus(200, 300, frame, g, 4 * g.stride, 'review')).toBeNull();
  expect(boardDropStatus(200, 50, frame, g, 0, 'todo')).toBeNull();
  expect(boardDropStatus(401, 300, frame, g, 0, 'todo')).toBeNull();
});
