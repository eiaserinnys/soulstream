import { normalizeMarkdownBreaks } from '../markdownBreaks';

describe('normalizeMarkdownBreaks', () => {
  test('case 1: single \\n → hard break', () => {
    expect(normalizeMarkdownBreaks('a\nb')).toBe('a  \nb');
  });

  test('case 2: paragraph break \\n\\n preserved', () => {
    expect(normalizeMarkdownBreaks('a\n\nb')).toBe('a\n\nb');
  });

  test('case 3: fenced code (```) interior preserved', () => {
    const input = '```\na\nb\n```';
    expect(normalizeMarkdownBreaks(input)).toBe(input);
  });

  test('case 4: fenced code with language preserved', () => {
    const input = '```ts\nlet x = 1\nlet y = 2\n```';
    expect(normalizeMarkdownBreaks(input)).toBe(input);
  });

  test('case 5: empty string → empty string', () => {
    expect(normalizeMarkdownBreaks('')).toBe('');
  });

  test('case 6: null/undefined passthrough', () => {
    expect(normalizeMarkdownBreaks(null)).toBeNull();
    expect(normalizeMarkdownBreaks(undefined)).toBeUndefined();
  });

  test('case 7: trailing single \\n preserved (EOF)', () => {
    expect(normalizeMarkdownBreaks('a\n')).toBe('a\n');
  });

  test('case 8: mixed paragraph + fenced + paragraph', () => {
    const input = 'a\nb\n\n```\nc\nd\n```\n\ne\nf';
    const expected = 'a  \nb\n\n```\nc\nd\n```\n\ne  \nf';
    expect(normalizeMarkdownBreaks(input)).toBe(expected);
  });

  test('case 9: idempotency — trailing 2-space already present', () => {
    expect(normalizeMarkdownBreaks('a  \nb')).toBe('a  \nb');
  });

  test('case 10: tilde-fenced code (~~~) preserved', () => {
    const input = '~~~\nfoo\nbar\n~~~';
    expect(normalizeMarkdownBreaks(input)).toBe(input);
  });
});
