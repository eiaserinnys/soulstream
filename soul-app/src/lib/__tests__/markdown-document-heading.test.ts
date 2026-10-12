import { removeOverlappingDocumentHeading } from '../markdown-document-heading';

test.each([
  ['같은 제목', '계획 문서', '# 계획 문서\n\n본문', '본문'],
  ['제목이 H1으로 시작', '계획 문서 v2', '# 계획 문서\n\n본문', '본문'],
  ['H1이 제목으로 시작', '계획', '# 계획 문서\n\n본문', '본문'],
  ['연속 공백 정규화', '계획   문서', '# 계획 문서\n\n본문', '본문'],
  ['관계없는 H1', '다른 제목', '# 계획 문서\n\n본문', '# 계획 문서\n\n본문'],
  ['H1 없음', '계획 문서', '본문\n다음 줄', '본문\n다음 줄'],
  ['H2는 유지', '계획 문서', '## 계획 문서\n\n본문', '## 계획 문서\n\n본문'],
  ['앞 빈 줄 뒤의 겹친 H1', '계획 문서', '\n\n# 계획 문서\n\n본문', '본문'],
  ['네 칸 들여쓴 코드 블록은 유지', 'Example', '    # Example\n\n본문', '    # Example\n\n본문'],
])('%s일 때 본문을 정리한다', (_name, title, body, expected) => {
  expect(removeOverlappingDocumentHeading(body, title)).toBe(expected);
});
