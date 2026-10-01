import { renderHook, act } from '@testing-library/react-native';
import { useInputRequestTimer } from '../useInputRequestTimer';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('useInputRequestTimer', () => {
  test('receivedAt undefined → timeoutSec 그대로 반환, isExpired=false', () => {
    const { result } = renderHook(() => useInputRequestTimer(undefined, 300));
    expect(result.current.remainingSec).toBe(300);
    expect(result.current.isExpired).toBe(false);
  });

  test('남은 시간을 1초 간격으로 감소시킨다', () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);

    const { result } = renderHook(() => useInputRequestTimer(now, 5));
    expect(result.current.remainingSec).toBe(5);
    expect(result.current.isExpired).toBe(false);

    // 2초 경과
    (Date.now as jest.Mock).mockReturnValue(now + 2000);
    act(() => { jest.advanceTimersByTime(1000); });
    expect(result.current.remainingSec).toBe(3);
    expect(result.current.isExpired).toBe(false);
  });

  test('0 도달 시 isExpired=true, interval 정리', () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);

    const { result } = renderHook(() => useInputRequestTimer(now, 2));

    // 2초 경과 → 0
    (Date.now as jest.Mock).mockReturnValue(now + 2000);
    act(() => { jest.advanceTimersByTime(1000); });
    expect(result.current.remainingSec).toBe(0);
    expect(result.current.isExpired).toBe(true);

    // 추가 시간 경과해도 0 유지 (음수 안됨)
    (Date.now as jest.Mock).mockReturnValue(now + 5000);
    act(() => { jest.advanceTimersByTime(1000); });
    expect(result.current.remainingSec).toBe(0);
    expect(result.current.isExpired).toBe(true);
  });

  test('이미 만료된 시각이 전달되면 즉시 isExpired=true', () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);

    // 400초 전에 시작, timeoutSec=300 → 이미 100초 초과
    const { result } = renderHook(() => useInputRequestTimer(now - 400_000, 300));
    expect(result.current.remainingSec).toBe(0);
    expect(result.current.isExpired).toBe(true);
  });

  test('기본 timeoutSec은 300', () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);

    const { result } = renderHook(() => useInputRequestTimer(now));
    expect(result.current.remainingSec).toBe(300);
  });
});
