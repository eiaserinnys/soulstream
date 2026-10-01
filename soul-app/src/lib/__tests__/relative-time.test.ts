import { formatRelativeTime } from '../relative-time';

const NOW = Date.parse('2026-07-18T12:00:00.000Z');

test.each([
  ['2026-07-18T11:59:40.000Z', '방금 전'],
  ['2026-07-18T11:42:00.000Z', '18분 전'],
  ['2026-07-18T09:00:00.000Z', '3시간 전'],
  ['2026-07-16T12:00:00.000Z', '2일 전'],
  ['2026-07-18T12:05:00.000Z', '방금 전'],
] as const)('상대 시간 %s → %s', (iso, expected) => {
  expect(formatRelativeTime(iso, NOW)).toBe(expected);
});
