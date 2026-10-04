import { createPostItRoles } from '../postItRoles';
import { createSessionVisualRoles } from '../sessionVisualRoles';
import {
  DARK_COLORS, DESIGN_RADIUS, DESIGN_SPACING, PHONE_CARD_LAYOUT,
  PHONE_CHAT_TYPOGRAPHY, PHONE_FOUNDATION, TABLET_CARD_LAYOUT,
  TABLET_CHAT_TYPOGRAPHY, TABLET_FOUNDATION, type DesignTokens,
} from '../tokens';
import { CARD_COLOR_KEYS, CARD_COLORS } from '../../../../packages/wire-schema/src/card_colors';

// Follow plannerVisualRoles' fixture pattern; roles consume explicit device tokens.
test.each(['phone', 'tablet'] as const)('%s paper follows feed typography while touch targets stay native', (device) => {
  const tablet = device === 'tablet';
  const foundation = tablet ? TABLET_FOUNDATION : PHONE_FOUNDATION;
  const t = {
    foundation, colors: DARK_COLORS, uiSpacing: DESIGN_SPACING, radius: DESIGN_RADIUS,
    cardLayout: tablet ? TABLET_CARD_LAYOUT : PHONE_CARD_LAYOUT,
    chatFontSize: tablet ? TABLET_CHAT_TYPOGRAPHY : PHONE_CHAT_TYPOGRAPHY,
    hitTarget: { min: foundation.hitTarget },
  } as DesignTokens;
  const feed = createSessionVisualRoles(t);
  const compact = createPostItRoles(t, 'compact');
  const full = createPostItRoles(t);
  for (const color of CARD_COLOR_KEYS) {
    expect(createPostItRoles(t, 'full', color).paper).toBe(CARD_COLORS[color].hex);
    expect(createPostItRoles(t, 'compact', color).paper).toBe(CARD_COLORS[color].hex);
  }
  expect(compact.title).toMatchObject(feed.typography.title);
  expect(compact.body).toMatchObject({ fontSize: 15, lineHeight: 22 });
  expect(compact.label).toMatchObject({ fontSize: 13, lineHeight: 18 });
  expect(compact.width).toBeCloseTo(225.88235);
  expect(compact.height).toBeCloseTo(197.64706);
  expect(full.width).toBeCloseTo(282.35294);
  expect(full.height).toBeCloseTo(247.05882);
  expect(compact.padding).toBeCloseTo(14.11765);
  expect(compact.gap).toBeCloseTo(7.05882);
  expect(compact.footerHeight).toBeCloseTo(foundation.hitTarget * 15 / 17);
  expect(compact.bodyLines).toBe(3);
  expect(Math.floor((compact.height - compact.padding * 2 - compact.footerHeight
    - compact.title.lineHeight - compact.gap * 2) / compact.body.lineHeight)).toBe(4);
  expect(t.hitTarget.min).toBe(tablet ? 48 : 44);
});
