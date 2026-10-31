import {
  extractBlockquotePlainText,
  segmentMarkdownBlockquotes,
} from '../blockquoteCopyModel';

describe('segmentMarkdownBlockquotes', () => {
  test('인용이 없으면 기존 markdown을 단일 구간으로 보존한다', () => {
    expect(segmentMarkdownBlockquotes('일반 **본문**')).toEqual([
      { kind: 'markdown', markdown: '일반 **본문**' },
    ]);
  });

  test('여러 최상위 인용을 각각 독립 구간으로 분리한다', () => {
    expect(
      segmentMarkdownBlockquotes(
        [
          '앞 문단',
          '',
          '> **첫 인용**',
          '> [링크](https://example.com)',
          '',
          '중간 문단',
          '',
          '> 둘째 인용',
        ].join('\n'),
      ),
    ).toEqual([
      { kind: 'markdown', markdown: '앞 문단\n' },
      {
        kind: 'blockquote',
        markdown: '> **첫 인용**\n> [링크](https://example.com)',
        plainText: '첫 인용\n링크',
      },
      { kind: 'markdown', markdown: '\n중간 문단\n' },
      {
        kind: 'blockquote',
        markdown: '> 둘째 인용',
        plainText: '둘째 인용',
      },
    ]);
  });

  test('중첩 인용 marker는 렌더용 본문에 남기고 복사 문자열에서는 제거한다', () => {
    expect(
      segmentMarkdownBlockquotes('> 바깥\n>\n> > 안쪽'),
    ).toEqual([
      {
        kind: 'blockquote',
        markdown: '> 바깥\n>\n> > 안쪽',
        plainText: '바깥\n\n안쪽',
      },
    ]);
  });

  test('일반 fenced code 안의 > 문자를 인용으로 오인하지 않는다', () => {
    const markdown = ['```text', '> 인용 아님', '```'].join('\n');

    expect(segmentMarkdownBlockquotes(markdown)).toEqual([
      { kind: 'codeBlock', markdown, copyText: '> 인용 아님' },
    ]);
  });

  test('최상위 펜스 코드만 복사용 구간으로 분리하고 펜스와 여는 들여쓰기를 제거한다', () => {
    expect(segmentMarkdownBlockquotes([
      '앞 문단',
      '',
      '  ```ts',
      '  const answer = 42;',
      '    return answer;',
      '  ```',
      '',
      '뒤 문단',
    ].join('\n'))).toEqual([
      { kind: 'markdown', markdown: '앞 문단\n' },
      {
        kind: 'codeBlock',
        markdown: ['  ```ts', '  const answer = 42;', '    return answer;', '  ```'].join('\n'),
        copyText: ['const answer = 42;', '  return answer;'].join('\n'),
      },
      { kind: 'markdown', markdown: '\n뒤 문단' },
    ]);
  });

  test('물결 펜스와 닫히지 않은 코드 펜스를 분리한다', () => {
    expect(segmentMarkdownBlockquotes(['~~~', '한 줄', '~~~', '', '```js', 'const open = true;'].join('\n')))
      .toEqual([
        { kind: 'codeBlock', markdown: '~~~\n한 줄\n~~~', copyText: '한 줄' },
        { kind: 'markdown', markdown: '' },
        { kind: 'codeBlock', markdown: '```js\nconst open = true;', copyText: 'const open = true;' },
      ]);
  });

  test('info string에 백틱이 들어간 한 줄 인라인 코드는 펜스로 오판하지 않는다', () => {
    const markdown = '```inline```';
    expect(segmentMarkdownBlockquotes(markdown)).toEqual([
      { kind: 'markdown', markdown },
    ]);
  });

  test('번호 목록의 4칸 들여쓰기 펜스를 코드블록으로 분리한다', () => {
    const markdown = [
      '1. 안내',
      '',
      '    ```bash',
      '    pnpm test',
      '    ```',
      '    후속 설명',
    ].join('\n');

    expect(segmentMarkdownBlockquotes(markdown)).toEqual([
      { kind: 'markdown', markdown: '1. 안내\n' },
      {
        kind: 'codeBlock',
        markdown: ['    ```bash', '    pnpm test', '    ```'].join('\n'),
        copyText: 'pnpm test',
      },
      { kind: 'markdown', markdown: ' 후속 설명' },
    ]);
  });

  test('목록 문맥 밖 일반 4칸 들여쓰기 코드는 fenced codeBlock으로 분리하지 않는다', () => {
    const markdown = ['    console.log(1);', '    nextLine();'].join('\n');
    expect(segmentMarkdownBlockquotes(markdown)).toEqual([
      { kind: 'markdown', markdown },
    ]);
  });

  test('최상위 코드와 인용 내부 코드를 서로 다른 복사 구간으로 섞지 않는다', () => {
    expect(segmentMarkdownBlockquotes(['```', '> 인용 문장', '```', '', '> ```', '> 인용 코드', '> ```'].join('\n')))
      .toEqual([
        { kind: 'codeBlock', markdown: '```\n> 인용 문장\n```', copyText: '> 인용 문장' },
        { kind: 'markdown', markdown: '' },
        { kind: 'blockquote', markdown: '> ```\n> 인용 코드\n> ```', plainText: '인용 코드' },
      ]);
  });

  test('인용 안 fenced code와 목록을 같은 인용 구간에 보존한다', () => {
    const [segment] = segmentMarkdownBlockquotes(
      [
        '> ```text',
        '> *코드 장식은 그대로*',
        '> ```',
        '> - 목록 **본문**',
      ].join('\n'),
    );

    expect(segment).toEqual({
      kind: 'blockquote',
      markdown: [
        '> ```text',
        '> *코드 장식은 그대로*',
        '> ```',
        '> - 목록 **본문**',
      ].join('\n'),
      plainText: ['*코드 장식은 그대로*', '목록 본문'].join('\n'),
    });
  });
});

describe('extractBlockquotePlainText', () => {
  test('인용·강조·링크·목록·inline code 장식을 제거한다', () => {
    expect(
      extractBlockquotePlainText(
        [
          '> **굵게**와 _기울임_',
          '> - [링크](https://example.com)',
          '> - `snake_case`',
        ].join('\n'),
      ),
    ).toBe(['굵게와 기울임', '링크', 'snake_case'].join('\n'));
  });

  test('fenced code 본문과 줄바꿈은 그대로 복사한다', () => {
    expect(
      extractBlockquotePlainText(
        ['```ts', 'const value = \"**literal**\";', '```', '', '마지막'].join('\n'),
      ),
    ).toBe(['const value = \"**literal**\";', '', '마지막'].join('\n'));
  });

  test('잘못된 숫자 HTML entity가 있어도 메시지 렌더 경로를 깨뜨리지 않는다', () => {
    expect(extractBlockquotePlainText('> &#x110000;와 &#128512;'))
      .toBe('&#x110000;와 😀');
  });
});
