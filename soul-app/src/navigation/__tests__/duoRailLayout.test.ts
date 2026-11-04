import { duoRailLayout } from '../duoRailLayout';
import type { PhoneRailAction } from '../phoneRailActions';

const action = (id: string, kind: PhoneRailAction['kind'] = 'action', extra: Partial<PhoneRailAction> = {}): PhoneRailAction =>
  ({ id, kind, label: id, icon: 'add', onPress: jest.fn(), ...extra });
const phoneTokens = { spacingXs: 4, uiSpacingXs: 4, uiSpacingSm: 8, hitTargetMin: 44 };
const tabletTokens = { ...phoneTokens, spacingXs: 6, hitTargetMin: 48 };
const layout = (options: Partial<Parameters<typeof duoRailLayout>[0]>) => duoRailLayout({
  exit: null, screen: [], nav: [], rare: [], menu: null, windowHeight: 669, topStart: 200,
  bottomReserve: 32, keyboardOverlap: 0, tokens: tabletTokens, ...options,
});
const nav = [action('pas', 'nav'), action('daily', 'nav'), action('folder', 'nav'), action('feed', 'nav'), action('settings', 'settings')];
const sections = [action('items', 'view'), action('sessions', 'view'), action('notes', 'view')];
const back = action('back', 'exit');

test('바깥 세로 상세는 compact로 전부 보인다', () => {
  const result = layout({ exit: back, screen: sections, nav: nav.filter(x => x.id !== 'daily'), windowHeight: 678, topStart: 228, tokens: phoneTokens });
  expect(result.compact).toBe(true);
  expect(result.folded).toEqual([]);
  expect(result.screen.map(x => x.id)).toEqual(['items', 'sessions', 'notes']);
});

test('바깥 가로 루트는 전부 보이고 상세는 설정과 피드를 접는다', () => {
  const common = { nav: nav.filter(x => x.id !== 'daily'), windowHeight: 466, topStart: 114, bottomReserve: 24, tokens: phoneTokens };
  expect(layout({ ...common, screen: [action('add'), action('done')] }).folded).toEqual([]);
  const detail = layout({ ...common, exit: back, screen: sections });
  expect(detail.folded.map(x => x.id)).toEqual(['feed', 'settings']);
  expect(detail.screen.map(x => x.id)).toEqual(['more', 'items', 'sessions', 'notes']);
});

test('안쪽 메인은 높이에 따라 regular 또는 compact를 고른다', () => {
  const controls = [action('add'), action('done'), action('expand'), action('search')];
  const navigation = [action('pas', 'nav'), action('drawer', 'nav'), action('settings', 'settings')];
  expect(layout({ screen: controls, nav: navigation }).compact).toBe(false);
  const project = layout({ screen: [...controls, action('view', 'view')], nav: navigation });
  expect(project.compact).toBe(true);
  expect(project.folded).toEqual([]);
  const keyboard = layout({ screen: controls, nav: navigation, keyboardOverlap: 295 });
  expect(keyboard.compact).toBe(false);
  expect(keyboard.nav).toEqual([]);
  expect(keyboard.folded.map(x => x.id)).toEqual(['add', 'done']);
});

test('안쪽 PAS 자판에서 사용량과 카드 목록을 접고 보고는 남긴다', () => {
  const result = layout({ exit: action('home', 'exit'), menu: action('pas-menu', 'menu'),
    rare: [action('brightness', 'rare'), action('pas-settings', 'rare')],
    screen: [action('usage', 'status'), action('cards', 'view'), action('reports', 'view', { badgeCount: 3 })], keyboardOverlap: 295 });
  expect(result.folded.map(x => x.id)).toEqual(['usage', 'cards']);
  expect(result.screen.map(x => x.id)).toEqual(['pas-menu', 'reports']);
});

// 시안 screens.md의 필요/가용 높이를 실제 캡슐 높이 계약과 함께 고정한다.
import { railCapsuleHeight } from '../../components/navigation/RailCapsule';
const mainControls = ['add', 'done', 'expand', 'search'].map(id => action(id));
const mainNav = [action('pas', 'nav'), action('drawer', 'nav'), action('settings', 'settings')];
const pasOptions = { exit: action('home', 'exit'), menu: action('pas-menu', 'menu'),
  rare: [action('appearance', 'rare'), action('pas-settings', 'rare')],
  screen: [action('usage', 'status'), action('cards', 'view'), action('reports', 'view', { badgeCount: 3 })] };
test.each([
  ['바깥 세로 상세', { exit: back, screen: sections, nav: nav.filter(x => x.id !== 'daily'), windowHeight: 678, topStart: 228, tokens: phoneTokens }, 316, 366],
  ['바깥 가로 루트', { screen: [action('add'), action('done')], nav: nav.filter(x => x.id !== 'daily'), windowHeight: 466, topStart: 114, bottomReserve: 24, tokens: phoneTokens }, 272, 328],
  ['바깥 가로 상세 접힘', { exit: back, screen: sections, nav: nav.filter(x => x.id !== 'daily'), windowHeight: 466, topStart: 114, bottomReserve: 24, tokens: phoneTokens }, 272, 276],
  ['안쪽 가로 데일리', { screen: mainControls, nav: mainNav }, 396, 437],
  ['안쪽 가로 프로젝트', { screen: [...mainControls, action('view', 'view')], nav: mainNav }, 392, 437],
  ['안쪽 가로 데일리 자판', { screen: mainControls, nav: mainNav, keyboardOverlap: 295 }, 168, 174],
  ['안쪽 가로 PAS 자판', { ...pasOptions, keyboardOverlap: 295 }, 116, 118],
  ['안쪽 세로 PAS', { ...pasOptions, windowHeight: 951, topStart: 86 }, 220, 777],
] as Array<[string, Partial<Parameters<typeof duoRailLayout>[0]>, number, number]>)('%s 높이', (_name, options, need, available) => {
  const result = layout(options);
  const tokens = options.tokens ?? tabletTokens;
  const gap = result.compact ? tokens.uiSpacingXs : tokens.uiSpacingSm;
  expect(railCapsuleHeight(result.screen.length, result.compact, tokens)
    + (result.screen.length && result.nav.length ? gap : 0)
    + railCapsuleHeight(result.nav.length, result.compact, tokens)).toBe(need);
  expect((options.windowHeight ?? 669) - Math.max(options.bottomReserve ?? 32, options.keyboardOverlap ?? 0)
    - (options.topStart ?? 200) - (result.exit ? 48 + gap : 0)).toBe(available);
});
