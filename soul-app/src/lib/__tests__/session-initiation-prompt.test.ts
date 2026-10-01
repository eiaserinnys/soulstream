import { buildSessionInitiationPrompt } from '../session-initiation-prompt';

test('초기 지시가 비면 다음 지시를 기다리는 고정 프롬프트를 사용한다', () => {
  expect(buildSessionInitiationPrompt('  \n ')).toBe(
    '업무 현황을 파악한 후, 사용자의 다음 지시를 대기해주세요.',
  );
});

test('초기 지시가 있으면 trim한 본문을 이행 프롬프트 뒤에 붙인다', () => {
  expect(buildSessionInitiationPrompt('  첫 현황을 요약해줘.\n  ')).toBe(
    '업무 현황을 파악한 후, 사용자의 다음 지시를 이행해주세요.\n첫 현황을 요약해줘.',
  );
});
