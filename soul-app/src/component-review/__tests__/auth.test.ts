import { checkReviewAuth } from '../auth';

test('검수 번들은 cookie로 인증 상태만 조회한다', async () => {
  const request = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ authenticated: true }) });
  expect(await checkReviewAuth(request)).toBe(true);
  expect(request).toHaveBeenCalledWith('/api/auth/status', {
    credentials: 'same-origin', cache: 'no-store',
  });
});

test.each([
  { ok: false, json: async () => ({ authenticated: true }) },
  { ok: true, json: async () => ({ authenticated: false }) },
  { ok: true, json: async () => ({}) },
])('인증하지 못하면 fixture를 mount하지 않는다', async (response) => {
  expect(await checkReviewAuth(jest.fn().mockResolvedValue(response))).toBe(false);
});

test('네트워크 실패도 mount하지 않는다', async () => {
  expect(await checkReviewAuth(jest.fn().mockRejectedValue(new Error('offline')))).toBe(false);
});
