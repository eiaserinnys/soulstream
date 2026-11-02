import { boardLaneGeometry, boardLaneOffset, boardDropStatus, boardVisibleColumns, boardSnapOffsets, BOARD_COLUMNS } from '../card-board-layout';

test('completed grid owns variable lane boundaries for snap, drop and maximum scroll', () => {
  const columns=boardVisibleColumns(true);
  const g=boardLaneGeometry(1100,256,8,false,columns,8);
  expect(g.lanes.find(lane=>lane.status==='done')?.width).toBe(3*256+2*8+16);
  const done=g.lanes.find(lane=>lane.status==='done')!;
  const cancelled=g.lanes.at(-1)!;
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.width).toBe(g.laneWidth);
  expect(boardDropStatus(100,100,{x:0,y:0,width:1100,height:600},g,cancelled.start,'review',columns)).toBe('cancelled');
  const frame={x:0,y:0,width:1100,height:600};
  expect(boardDropStatus(100,100,frame,g,done.start,'review',columns)).toBe('done');
  expect(boardSnapOffsets(1100,g,columns.length).at(-1)).toBe(g.maxScroll);
});

test.each([390, 430])('phone %s: ordinary lanes align left and final lane ends at the right gutter', (width) => {
  const columns = boardVisibleColumns(false);
  const g = boardLaneGeometry(width, 256, 8, true, columns);
  expect(g.laneWidth).toBeLessThan(width);
  expect(g.inset).toBe(8);
  expect(g.stride).toBe(g.laneWidth + g.gap);
  expect(columns.map(([status]) => status)).toEqual(['todo', 'queued', 'running', 'blocked', 'review', 'on_hold']);
  const offsets = boardSnapOffsets(width, g, columns.length);
  expect(offsets[0]).toBe(0);
  expect(g.inset + g.stride * 2 - offsets[2]).toBe(g.inset);
  const lastOrdinary = g.lanes[columns.length - 1];
  expect(g.inset + lastOrdinary.start - offsets.at(-1)! + lastOrdinary.width).toBe(width - g.inset);
  const allColumns = boardVisibleColumns(true);
  const allGeometry = boardLaneGeometry(width, 256, 8, true, allColumns);
  const shown = boardSnapOffsets(width, allGeometry, allColumns.length);
  const lastShown = allGeometry.lanes[allColumns.length - 1];
  expect(allGeometry.inset + lastShown.start - shown.at(-1)! + lastShown.width).toBe(width - allGeometry.inset);
  expect(BOARD_COLUMNS[4][0]).toBe('review');
  expect(BOARD_COLUMNS[5][0]).toBe('on_hold');
});

test('wide viewport snap offsets clamp and deduplicate without end spacers', () => {
  const columns = boardVisibleColumns(false);
  const g = boardLaneGeometry(1210, 256, 8, false, columns);
  const offsets = boardSnapOffsets(1210, g, columns.length);
  expect(offsets).toEqual([0, g.stride, g.maxScroll]);
  expect(offsets.length).toBe(new Set(offsets).size);
});

test('empty board has no scroll offsets and invalid lane offsets resolve to the origin', () => {
  const columns = [] as const;
  const geometry = boardLaneGeometry(800, 256, 8, false, columns);
  expect(geometry.lanes).toEqual([]);
  expect(geometry.maxScroll).toBe(0);
  expect(boardLaneOffset(0, 800, geometry, 0)).toBe(0);
  expect(boardSnapOffsets(800, geometry, 0)).toEqual([]);
});

test('drop uses viewport and scroll position, excludes outside and source lane', () => {
  const columns = boardVisibleColumns(true);
  const g = boardLaneGeometry(390, 256, 8, true, columns);
  const frame = { x: 10, y: 100, width: 390, height: 600 };
  const done = g.lanes.find(lane => lane.status === 'done')!;
  const scrollToDone = done.start + g.inset - (200 - frame.x) + 1;
  expect(boardDropStatus(200, 300, frame, g, scrollToDone, 'review', columns)).toBe('done');
  expect(boardDropStatus(200, 300, frame, g, scrollToDone, 'review', boardVisibleColumns(false))).toBeNull();
  expect(boardDropStatus(200, 300, frame, g, 4 * g.stride, 'review')).toBeNull();
  expect(boardDropStatus(200, 50, frame, g, 0, 'todo')).toBeNull();
  expect(boardDropStatus(401, 300, frame, g, 0, 'todo')).toBeNull();
});
