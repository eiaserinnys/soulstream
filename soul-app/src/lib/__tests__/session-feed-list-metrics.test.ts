const ListMetricsAggregator = jest.requireActual(
  '@react-native/virtualized-lists/Lists/ListMetricsAggregator',
).default;
const { computeWindowedRenderLimits } = jest.requireActual(
  '@react-native/virtualized-lists/Lists/VirtualizeUtils',
);
const { CellRenderMask } = jest.requireActual(
  '@react-native/virtualized-lists/Lists/CellRenderMask',
);

const orientation = { horizontal: false, rtl: false };
const initialWindow = { first: 0, last: 7 };
const reorderWindow = { first: 19, last: 32 };
const viewportLength = 724;
const scrollOffset = 2552;

function listProps(data: Array<{ key: string; height: number }>) {
  return {
    data,
    getItemCount: (items: typeof data) => items.length,
    getItem: (items: typeof data, index: number) => items[index],
    keyExtractor: (item: { key: string }) => item.key,
  };
}

function measureRows(data: Array<{ key: string; height: number }>) {
  const metrics = new ListMetricsAggregator();
  let offset = 0;
  data.forEach((item, index) => {
    metrics.notifyCellLayout({
      cellIndex: index,
      cellKey: item.key,
      orientation,
      layout: { x: 0, y: offset, width: 384, height: item.height },
    });
    offset += item.height;
  });
  return metrics;
}

test('keeps exact metrics and recomputes reordered offsets from cached key lengths', () => {
  const original = [
    { key: 'a', height: 40 },
    { key: 'b', height: 100 },
    { key: 'c', height: 60 },
    { key: 'd', height: 80 },
  ];
  const metrics = measureRows(original);
  const measured = metrics._cellMetrics.get('b');
  const exact = metrics.getCellMetricsApprox(1, listProps(original));
  expect(exact).toBe(measured);

  const reordered = [original[0], original[2], original[1], original[3]];
  const props = listProps(reordered);
  const beforeRead = {
    frames: [...metrics._cellMetrics].map(([key, frame]) => [key, { ...frame }]),
    average: metrics.getAverageCellLength(),
    highest: metrics.getHighestMeasuredCellIndex(),
  };

  expect(metrics.getCellMetricsApprox(1, props)).toMatchObject({
    index: 1,
    offset: 40,
    length: 60,
    isMounted: false,
  });
  expect(metrics.getCellMetricsApprox(2, props)).toMatchObject({
    index: 2,
    offset: 100,
    length: 100,
    isMounted: false,
  });
  const exactD = metrics.getCellMetrics(3, props);
  expect(metrics.getCellMetricsApprox(3, props)).toBe(exactD);
  expect(exactD).toMatchObject({
    index: 3,
    offset: 200,
    length: 80,
    isMounted: true,
  });
  expect(metrics.getCellOffsetApprox(1.5, props)).toBe(70);
  expect({
    frames: [...metrics._cellMetrics].map(([key, frame]) => [key, { ...frame }]),
    average: metrics.getAverageCellLength(),
    highest: metrics.getHighestMeasuredCellIndex(),
  }).toEqual(beforeRead);
});

test('returns getItemLayout metrics for an unmeasured row', () => {
  const data = [
    { key: 'a', height: 40 },
    { key: 'b', height: 100 },
    { key: 'c', height: 60 },
  ];
  const metrics = new ListMetricsAggregator();
  const props = {
    ...listProps(data),
    getItemLayout: (items: typeof data, index: number) => ({
      length: items[index].height,
      offset: items.slice(0, index).reduce((sum, item) => sum + item.height, 0),
    }),
  };

  expect(metrics.getCellMetricsApprox(1, props)).toMatchObject({
    index: 1,
    offset: 40,
    length: 100,
    isMounted: true,
  });
});

test('preserves average estimates only for new keys and preserves a measured zero length', () => {
  const original = [
    { key: 'a', height: 40 },
    { key: 'b', height: 100 },
    { key: 'c', height: 60 },
    { key: 'd', height: 80 },
  ];
  const metrics = measureRows(original);
  const prepended = [{ key: 'new', height: 70 }, ...original];
  const prependedProps = listProps(prepended);
  expect([0, 1, 2, 3, 4].map((index) => {
    const frame = metrics.getCellMetricsApprox(index, prependedProps);
    return [frame.offset, frame.length];
  })).toEqual([[0, 70], [70, 40], [110, 100], [210, 60], [270, 80]]);

  const newlyMeasured = { key: 'new', height: 50 };
  metrics.notifyCellLayout({
    cellIndex: 0,
    cellKey: newlyMeasured.key,
    orientation,
    layout: { x: 0, y: 0, width: 384, height: newlyMeasured.height },
  });
  expect([1, 2, 3, 4].map((index) => {
    const frame = metrics.getCellMetricsApprox(index, prependedProps);
    return [frame.offset, frame.length];
  })).toEqual([[50, 40], [90, 100], [190, 60], [250, 80]]);

  const appendMetrics = measureRows(original);
  const appended = [...original, { key: 'tail', height: 50 }];
  expect(appendMetrics.getCellMetricsApprox(4, listProps(appended))).toMatchObject({
    index: 4,
    offset: 280,
    length: 70,
    isMounted: false,
  });

  const zeroRows = [{ key: 'zero', height: 0 }, { key: 'normal', height: 20 }];
  const zeroMetrics = measureRows(zeroRows);
  const zeroReordered = [zeroRows[1], zeroRows[0]];
  expect(zeroMetrics.getCellMetricsApprox(1, listProps(zeroReordered))).toMatchObject({
    index: 1,
    offset: 20,
    length: 0,
    isMounted: false,
  });
});

test('keeps the measured review header and content stable through the reordered list layout passes', () => {
  const original = feedFixture();
  const metrics = measureRows(original);
  const preReorderSnapshot = layoutSnapshot(original, reorderWindow, metrics);
  let mounted = new Map(preReorderSnapshot.cells.map((cell) => [cell.key, cell]));

  const data = [...original];
  const [movedRunningSession] = data.splice(22, 1);
  data.splice(3, 0, movedRunningSession);

  let window = { ...reorderWindow };
  const trace: Array<{
    headerY: number | undefined;
    screenY: number | undefined;
    contentHeight: number;
    leadingGap: number | undefined;
    window: { first: number; last: number };
    nextWindow: { first: number; last: number };
  }> = [];

  for (let pass = 0; pass < 2; pass += 1) {
    const snapshot = layoutSnapshot(data, window, metrics);
    mounted = deliverLayouts(metrics, snapshot, mounted);
    const nextWindow = computeWindow(data, window, metrics);
    const reviewHeader = snapshot.cells.find((cell) => cell.key === 'review:heading');
    trace.push({
      headerY: reviewHeader?.offset,
      screenY: reviewHeader ? reviewHeader.offset - scrollOffset : undefined,
      contentHeight: snapshot.height,
      leadingGap: snapshot.gaps.find((gap) => gap.first === 8)?.height,
      window: { ...window },
      nextWindow: { ...nextWindow },
    });
    window = nextWindow;
  }

  expect(trace).toEqual([
    {
      headerY: 2568,
      screenY: 16,
      contentHeight: 3836,
      leadingGap: 1342,
      window: { first: 19, last: 32 },
      nextWindow: { first: 19, last: 32 },
    },
    {
      headerY: 2568,
      screenY: 16,
      contentHeight: 3836,
      leadingGap: 1342,
      window: { first: 19, last: 32 },
      nextWindow: { first: 19, last: 32 },
    },
  ]);
});

function feedFixture() {
  return [
    { key: 'attention:heading', height: 48 },
    { key: 'attention:empty', height: 32 },
    { key: 'running:heading', height: 48 },
    ...Array.from({ length: 20 }, (_, index) => ({ key: `running:r${index + 1}`, height: 122 })),
    { key: 'review:heading', height: 48 },
    ...Array.from({ length: 10 }, (_, index) => ({ key: `review:v${index + 1}`, height: 122 })),
  ];
}

function maskForWindow(data: Array<{ key: string; height: number }>, window: { first: number; last: number }) {
  const mask = new CellRenderMask(data.length);
  mask.addCells(window);
  mask.addCells(initialWindow);
  return mask;
}

function layoutSnapshot(
  data: Array<{ key: string; height: number }>,
  window: { first: number; last: number },
  metrics: InstanceType<typeof ListMetricsAggregator>,
) {
  const mask = maskForWindow(data, window);
  const regions = mask.enumerateRegions();
  const lastRegion = regions[regions.length - 1];
  const lastSpacer = lastRegion?.isSpacer ? lastRegion : null;
  const props = listProps(data);
  let offset = 0;
  const cells: Array<{ index: number; key: string; offset: number; length: number }> = [];
  const gaps: Array<{ first: number; last: number; height: number }> = [];

  for (const region of regions) {
    if (region.isSpacer) {
      const end = region === lastSpacer
        ? Math.max(region.first - 1, Math.min(region.last, metrics.getHighestMeasuredCellIndex()))
        : region.last;
      const firstFrame = metrics.getCellMetricsApprox(region.first, props);
      const endFrame = metrics.getCellMetricsApprox(end, props);
      const height = Math.max(0, endFrame.offset + endFrame.length - firstFrame.offset);
      gaps.push({ first: region.first, last: region.last, height });
      offset += height;
    } else {
      for (let index = region.first; index <= region.last; index += 1) {
        const item = data[index];
        cells.push({ index, key: item.key, offset, length: item.height });
        offset += item.height;
      }
    }
  }
  return { mask, cells, gaps, height: offset };
}

function deliverLayouts(
  metrics: InstanceType<typeof ListMetricsAggregator>,
  snapshot: ReturnType<typeof layoutSnapshot>,
  previousMounted: Map<string, { offset: number; length: number }>,
) {
  const mounted = new Map(snapshot.cells.map((cell) => [cell.key, cell]));
  for (const key of previousMounted.keys()) {
    if (!mounted.has(key)) metrics.notifyCellUnmounted(key);
  }
  for (const cell of snapshot.cells) {
    const previous = previousMounted.get(cell.key);
    if (!previous || previous.offset !== cell.offset || previous.length !== cell.length) {
      metrics.notifyCellLayout({
        cellIndex: cell.index,
        cellKey: cell.key,
        orientation,
        layout: { x: 0, y: cell.offset, width: 384, height: cell.length },
      });
    }
  }
  metrics.notifyListContentLayout({
    orientation,
    layout: { width: 384, height: snapshot.height },
  });
  return mounted;
}

function computeWindow(
  data: Array<{ key: string; height: number }>,
  previousWindow: { first: number; last: number },
  metrics: InstanceType<typeof ListMetricsAggregator>,
) {
  return computeWindowedRenderLimits(
    listProps(data),
    6,
    2,
    previousWindow,
    metrics,
    { dt: 50, offset: scrollOffset, velocity: 0, visibleLength: viewportLength, zoomScale: 1 },
  );
}
