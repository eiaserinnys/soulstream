import { segmentCardReportImages } from '../card-report-images';
import { parseStandaloneImageLine } from '../../../../packages/soul-ui/src/lib/standalone-image-line';

test.each([
  ['![첫 사진](/api/attachments/files?path=%2Ffirst.png)', { alt: '첫 사진', url: '/api/attachments/files?path=%2Ffirst.png' }],
  ['   ![둘째](https://images.test/second.png "원본")  ', { alt: '둘째', url: 'https://images.test/second.png' }],
  ['![빈 대체 텍스트](/image.png)', { alt: '빈 대체 텍스트', url: '/image.png' }],
  ['문장 안의 ![이미지](/image.png)', null],
  ['![참조 이미지][photo]', null],
  ['![프로토콜 상대 URL](//images.test/image.png)', { alt: '프로토콜 상대 URL', url: '//images.test/image.png' }],
  ['![상대 경로](images/image.png)', null],
  ['    ![코드 예시](/image.png)', null],
  ['<img src="/image.png">', null],
])('standalone image matcher: %s', (line, expected) => {
  expect(parseStandaloneImageLine(line)).toEqual(expected);
});

test('독립 이미지와 사이의 글을 순서대로 보존한다', () => {
  const segments = segmentCardReportImages('앞 문단\n\n![첫 사진](/first.png)\n\n사이 문단\n\n![둘째](https://other.test/second.png "설명")\n\n끝 문단');
  expect(segments).toEqual([
    { kind: 'markdown', markdown: '앞 문단\n' },
    { kind: 'image', alt: '첫 사진', url: '/first.png' },
    { kind: 'markdown', markdown: '\n사이 문단\n' },
    { kind: 'image', alt: '둘째', url: 'https://other.test/second.png' },
    { kind: 'markdown', markdown: '\n끝 문단' },
  ]);
});

test.each(['```', '~~~'])('코드 펜스 %s 안의 예시는 이미지로 추출하지 않는다', (fence) => {
  const example = `${fence}markdown\n![예시](/example.png)\n${fence}\n\n본문의 ![인라인](/inline.png)\n![참조][photo]\n\n![실제](/real.png)`;
  const segments = segmentCardReportImages(example);
  expect(segments.filter((part) => part.kind === 'image')).toEqual([{ kind: 'image', alt: '실제', url: '/real.png' }]);
  expect(segments[0].kind).toBe('markdown');
  expect((segments[0] as { markdown: string }).markdown.trimEnd()).toBe(example.slice(0, example.indexOf('![실제]')).trimEnd());
});
