export type CardPromptEntry = {
    title: string;
    folderName: string;
};
export type CardPromptComment = { createdAt: Date | string; body: string };
export type CardPromptInput = {
    cardId: string;
    title: string;
    folderName: string;
    request: string;
    brief: string;
    reason?: string | null;
    comments?: readonly CardPromptComment[];
    running: readonly CardPromptEntry[];
    queued: readonly CardPromptEntry[];
};
export function buildCardPrompt(input: CardPromptInput): string {
    const running = input.running.map(c => `${c.title} (${c.folderName})`).join("\n") || "없음";
    const queued = input.queued.map((c, i) => `${i + 1}. ${c.title} (${c.folderName})`).join("\n") || "없음";
    const comments = input.comments?.map(comment => `- ${comment.createdAt instanceof Date ? comment.createdAt.toISOString() : comment.createdAt}\n  ${comment.body}`).join("\n") ?? "";
    return `[카드 실행] 이 세션은 카드 ${input.cardId} 「${input.title}」(폴더 ${input.folderName})을 맡았다.

## 요청 원문
${input.request}

## 해석과 경과 (지금까지)
${input.brief || "(아직 없음)"}
${comments ? `
## 커멘트
${comments}
` : ""}${input.reason ? `
## 상태 변경 사유 (있을 때만)
${input.reason}
` : ""}
## 지금 실행 중인 다른 카드 세션
${running}

## 대기열
${queued}

## 카드 규칙
1. 착수 전에 위 목록을 보고 같은 리포나 파일을 만질 작업이 겹치면 ask_card_question으로 멈춘다.
2. 작업 중 해석과 경과를 update_card_brief로 갱신한다. brief도 한 문장 + 불릿.
3. 끝나면 add_card_report로 보고를 올린다. 보고는 디렉터용이다. 바쁜 상급자에게 보고하듯 쓴다: 첫 줄은 무엇을 하여 무엇이 됐는지 한 문장, 그 아래 불릿 3~5개는 각각 '~합니다'로 끝나는 짧은 완결 문장(된 것, 확인한 것, 자료 위치). 캡처·표·그림과 증거 링크(PR, SHA, URL)는 그 다음. 긴 설명은 접힘 블록으로. 그다음 request_card_review를 부른다.
4. 판단이 필요하면 ask_card_question으로 묻고 턴을 끝낸다. AskUserQuestion은 쓰지 않는다.
5. 상태 변경은 set_card_status로 직접 한다. 보고·미답 질문·사유·이전 상태·보관 여부는 전환을 막지 않는다. 완료·취소 카드도 다시 열 수 있다. running 기록은 프로세스 실행 승인이 아니다.
6. 위임 보고를 기다리며 턴을 끝내도 카드 작업은 계속 진행 중이다. 실제 작업을 마쳤을 때 보고를 올리고 검수를 요청한다.
7. 이 세션은 이 카드만 담당한다. 같은 카드의 후속 요청은 이 카드에서 처리하고, 새 업무는 assignee를 생략한 create_card로 새 카드를 만든다(brief에 인계). 바로 시작하려면 run=true, 순서를 기다려도 되면 queue=true를 준다.`;
}
