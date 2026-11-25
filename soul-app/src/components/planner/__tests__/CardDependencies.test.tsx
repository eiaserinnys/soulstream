jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import { fireEvent, render } from '@testing-library/react-native';
import type { CardDependency } from '../../../../../packages/wire-schema/src/card_dependency_display';
import { CardDependencies } from '../CardDependencies';

const dep = (overrides: Partial<CardDependency> = {}): CardDependency => ({
  id: 'dep-1', number: 12, title: '선행 카드', status: 'running', archived: false, met: false, ...overrides });
const shown = [
  dep({ id: 'a', number: 11, title: '끝난 선행', status: 'done', met: true }),
  dep({ id: 'b', number: 12, title: '진행 중 선행', status: 'running' }),
  dep({ id: 'c', number: 15, title: '취소된 선행', status: 'cancelled' }),
  dep({ id: 'd', number: 16, title: '보관된 선행', status: 'queued', archived: true }),
];

test('머리말 옆에 충족 수와 전체 수를 쓰고 행마다 번호, 제목, 상태 칩 라벨을 보인다', () => {
  const screen = render(<CardDependencies dependencies={shown} onOpenCard={() => {}} />);
  expect(screen.getByText('선행 카드')).toBeTruthy();
  expect(screen.getByTestId('card-dependencies-count').props.children).toBe('1/4');
  for (const text of ['#11', '끝난 선행', '완료', '#12', '진행 중 선행', '실행 중', '#15', '취소된 선행', '취소', '#16', '보관된 선행']) {
    expect(screen.getByText(text)).toBeTruthy();
  }
});

test('충족되지 않은 보관 선행은 대기가 아니라 보관됨 오류 톤 칩이고 그 행과 취소 행이 오류 테두리다', () => {
  const screen = render(<CardDependencies dependencies={shown} onOpenCard={() => {}} />);
  expect(screen.getByText('보관됨')).toBeTruthy();
  expect(screen.queryByText('대기')).toBeNull();
  const border = (id: string) => screen.getByTestId(`card-dependency-surface-${id}`).props.style.flat?.()
    .find((style: any) => style?.borderColor)?.borderColor;
  const normal = border('a');
  expect(border('b')).toBe(normal);
  expect(border('c')).not.toBe(normal);
  expect(border('d')).toBe(border('c'));
  // 보관됨 칩은 오류 톤이라 취소 칩(보조 톤)과 글자색이 다르다.
  expect(screen.getByText('보관됨').props.style.color).not.toBe(screen.getByText('취소').props.style.color);
});

test('한 줄 말줄임 제목과 눌러서 그 카드를 연다', () => {
  const onOpen = jest.fn();
  const screen = render(<CardDependencies dependencies={[dep({ title: '아주 긴 선행 카드 제목 '.repeat(8) })]} onOpenCard={onOpen} />);
  expect(screen.getByText(/아주 긴 선행/).props.numberOfLines).toBe(1);
  fireEvent.press(screen.getByTestId('card-dependency-dep-1'));
  expect(onOpen).toHaveBeenCalledWith('dep-1');
});

test('번호가 없는 선행은 제목만 쓰고 누름 영역은 44pt 이상이다', () => {
  const screen = render(<CardDependencies dependencies={[dep({ number: null, title: '번호 없는 선행' })]} onOpenCard={() => {}} />);
  expect(screen.getByText('번호 없는 선행')).toBeTruthy();
  expect(screen.queryByText(/^#/)).toBeNull();
  const frame = screen.getByTestId('card-dependency-dep-1').props.style;
  const flat = Array.isArray(frame) ? Object.assign({}, ...frame.flat(2).filter(Boolean)) : frame;
  expect(flat.minHeight).toBeGreaterThanOrEqual(44);
});
