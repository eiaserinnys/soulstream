import { boardLaneGeometry, boardDropStatus, boardVisibleColumns, boardSnapOffsets, BOARD_COLUMNS } from '../card-board-layout';

test.each([390, 430])('phone %s: ordinary lanes align left and final lane ends at the right gutter', (width) => {
  const g = boardLaneGeometry(width, 256, 8, true);
  expect(g.laneWidth).toBeLessThan(width);
  expect(g.inset).toBe(8);
  expect(g.stride).toBe(g.laneWidth + g.gap);
  const columns = boardVisibleColumns(false);
  expect(columns.map(([status]) => status)).toEqual(['todo', 'queued', 'running', 'blocked', 'review']);
  const offsets = boardSnapOffsets(width, g, columns.length);
  expect(offsets[0]).toBe(0);
  expect(g.inset + g.stride * 2 - offsets[2]).toBe(g.inset);
  expect(g.inset + g.stride * 4 - offsets[4] + g.laneWidth).toBe(width - g.inset);
  const shown = boardSnapOffsets(width, g, boardVisibleColumns(true).length);
  expect(g.inset + g.stride * 5 - shown[5] + g.laneWidth).toBe(width - g.inset);
  expect(BOARD_COLUMNS[4][0]).toBe('review');
});

test('wide viewport snap offsets clamp and deduplicate without end spacers', () => {
  const g = boardLaneGeometry(1210, 256, 8, false);
  const offsets = boardSnapOffsets(1210, g, boardVisibleColumns(false).length);
  expect(offsets).toEqual([0, (g.stride * 4 + g.laneWidth) - 1210]);
  expect(offsets.length).toBe(new Set(offsets).size);
});

test('drop uses viewport and scroll position, excludes outside and source lane', () => {
  const g = boardLaneGeometry(390, 256, 8, true);
  const frame = { x: 10, y: 100, width: 390, height: 600 };
  expect(boardDropStatus(390, 300, frame, g, 4 * g.stride, 'review', boardVisibleColumns(true))).toBe('done');
  expect(boardDropStatus(390, 300, frame, g, 4 * g.stride, 'review', boardVisibleColumns(false))).toBeNull();
  expect(boardDropStatus(200, 300, frame, g, 4 * g.stride, 'review')).toBeNull();
  expect(boardDropStatus(200, 50, frame, g, 0, 'todo')).toBeNull();
  expect(boardDropStatus(401, 300, frame, g, 0, 'todo')).toBeNull();
});
