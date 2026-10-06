import {
  clampThreePaneLeftDrag,
  clampThreePaneMiddleDrag,
  clampTwoPaneMiddleDrag,
  resolveThreePaneWidths,
  resolveTwoPaneMiddleWidth,
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
    })).toEqual({ left: 240, middle: 666 });

    expect(resolveThreePaneWidths({
      rowWidth: 1170,
      panelGap: 12,
      paneLeftWidth: 360,
      paneMiddleWidth: 600,
    })).toEqual({ left: 360, middle: 546 });
  });

  it('clamps landscape drags against the other pane currently shown and the feed minimum', () => {
    expect(clampThreePaneMiddleDrag(700, {
      rowWidth: 1170,
      panelGap: 12,
      left: 240,
    })).toBe(666);
    expect(clampThreePaneMiddleDrag(200, {
      rowWidth: 1170,
      panelGap: 12,
      left: 240,
    })).toBe(280);

    expect(clampThreePaneLeftDrag(500, {
      rowWidth: 1170,
      panelGap: 12,
      middle: 480,
    })).toBe(426);
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
    expect(resolveTwoPaneMiddleWidth({ ...base, paneMiddleWidthTwoPane: 520 })).toBe(520);
    expect(resolveTwoPaneMiddleWidth({ ...base, paneMiddleWidthTwoPane: 700 })).toBe(558);
  });

  it('clamps portrait drags while preserving the minimum feed width', () => {
    expect(clampTwoPaneMiddleDrag(600, { rowWidth: 810, panelGap: 12 })).toBe(558);
    expect(clampTwoPaneMiddleDrag(100, { rowWidth: 810, panelGap: 12 })).toBe(280);
  });
});
