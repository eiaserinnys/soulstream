const TRUNCATION_SUFFIX = '\n[잘림]';

export function stripTruncationSuffix(text: string): string {
  return text.endsWith(TRUNCATION_SUFFIX)
    ? text.slice(0, -TRUNCATION_SUFFIX.length)
    : text;
}
