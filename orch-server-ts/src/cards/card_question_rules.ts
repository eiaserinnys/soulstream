type QuestionState = { answer: string | null; withdrawn_at: Date | null };

/** Answer eligibility belongs to the question record, including after the card ends. */
export function cardQuestionState(question: QuestionState | undefined): "missing" | "open" | "answered" | "withdrawn" {
  if (!question) return "missing";
  if (question.withdrawn_at !== null) return "withdrawn";
  return question.answer === null ? "open" : "answered";
}
