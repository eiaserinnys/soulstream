import type { PersistentInstruction } from "../lib/persistent-sessions";
import {
  PersistentSessionInstructionsView,
  type PersistentSessionInstructionsActions,
  type PersistentSessionInstructionsViewState,
} from "../components/PersistentSessionInstructions";

const instructions: PersistentInstruction[] = [
  {
    id: "review-instruction-1",
    text: "먼저 근거를 확인하고, 모르는 내용은 짧게 물어봅니다.",
    source_turns: ["T195", "T210"],
    created_at: "2026-10-06T10:00:00.000Z",
    updated_at: "2026-10-06T11:00:00.000Z",
    origin: "user",
  },
  {
    id: "review-instruction-2",
    text: "구현 보고는 결론과 실제 검증 결과부터 씁니다.",
    source_turns: [],
    created_at: "2026-10-06T09:00:00.000Z",
    updated_at: "2026-10-06T10:30:00.000Z",
    origin: "user",
  },
];

const noActions: PersistentSessionInstructionsActions = {
  retry: () => undefined,
  startEditing: () => undefined,
  cancelEditing: () => undefined,
  changeEditText: () => undefined,
  saveEdit: () => undefined,
  remove: () => undefined,
  changeAddText: () => undefined,
  add: () => undefined,
  editKeyDown: () => undefined,
};

export function PersistentSessionInstructionsReviewSample() {
  return <div className="grid gap-4">
    <section aria-label="빈 목록">
      <h4 className="mb-2 text-sm font-medium">빈 목록</h4>
      <PersistentSessionInstructionsView state={state({ instructions: [] })} actions={noActions} />
    </section>
    <section aria-label="항목 여럿">
      <h4 className="mb-2 text-sm font-medium">항목 여럿</h4>
      <PersistentSessionInstructionsView state={state({ instructions })} actions={noActions} />
    </section>
    <section aria-label="편집 중">
      <h4 className="mb-2 text-sm font-medium">편집 중</h4>
      <PersistentSessionInstructionsView state={state({ instructions, editingId: instructions[0]!.id, editText: "현재 수정 중인 지시" })} actions={noActions} />
    </section>
    <section aria-label="상한 안내">
      <h4 className="mb-2 text-sm font-medium">상한 안내</h4>
      <PersistentSessionInstructionsView state={state({ instructions: instructions.slice(0, 1), capReached: true })} actions={noActions} />
    </section>
  </div>;
}

function state(overrides: Partial<PersistentSessionInstructionsViewState>): PersistentSessionInstructionsViewState {
  return {
    instructions: [],
    loading: false,
    loadError: null,
    error: null,
    capReached: false,
    pending: false,
    editingId: null,
    editText: "",
    addText: "",
    ...overrides,
  };
}
