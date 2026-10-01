import {
  FOUNDATION_MIN_HEIGHT,
  PHONE_FOUNDATION,
  TABLET_FOUNDATION,
  PHONE_CHAT_TYPOGRAPHY,
  TABLET_CHAT_TYPOGRAPHY,
  PHONE_UI_TYPOGRAPHY,
  TABLET_UI_TYPOGRAPHY,
  TABLET_SHELL_LAYOUT,
  DESIGN_RADIUS,
  CONCENTRIC_RADIUS_INSET,
  FOUNDATION_RADIUS,
  FOUNDATION_TYPOGRAPHY,
} from '../tokens';

describe('iOS UI v0.1 foundation token contract', () => {
  test('semantic layout metrics have one canonical source and remain min-height values', () => {
    expect(FOUNDATION_MIN_HEIGHT).toEqual({
      segment: 40,
      field: 52,
      secondary: 48,
      primary: 52,
      context: 52,
      row: 64,
      folder: 80,
      memo: 112,
      tool: 40,
      composer: 56,
    });
    expect(PHONE_FOUNDATION.pageInset).toBe(20);
    expect(TABLET_FOUNDATION.pageInset).toBe(20);
    expect(PHONE_FOUNDATION.minHeight).toBe(FOUNDATION_MIN_HEIGHT);
    expect(TABLET_FOUNDATION.minHeight).toBe(FOUNDATION_MIN_HEIGHT);
  });

  test('phone and iPad keep distinct hit targets while sharing semantic roles', () => {
    expect(PHONE_FOUNDATION.hitTarget).toBe(44);
    expect(TABLET_FOUNDATION.hitTarget).toBe(48);
    expect(PHONE_FOUNDATION.iconFrame.action).toBe(44);
    expect(TABLET_FOUNDATION.iconFrame.action).toBe(48);
    expect(PHONE_FOUNDATION.iconFrame.standard).toBe(40);
    expect(TABLET_FOUNDATION.iconFrame.standard).toBe(40);
  });

  test('iPad shell header, safe-area rhythm, and overlay split share one layout token', () => {
    expect(TABLET_SHELL_LAYOUT).toEqual({
      outerInset: 12,
      panelGap: 12,
      header: {
        minHeight: 60,
        paddingHorizontal: 20,
        paddingVertical: 6,
      },
      folderPane: {
        fraction: 0.46,
        minWidth: 340,
        maxWidth: 420,
      },
    });
  });

  test('typography roles and chat reading sizes remain device-specific', () => {
    expect(PHONE_UI_TYPOGRAPHY).toEqual({ meta: 13, body: 15, rowTitle: 18, screenTitle: 22 });
    expect(TABLET_UI_TYPOGRAPHY).toEqual({ meta: 14, body: 16, rowTitle: 20, screenTitle: 24 });
    expect(PHONE_CHAT_TYPOGRAPHY.body).toBe(17);
    expect(TABLET_CHAT_TYPOGRAPHY.body).toBe(18);
    expect(FOUNDATION_TYPOGRAPHY).toEqual({
      display: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
      navigation: { fontSize: 20, lineHeight: 26, fontWeight: '600' },
      section: { fontSize: 18, lineHeight: 24, fontWeight: '700' },
      cardTitle: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
      body: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
      meta: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
      label: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
      mono: { fontSize: 13, lineHeight: 19, fontWeight: '400' },
    });
    expect(PHONE_FOUNDATION.typography).toBe(FOUNDATION_TYPOGRAPHY);
    expect(TABLET_FOUNDATION.typography).toBe(FOUNDATION_TYPOGRAPHY);
    expect(FOUNDATION_RADIUS).toEqual({
      chip: 8,
      field: 14,
      row: 16,
      card: 18,
      panel: 24,
      round: 999,
    });
    expect(PHONE_FOUNDATION.radius).toBe(FOUNDATION_RADIUS);
    expect(TABLET_FOUNDATION.radius).toBe(FOUNDATION_RADIUS);
    expect(DESIGN_RADIUS).toEqual({ sm: 8, md: 12, lg: 16 });
  });

  test('nested surface radii are derived from concentric inset steps', () => {
    expect(FOUNDATION_RADIUS.panel - CONCENTRIC_RADIUS_INSET.panelToCard)
      .toBe(FOUNDATION_RADIUS.card);
    expect(FOUNDATION_RADIUS.card - CONCENTRIC_RADIUS_INSET.cardToField)
      .toBe(FOUNDATION_RADIUS.field);
    expect(FOUNDATION_RADIUS.row - CONCENTRIC_RADIUS_INSET.rowToChip)
      .toBe(FOUNDATION_RADIUS.chip);
  });
});
