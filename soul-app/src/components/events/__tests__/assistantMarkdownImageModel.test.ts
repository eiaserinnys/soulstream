import { parseAssistantMarkdownImages } from '../CopyableAssistantMarkdown';

const event8309 = [
  '링크만 붙였군요. 비교 이미지를 바로 보여드리겠습니다.',
  '',
  '기존 배치',
  '',
  '![기존 폰 배치](https://soulstream.eiaserinnys.me/api/attachments/files?nodeId=eiaserinnys&path=%2Fhome%2Feias%2Fmigration%2Fnetcup-core-bootstrap%2Fprod-state%2Fincoming%2F60668e34-f8b1-4e53-9a8e-c5ff304337e1%2F2026-10-08T15-42-19.069Z-pas247-preview-iphone-light-story-settings-0d5b93a9cf014a8d9a9c76a4d203d60e.png)',
  '',
  '변경 시안: ‘세션 스토리’ 버튼을 둘째 줄로 옮깁니다.',
  '',
  '![폰 변경 시안](https://soulstream.eiaserinnys.me/api/attachments/files?nodeId=eiaserinnys&path=%2Fhome%2Feias%2Fmigration%2Fnetcup-core-bootstrap%2Fprod-state%2Fincoming%2F60668e34-f8b1-4e53-9a8e-c5ff304337e1%2F2026-10-08T15-42-19.585Z-pas247-preview-iphone-light-story-settings-fe37869a1a9841dc92f8db2ff4186d61.png)',
].join('\n');

test('event 8309 keeps explanatory prose and both standalone images in source order', () => {
  expect(parseAssistantMarkdownImages(event8309)).toEqual([
    { kind: 'markdown', markdown: '링크만 붙였군요. 비교 이미지를 바로 보여드리겠습니다.\n\n기존 배치\n' },
    { kind: 'images', images: [{ alt: '기존 폰 배치', url: 'https://soulstream.eiaserinnys.me/api/attachments/files?nodeId=eiaserinnys&path=%2Fhome%2Feias%2Fmigration%2Fnetcup-core-bootstrap%2Fprod-state%2Fincoming%2F60668e34-f8b1-4e53-9a8e-c5ff304337e1%2F2026-10-08T15-42-19.069Z-pas247-preview-iphone-light-story-settings-0d5b93a9cf014a8d9a9c76a4d203d60e.png' }] },
    { kind: 'markdown', markdown: '\n변경 시안: ‘세션 스토리’ 버튼을 둘째 줄로 옮깁니다.\n' },
    { kind: 'images', images: [{ alt: '폰 변경 시안', url: 'https://soulstream.eiaserinnys.me/api/attachments/files?nodeId=eiaserinnys&path=%2Fhome%2Feias%2Fmigration%2Fnetcup-core-bootstrap%2Fprod-state%2Fincoming%2F60668e34-f8b1-4e53-9a8e-c5ff304337e1%2F2026-10-08T15-42-19.585Z-pas247-preview-iphone-light-story-settings-fe37869a1a9841dc92f8db2ff4186d61.png' }] },
  ]);
});

test('only adjacent standalone images form a gallery; fenced, inline, reference, HTML, and quoted images remain Markdown', () => {
  const markdown = [
    '![첫째](/one.png)',
    '![둘째](/two.png)',
    '',
    '```md',
    '![코드](/code.png)',
    '```',
    '문장 안의 ![인라인](/inline.png)',
    '![참조][image]',
    '[image]: /reference.png',
    '<img src="/html.png">',
    '> ![인용](/quote.png)',
  ].join('\n');

  expect(parseAssistantMarkdownImages(markdown)).toEqual([
    { kind: 'images', images: [{ alt: '첫째', url: '/one.png' }, { alt: '둘째', url: '/two.png' }] },
    { kind: 'markdown', markdown: '\n```md\n![코드](/code.png)\n```\n문장 안의 ![인라인](/inline.png)\n![참조][image]\n[image]: /reference.png\n<img src="/html.png">' },
    { kind: 'blockquote', markdown: '> ![인용](/quote.png)', plainText: '인용' },
  ]);
});
