/**
 * normalizeMarkdownBreaks — 마크다운 단일 \n을 GFM hard break(`  \n`)로 변환.
 *
 * 배경: react-native-enriched-markdown@0.5.0이 MD_FLAG_HARD_SOFT_BREAKS를 JS로
 * 노출하지 않으므로, 컴포넌트 내부에서 렌더 직전 사전처리로 동등 효과를 낸다.
 * 원본 store/DB는 무변형 (정본 보존).
 *
 * 처리 범위:
 * - fenced code (```, ~~~) 내부 — 상태머신으로 변환 제외
 * - inline code (`...`) — 한 줄 안에 닫히므로 자동 제외
 * - indented code (4-space / tab) — v1 미처리 (CommonMark §4.4상 trailing space는
 *   코드 텍스트로 보존되어 블록 경계 인식 영향 없음; fenced code가 표준이라
 *   실사용 빈도 낮음)
 * - 후행 단일 \n (EOF 직전) — 변환 제외
 * - 멱등성 — 이미 trailing space 2개 이상인 줄은 추가 안 함
 */

const FENCE_RE = /^(?:`{3,}|~{3,})\s*[A-Za-z0-9_-]*\s*$/;

export function normalizeMarkdownBreaks(text: string): string;
export function normalizeMarkdownBreaks(text: null): null;
export function normalizeMarkdownBreaks(text: undefined): undefined;
export function normalizeMarkdownBreaks(
  text: string | null | undefined,
): string | null | undefined;
export function normalizeMarkdownBreaks(
  text: string | null | undefined,
): string | null | undefined {
  if (text == null) return text;
  if (text === '') return '';

  const lines = text.split('\n');
  let inFenced = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (FENCE_RE.test(trimmed)) {
      inFenced = !inFenced;
      continue;
    }

    if (inFenced) continue;

    // 단일 \n paragraph 내부: 다음 줄이 존재하며 비-공백을 포함해야 변환 대상
    const next = lines[i + 1];
    if (next == null) continue;
    if (next.trim() === '') continue;

    // 현재 줄이 빈 줄이거나 이미 trailing space 2개 이상이면 변환 안 함 (멱등성)
    if (line.trim() === '') continue;
    if (/ {2,}$/.test(line)) continue;

    lines[i] = line + '  ';
  }

  return lines.join('\n');
}
