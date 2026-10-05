import { describe, expect, it } from 'vitest';
import { calculatePersistentSessionLayout } from './persistent-session-layout';

const app = { left: 0, top: 0, width: 1440, height: 900 };
const header = { left: 0, top: 0, width: 1440, height: 76 };
const inputRowHeight = 44;

function layout(overrides: Partial<Parameters<typeof calculatePersistentSessionLayout>[0]> = {}) {
  return calculatePersistentSessionLayout({
    app,
    header,
    main: { left: 460, top: 76, width: 520, height: 700 },
    composer: { left: 460, top: 720, width: 520, height: 80 },
    inputRowHeight,
    pointerFine: true,
    showCharacter: true,
    phoneConfigured: false,
    ...overrides,
  });
}

describe('calculatePersistentSessionLayout', () => {
  it('matches the approved viewport fixtures', () => {
    expect(layout().body).toEqual({ left: 138, top: 445, width: 184, height: 276 });
    expect(layout({
      app: { left: 0, top: 0, width: 1728, height: 1117 },
      main: { left: 604, top: 76, width: 520, height: 900 },
      composer: { left: 604, top: 992, width: 520, height: 80 },
    }).body).toEqual({ left: 182, top: 633, width: 240, height: 360 });
    expect(layout({
      app: { left: 0, top: 0, width: 1920, height: 1080 },
      main: { left: 700, top: 76, width: 520, height: 850 },
      composer: { left: 700, top: 955, width: 520, height: 80 },
    }).body?.width).toBe(240);
    expect(layout({
      app: { left: 0, top: 0, width: 1280, height: 900 },
      main: { left: 380, top: 76, width: 520, height: 700 },
      composer: { left: 380, top: 720, width: 520, height: 80 },
    }).body?.width).toBe(152);
    expect(layout({
      app: { left: 0, top: 0, width: 1180, height: 820 },
      main: { left: 350, top: 76, width: 480, height: 680 },
      composer: { left: 350, top: 640, width: 480, height: 80 },
      pointerFine: false,
    }).body?.width).toBe(152);
    expect(layout({
      app: { left: 0, top: 0, width: 820, height: 1180 },
      main: { left: 210, top: 76, width: 400, height: 1000 },
      composer: { left: 210, top: 400, width: 400, height: 80 },
      pointerFine: false,
    }).body?.width).toBe(126);
    expect(layout({
      app: { left: 0, top: 0, width: 390, height: 844 },
      main: { left: 0, top: 76, width: 390, height: 700 },
      composer: { left: 0, top: 720, width: 390, height: 80 },
      pointerFine: false,
      phoneConfigured: true,
    })).toMatchObject({ body: null, toggle: null, lineLeftReach: 0 });
  });

  it('hides the body and toggle when the composer leaves too little vertical room', () => {
    expect(layout({
      app: { left: 0, top: 0, width: 768, height: 900 },
      main: { left: 204, top: 56, width: 360, height: 200 },
      header: { left: 0, top: 0, width: 768, height: 56 },
      composer: { left: 204, top: 130, width: 360, height: 60 },
    })).toMatchObject({ body: null, toggle: null, lineLeftReach: 0 });
    expect(layout({
      app: { left: 0, top: 0, width: 1440, height: 900 },
      composer: { left: 460, top: 880, width: 520, height: 20 },
    })).toMatchObject({ body: null, toggle: null, lineLeftReach: 0 });
  });

  it('keeps the toggle when character display is off and follows a growing composer', () => {
    const off = layout({ showCharacter: false });
    expect(off.body).toBeNull();
    expect(off.toggle).toEqual({ left: 210, top: 734, width: 40, height: 40 });
    expect(off.lineLeftReach).toBe(0);

    const original = layout();
    const grown = layout({ composer: { left: 460, top: 680, width: 520, height: 120 } });
    expect(original.lineY - grown.lineY).toBe(40);
    expect(original.body!.top + original.body!.height - (grown.body!.top + grown.body!.height)).toBe(40);
    expect(original.toggle!.top - grown.toggle!.top).toBe(40);
  });
});
