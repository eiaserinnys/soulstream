import {
  calculateTwoPaneWidths,
  clampThreePaneLeftDrag,
  clampThreePaneMiddleDrag,
  clampTwoPaneMiddleDrag,
  resolveThreePaneWidths,
  resolveSplitLayoutMode,
  resolveTwoPaneMiddleWidth,
  THREE_PANE_MIN_SAFE_WIDTH,
  TWO_PANE_MIN_SAFE_WIDTH,
} from '../paneWidths';

describe('main split pane widths', () => {
  it('resolves landscape defaults and preserves widths that leave the feed at its minimum', () => {
    expect(resolveThreePaneWidths({
      rowWidth: 1170,
      panelGap: 12,
      paneLeftWidth: 240,
      paneMiddleWidth: 480,
    })).toEqual({ left: 240, middle: 480 });

    expect(resolveThreePaneWidths({
      rowWidth: 1170,
      panelGap: 12,
      paneLeftWidth: 240,
      paneMiddleWidth: 900,
    })).toEqual({ left: 240, middle: 606 });

    expect(resolveThreePaneWidths({
      rowWidth: 1170,
      panelGap: 12,
      paneLeftWidth: 360,
      paneMiddleWidth: 600,
    })).toEqual({ left: 360, middle: 486 });
  });

  it('clamps landscape drags against the other pane currently shown and the feed minimum', () => {
    expect(clampThreePaneMiddleDrag(700, {
      rowWidth: 1170,
      panelGap: 12,
      left: 240,
    })).toBe(606);
    expect(clampThreePaneMiddleDrag(200, {
      rowWidth: 1170,
      panelGap: 12,
      left: 240,
    })).toBe(280);

    expect(clampThreePaneLeftDrag(500, {
      rowWidth: 1170,
      panelGap: 12,
      middle: 480,
    })).toBe(366);
    expect(clampThreePaneLeftDrag(100, {
      rowWidth: 1170,
      panelGap: 12,
      middle: 480,
    })).toBe(180);
  });

  it('keeps the portrait default until a portrait width is saved, then fits the feed', () => {
    const base = {
      rowWidth: 810,
      panelGap: 12,
      windowWidth: 834,
      paneMiddleWidth: 480,
    };

    expect(resolveTwoPaneMiddleWidth({ ...base, paneMiddleWidthTwoPane: null })).toBe(417);
    expect(resolveTwoPaneMiddleWidth({ ...base, paneMiddleWidthTwoPane: 480 })).toBe(480);
    expect(resolveTwoPaneMiddleWidth({ ...base, paneMiddleWidthTwoPane: 700 })).toBe(498);
  });

  it('clamps portrait drags while preserving the minimum feed width', () => {
    expect(clampTwoPaneMiddleDrag(600, { rowWidth: 810, panelGap: 12 })).toBe(498);
    expect(clampTwoPaneMiddleDrag(100, { rowWidth: 810, panelGap: 12 })).toBe(280);
  });
});

describe('iphone duo split modes', () => {
  it('keeps the compact mode until the safe width can hold two panes', () => {
    expect(resolveSplitLayoutMode(TWO_PANE_MIN_SAFE_WIDTH - 1)).toBe('compact');
    expect(resolveSplitLayoutMode(TWO_PANE_MIN_SAFE_WIDTH)).toBe('two-pane');
    expect(resolveSplitLayoutMode(THREE_PANE_MIN_SAFE_WIDTH - 1)).toBe('two-pane');
    expect(resolveSplitLayoutMode(THREE_PANE_MIN_SAFE_WIDTH)).toBe('three-pane');
  });

  it('uses the inner duo safe widths for two and three panes', () => {
    expect(resolveSplitLayoutMode(669)).toBe('two-pane');
    expect(resolveSplitLayoutMode(867)).toBe('two-pane');
    expect(resolveSplitLayoutMode(626)).toBe('two-pane');
  });

  it('fits the two-pane widths to the measured row', () => {
    expect(calculateTwoPaneWidths(645)).toEqual({ middle: 333, right: 300 });
    expect(calculateTwoPaneWidths(843)).toEqual({ middle: 475, right: 356 });
    expect(calculateTwoPaneWidths(843).middle + calculateTwoPaneWidths(843).right + 12).toBe(843);
    expect(calculateTwoPaneWidths(1200, 12).right).toBeLessThanOrEqual(400);
  });
});
