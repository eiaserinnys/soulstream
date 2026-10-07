import { describe, expect, it } from 'vitest';
import { calculatePersistentSessionLayout } from './persistent-session-layout';

const app = { left: 0, top: 0, width: 1440, height: 900 };
const header = { left: 0, top: 0, width: 1440, height: 76 };
const inputRowHeight = 44;
const rowBottomGap = 4;

function layout(overrides: Partial<Parameters<typeof calculatePersistentSessionLayout>[0]> = {}) {
  return calculatePersistentSessionLayout({
    app,
    header,
    main: { left: 460, top: 76, width: 520, height: 700 },
    baselineBottom: 800,
    inputRowHeight,
    rowBottomGap,
    pointerFine: true,
    showCharacter: true,
    phoneConfigured: false,
    ...overrides,
  });
}

describe('calculatePersistentSessionLayout', () => {
  it('matches the approved viewport fixtures', () => {
    expect(layout().body).toEqual({ left: 162, top: 524, width: 184, height: 276 });
    expect(layout({
      app: { left: 0, top: 0, width: 1728, height: 1117 },
      main: { left: 604, top: 76, width: 520, height: 900 },
      baselineBottom: 1072,
    }).body).toEqual({ left: 206, top: 712, width: 240, height: 360 });
    expect(layout({
      app: { left: 0, top: 0, width: 1920, height: 1080 },
      main: { left: 700, top: 76, width: 520, height: 850 },
      baselineBottom: 1035,
    }).body?.width).toBe(240);
    expect(layout({
      app: { left: 0, top: 0, width: 1280, height: 900 },
      main: { left: 380, top: 76, width: 520, height: 700 },
      baselineBottom: 800,
    }).body?.width).toBe(152);
    expect(layout({
      app: { left: 0, top: 0, width: 1180, height: 820 },
      main: { left: 350, top: 76, width: 480, height: 680 },
      baselineBottom: 720,
      pointerFine: false,
    }).body?.width).toBe(152);
    expect(layout({
      app: { left: 0, top: 0, width: 820, height: 1180 },
      main: { left: 210, top: 76, width: 400, height: 1000 },
      baselineBottom: 480,
      pointerFine: false,
    }).body).toEqual({ left: 66, top: 291, width: 126, height: 189 });
    expect(layout({
      app: { left: 0, top: 0, width: 390, height: 844 },
      main: { left: 0, top: 76, width: 390, height: 700 },
      baselineBottom: 800,
      pointerFine: false,
      phoneConfigured: true,
    })).toMatchObject({ body: null, toggle: null, lineLeftReach: 0 });
  });

  it('seats the body on the baseline and aligns the toggle center to the input row', () => {
    const result = layout();
    expect(result.lineY).toBe(799);
    expect(result.body!.top + result.body!.height).toBe(result.lineY + 1);
    expect(result.toggle!.top + result.toggle!.height / 2).toBe(
      result.lineY - rowBottomGap - inputRowHeight / 2,
    );
  });

  it('centers the toggle and character as one group in the left gutter', () => {
    const portrait = layout({
      app: { left: 0, top: 0, width: 820, height: 1180 },
      main: { left: 210, top: 76, width: 400, height: 1000 },
      baselineBottom: 480,
      pointerFine: false,
    });
    expect(portrait.body!.width).toBe(126);
    expect(portrait.toggle!.left).toBe(18);
    expect(portrait.body!.left).toBe(66);
    expect(portrait.toggle!.left + portrait.toggle!.width + 8 + portrait.body!.width).toBe(192);
    expect((portrait.toggle!.left + 192) / 2).toBe(105);
  });

  it('keeps the toggle in place and removes the left extension when character display is off', () => {
    const visible = layout();
    const hidden = layout({ showCharacter: false });
    expect(hidden.body).toBeNull();
    expect(hidden.toggle).toEqual(visible.toggle);
    expect(hidden.lineLeftReach).toBe(0);
  });

  it('hides both controls when the body cannot meet its minimum size', () => {
    expect(layout({
      app: { left: 0, top: 0, width: 768, height: 900 },
      main: { left: 204, top: 56, width: 360, height: 200 },
      header: { left: 0, top: 0, width: 768, height: 56 },
      baselineBottom: 190,
    })).toMatchObject({ body: null, toggle: null, lineLeftReach: 0 });
  });

  it('does not hide the toggle merely because the baseline is near the viewport bottom', () => {
    const result = layout({ baselineBottom: 900 });
    expect(result.body).not.toBeNull();
    expect(result.toggle).not.toBeNull();
  });
});
