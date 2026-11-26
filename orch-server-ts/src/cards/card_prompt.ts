export type CardPromptEntry = {
    id: string;
    folder_id: string;
    number: number | null;
    title: string;
};
export type CardPromptComment = { id?: string; createdAt: Date | string; body: string };
export type CardPromptInput = {
    cardId: string;
    folderId: string;
    title: string;
    folderName: string;
    request: string;
    brief: string;
    reason?: string | null;
    comments?: readonly CardPromptComment[];
    dependsOn?: readonly CardDependency[];
    running: readonly CardPromptEntry[];
};
export function buildCardPrompt(input: CardPromptInput): string {
    const runningCards = input.running
        .filter(c => c.folder_id === input.folderId && c.id !== input.cardId)
        .slice(0, 10);
    const running = runningCards.map(c => c.number === null ? c.title : `#${c.number} ${c.title}`).join("\n");
    const comments = input.comments?.map(comment => `- ${comment.createdAt instanceof Date ? comment.createdAt.toISOString() : comment.createdAt}${comment.id ? `\n  커멘트 ID: ${comment.id}` : ""}\n  ${comment.body}`).join("\n") ?? "";
    return `[카드 실행] 이 세션은 카드 ${input.cardId} 「${input.title}」(폴더 ${input.folderName})을 맡았다.

## 카드 도구를 쓸 때
판 충돌(카드의 판이 바뀌었다는 거절)이 나면 get_card로 card.version을 다시 읽고 한 번 더 부른다.

## 요청 원문
${input.request}${input.dependsOn?.map(card => `\n선행 카드: ${card.number === null ? card.id : `#${card.number}`} ${card.title}(${CARD_STATUS_LABELS[card.status]})`).join("") ?? ""}

## 인계 요약 (지금까지)
${input.brief || "(아직 없음)"}${comments ? `

## 커멘트
${comments}` : ""}${input.reason ? `

## 상태 변경 사유 (있을 때만)
${input.reason}` : ""}${runningCards.length ? `

## 같은 폴더에서 실행 중인 다른 카드
${running}` : ""}`;
}
import { CARD_STATUS_LABELS } from "@soulstream/wire-schema/card-status-labels";
import type { CardDependency } from "./card_dependencies.js";
