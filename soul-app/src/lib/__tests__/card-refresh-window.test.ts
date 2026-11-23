import {
  CARD_REFRESH_MAX_WAIT_MS,
  CARD_REFRESH_WINDOW_MS,
  cancelCardRefresh,
  createCardRefreshWindow,
  scheduleCardRefresh,
} from '../card-refresh-window';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test('혼자 온 갱신은 창이 끝날 때 한 번 조회한다', () => {
  const window = createCardRefreshWindow();
  const refresh = jest.fn();
  scheduleCardRefresh(window, refresh, 0);

  jest.advanceTimersByTime(CARD_REFRESH_WINDOW_MS - 1);
  expect(refresh).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(window.startedAt).toBeNull();
});

test('이어지는 갱신은 마지막 사건 뒤 한 창으로 묶는다', () => {
  const window = createCardRefreshWindow();
  const refresh = jest.fn();
  scheduleCardRefresh(window, refresh, 0);
  scheduleCardRefresh(window, refresh, 300);

  jest.advanceTimersByTime(499);
  expect(refresh).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('갱신이 계속 와도 창을 연 뒤 최대 대기 상한에서 한 번 조회한다', () => {
  const window = createCardRefreshWindow();
  const refresh = jest.fn();
  for (let now = 0; now <= CARD_REFRESH_MAX_WAIT_MS; now += 200) {
    scheduleCardRefresh(window, refresh, now);
    jest.advanceTimersByTime(200);
  }
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('취소하면 예약한 조회를 보내지 않는다', () => {
  const window = createCardRefreshWindow();
  const refresh = jest.fn();
  scheduleCardRefresh(window, refresh, 0);
  cancelCardRefresh(window);

  jest.advanceTimersByTime(CARD_REFRESH_MAX_WAIT_MS * 2);
  expect(refresh).not.toHaveBeenCalled();
});
