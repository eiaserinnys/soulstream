export type CardPromptEntry = {
    title: string;
    folderName: string;
};
export type CardPromptComment = { id?: string; createdAt: Date | string; body: string };
export type CardPromptInput = {
    cardId: string;
    title: string;
    folderName: string;
    request: string;
    brief: string;
    reason?: string | null;
    comments?: readonly CardPromptComment[];
    running: readonly CardPromptEntry[];
};
export function buildCardPrompt(input: CardPromptInput): string {
    const running = input.running.map(c => `${c.title} (${c.folderName})`).join("\n") || "없음";
    const comments = input.comments?.map(comment => `- ${comment.createdAt instanceof Date ? comment.createdAt.toISOString() : comment.createdAt}${comment.id ? `\n  커멘트 ID: ${comment.id}` : ""}\n  ${comment.body}`).join("\n") ?? "";
    return `[카드 실행] 이 세션은 카드 ${input.cardId} 「${input.title}」(폴더 ${input.folderName})을 맡았다.

## 요청 원문
${input.request}

## 인계 요약 (지금까지)
${input.brief || "(아직 없음)"}
${comments ? `
## 커멘트
${comments}
` : ""}${input.reason ? `
## 상태 변경 사유 (있을 때만)
${input.reason}
` : ""}
## 지금 실행 중인 다른 카드 세션
${running}`;
}
