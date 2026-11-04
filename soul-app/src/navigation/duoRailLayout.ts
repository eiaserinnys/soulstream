import { railCapsuleHeight, RAIL_CAPSULE_WIDTH } from '../components/navigation/RailCapsule';
import { showAppContextMenu } from '../components/menus/AppContextMenu';
import type { PhoneRailAction } from './phoneRailActions';

export function duoRailLayout({ exit, screen, nav, rare, menu, windowHeight, topStart, bottomReserve, keyboardOverlap, tokens }: {
  exit: PhoneRailAction | null; screen: PhoneRailAction[]; nav: PhoneRailAction[]; rare: PhoneRailAction[];
  menu: PhoneRailAction | null; windowHeight: number; topStart: number; bottomReserve: number; keyboardOverlap: number;
  tokens: { spacingXs: number; uiSpacingXs: number; uiSpacingSm: number; hitTargetMin: number };
}) {
  const screenOrder = (item: PhoneRailAction) => item.kind === 'status' ? 0 : item.kind === 'view' ? 2 : 1;
  const orderedScreen = [...screen].sort((a, b) => screenOrder(a) - screenOrder(b));
  const original = [...orderedScreen, ...nav];
  const regularNeed = railCapsuleHeight(screen.length + (menu || rare.length ? 1 : 0), false, tokens)
    + (screen.length + (menu || rare.length ? 1 : 0) && nav.length ? tokens.uiSpacingSm : 0)
    + railCapsuleHeight(nav.length, false, tokens);
  const regularAvailable = windowHeight - bottomReserve - topStart - (exit ? RAIL_CAPSULE_WIDTH + tokens.uiSpacingSm : 0);
  const compact = windowHeight < 500 || regularNeed > regularAvailable;
  const gap = compact ? tokens.uiSpacingXs : tokens.uiSpacingSm;
  const visibleScreen = [...orderedScreen];
  const visibleNav = keyboardOverlap > 0 ? [] : [...nav];
  const folded: PhoneRailAction[] = [];
  const available = windowHeight - Math.max(bottomReserve, keyboardOverlap) - topStart - (exit ? RAIL_CAPSULE_WIDTH + gap : 0);
  const need = () => {
    const screenCount = visibleScreen.length + (menu || rare.length || folded.length ? 1 : 0);
    return railCapsuleHeight(screenCount, compact, tokens)
      + (screenCount && visibleNav.length ? gap : 0) + railCapsuleHeight(visibleNav.length, compact, tokens);
  };
  const priority = (item: PhoneRailAction, index: number) => {
    switch (item.kind) {
      case 'status': return 0;
      case 'settings': return 2;
      case 'nav': return 3 + (visibleNav.length - index) / 100;
      case 'view': return 4 + (item.badgeCount || item.dot ? 1 : 0);
      default: return 1;
    }
  };
  while (need() > available) {
    const candidates = [...visibleScreen.map((item, index) => ({ item, index, list: visibleScreen })),
      ...visibleNav.map((item, index) => ({ item, index, list: visibleNav }))]
      .filter(({ item }) => item.kind !== 'exit' && item.kind !== 'menu');
    candidates.sort((a, b) => priority(a.item, a.index) - priority(b.item, b.index));
    if (!candidates.length) break;
    const chosen = candidates[0];
    chosen.list.splice(chosen.index, 1);
    folded.push(chosen.item);
  }
  folded.sort((a, b) => original.indexOf(a) - original.indexOf(b));
  const overflow: PhoneRailAction | null = menu || rare.length || folded.length ? {
    ...(menu ?? { id: 'more', label: '더 보기', icon: 'ellipsis-horizontal' as const, onPress: () => {} }),
    dot: Boolean(menu?.dot || folded.some(item => item.dot || item.badgeCount)),
    onPress: () => {
      if (menu && !menu.menuItems && !folded.length && !rare.length) return menu.onPress();
      showAppContextMenu([
      ...folded.map(item => ({ key: item.id, label: item.menuLabel ?? item.label, disabled: item.disabled, onSelect: item.onPress })),
      ...(menu?.menuItems?.() ?? (menu ? [{ key: menu.id, label: menu.label, onSelect: menu.onPress }] : [])),
      ...rare.map(item => ({ key: item.id, label: item.menuLabel ?? item.label, disabled: item.disabled, onSelect: item.onPress })),
      ], menu?.menuTitle);
    },
  } : null;
  return { compact, exit, screen: overflow ? [overflow, ...visibleScreen] : visibleScreen, nav: visibleNav, folded, overflow };
}
