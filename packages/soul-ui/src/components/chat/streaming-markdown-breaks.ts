// 스트리밍 마크다운의 단일 줄바꿈 전처리 (카드 #1808).
//
// 완료 렌더는 remark-breaks가 문단 안의 단일 줄바꿈을 <br>로 바꾼다. words는
// CommonMark라 그 규칙이 없어서, 코드 펜스 밖의 줄 끝에 하드 브레이크 표시(공백 두 칸)를
// 붙여 같은 결과를 낸다. 코드 펜스 안의 글은 한 글자도 바꾸지 않는다.
// 빈 줄과 블록 경계(펜스 열기 직전)에는 붙이지 않는다. 블록을 끊는 줄바꿈은
// 문단 안의 줄바꿈이 아니라서 remark-breaks도 <br>을 만들지 않는다.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function applyStreamingHardBreaks(markdown: string): string {
  if (!markdown.includes("\n")) return markdown;
  const lines = markdown.split("\n");
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenceMatch = FENCE.exec(line);
    if (fence !== null) {
      if (fenceMatch !== null && fenceMatch[1]![0] === fence.char && fenceMatch[1]!.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch !== null) {
      fence = { char: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      continue;
    }
    const next = lines[index + 1];
    if (line.trim() === "" || next === undefined || next.trim() === "") continue;
    if (FENCE.test(next)) continue;
    lines[index] = line + "  ";
  }
  return lines.join("\n");
}
