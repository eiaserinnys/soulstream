import { appendCardAttachments, parseCardRequest } from '../card-attachments';

test('원문을 보존하고 파일명과 URL을 첨부 줄로 왕복한다', () => {
  const files = [
    { name: '그림 (최종).png', url: 'https://files.test/image.png?size=2' },
    { name: '설명.pdf', url: 'https://files.test/document.pdf' },
  ];
  const request = appendCardAttachments('  요청\n둘째 줄  ', files);
  expect(request).toBe('  요청\n둘째 줄  \n\n첨부: 그림 (최종).png(https://files.test/image.png?size=2)\n첨부: 설명.pdf(https://files.test/document.pdf)');
  expect(parseCardRequest(request)).toEqual({ text: '  요청\n둘째 줄  ', attachments: [
    { ...files[0], image: true }, { ...files[1], image: false },
  ] });
  expect(appendCardAttachments('  원문  ', [])).toBe('  원문  ');
  expect(parseCardRequest('첨부: 아직 파일이 아닙니다')).toEqual({ text: '첨부: 아직 파일이 아닙니다', attachments: [] });
});

test('다운로드 URL은 path의 확장자로 이미지 여부를 판단한다', () => {
  const url = 'https://app.test/api/attachments/files?nodeId=node-1&path=%2Ftmp%2Fphoto.webp';
  expect(parseCardRequest(`첨부: 사진(${url})`).attachments[0]).toEqual({ name: '사진', url, image: true });
});

test('웹이 저장한 상대 URL 끝 첨부를 원문에서 분리한다', () => {
  const url = '/api/attachments/files?nodeId=n&path=%2Ftmp%2Fphoto.png';
  expect(parseCardRequest(`본문\n\n![사진](${url})`, 'https://cards.test')).toEqual({
    text: '본문', attachments: [{ name: '사진', url, image: true }],
  });
});


test('커멘트에 저장한 마크다운 이미지·파일 첨부를 빈 줄 사이에서도 읽는다', () => {
  expect(parseCardRequest('본문\n\n![사진](https://files.test/photo.png)\n\n[자료](https://files.test/file.pdf)')).toEqual({
    text: '본문', attachments: [
      { name: '사진', url: 'https://files.test/photo.png', image: true },
      { name: '자료', url: 'https://files.test/file.pdf', image: false },
    ],
  });
});
