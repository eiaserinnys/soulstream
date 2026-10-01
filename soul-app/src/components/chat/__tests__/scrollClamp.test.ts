import { clampScrollIfNeeded } from '../scrollClamp';

// F-H — fetch in-flight 시 사용자 viewport의 위쪽 한계를 frontier로 제한하는
// 순수 함수의 단위 검증. ChatBody 통합 mount 비용을 회피하고 핵심 분기만 검증
// (sseGate.ts 패턴과 동일).

describe('clampScrollIfNeeded (F-H)', () => {
  test('frontier가 null이면 no-op (clamp 미적용, false 반환)', () => {
    const scrollTo = jest.fn();
    const applied = clampScrollIfNeeded(500, null, scrollTo);
    expect(applied).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  test('현재 offset이 frontier 미만이면 no-op', () => {
    const scrollTo = jest.fn();
    expect(clampScrollIfNeeded(500, 600, scrollTo)).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  test('현재 offset이 frontier와 같으면 no-op (경계는 허용)', () => {
    const scrollTo = jest.fn();
    expect(clampScrollIfNeeded(600, 600, scrollTo)).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  test('현재 offset이 frontier 초과면 scrollToOffset(frontier) 호출 + true 반환', () => {
    const scrollTo = jest.fn();
    expect(clampScrollIfNeeded(700, 600, scrollTo)).toBe(true);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(600);
  });

  test('frontier=0에서 사용자가 위로 가면 0으로 clamp (sanity)', () => {
    // requestOlder는 frontier=0 케이스를 발화시키지 않지만 (사용자가 events 끝
    // 1 viewport 전에 도달해야 onEndReached 트리거), 순수 함수의 정의상
    // frontier=0이라도 동등하게 clamp되어야 한다.
    const scrollTo = jest.fn();
    expect(clampScrollIfNeeded(50, 0, scrollTo)).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith(0);
  });
});
