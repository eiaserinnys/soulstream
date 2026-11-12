import { cardQuestionOptionLabels } from "@soulstream/wire-schema/card-questions";

type QuestionState = { answer: string | null; withdrawn_at: Date | null };

/** Answer eligibility belongs to the question record, including after the card ends. */
export function cardQuestionState(question: QuestionState | undefined): "missing" | "open" | "answered" | "withdrawn" {
  if (!question) return "missing";
  if (question.withdrawn_at !== null) return "withdrawn";
  return question.answer === null ? "open" : "answered";
}

/** 답 입력 세 꼴. mode가 없으면 옛 REST/판 꼴이고, 저장된 label과 같을 때만 선택 답으로 읽는다. */
export type CardQuestionAnswerInput =
  | { questionId: string; mode: "choice"; option: string; answer?: string }
  | { questionId: string; mode: "text"; answer: string }
  | { questionId: string; answer: string };

export type ResolvedCardQuestionAnswer = { answer: string; selectedOption: string | null };

/**
 * 답 저장값을 정한다. 선택 답은 잠긴 질문 행의 label 목록으로 검증하고, 글 답은 목록을 보지 않는다.
 * Open 판정 밖(이미 닫힘·없음)에서는 저장되지 않으므로 선택지 검증을 생략한다.
 */
export function resolveCardQuestionAnswer(options: unknown, input: CardQuestionAnswerInput, validateChoice: boolean): ResolvedCardQuestionAnswer {
  if ("mode" in input) {
    if (input.mode === "text") return { answer: input.answer, selectedOption: null };
    const labels = cardQuestionOptionLabels(options) ?? [];
    if (validateChoice && !labels.includes(input.option))
      throw Object.assign(new Error("선택지에 없는 답입니다"), { statusCode: 422, code: "CARD_QUESTION_OPTION_INVALID" });
    return { answer: input.answer ?? input.option, selectedOption: input.option };
  }
  const labels = cardQuestionOptionLabels(options) ?? [];
  return labels.includes(input.answer)
    ? { answer: input.answer, selectedOption: input.answer }
    : { answer: input.answer, selectedOption: null };
}
