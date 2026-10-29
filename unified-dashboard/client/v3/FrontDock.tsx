import type { ReactNode } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { CardHandoffView } from "./CardHandoffView";
import "./v3-card-board.css";
import "./v3-front-index.css";

export type FrontDockDestination = "card" | "pas" | "new";

const DESTINATION_LABELS: Record<FrontDockDestination, string> = { card: "이 카드", pas: "PAS", new: "새 세션" };
const PLACEHOLDERS: Record<FrontDockDestination, string> = { card: "커멘트", pas: "메시지", new: "새 세션에서 무엇을 할까요" };
const SEND_LABELS: Record<FrontDockDestination, string> = { card: "커멘트 남기기", pas: "보내기", new: "세션 시작" };

/**
 * 화면 아래에 늘 떠 있는 대화창. 입력은 세션 시작 입력창(CardHandoffView)을 그대로 쓰고,
 * 보낼 곳만 화면에 따라 바뀐다. 보낼 곳을 바꿔도 입력 글은 그대로다.
 */
export function FrontDock({ destinations, value, onChange, text, onChangeText, onSend, pasName, cardLabel, folderLabel, executionLabel }: {
  destinations: readonly FrontDockDestination[];
  value: FrontDockDestination;
  onChange(value: FrontDockDestination): void;
  text: string;
  onChangeText(text: string): void;
  onSend(): void;
  /** PAS로 보낼 때 받는 이. 칩 하나로 보인다. */
  pasName: string;
  /** 「이 카드」로 보낼 때의 카드(번호와 제목). 칩 하나로 보인다. */
  cardLabel?: string;
  folderLabel: string;
  executionLabel: ReactNode;
}) {
  const toggle = <div className="v3-completed-periods fi-dock-toggle" role="group" aria-label="보낼 곳">
    {destinations.map(destination => <Button key={destination} size="sm" variant="ghost" aria-pressed={value === destination}
      onClick={() => onChange(destination)}>{DESTINATION_LABELS[destination]}</Button>)}
  </div>;
  // 칩 줄은 늘 「어디로 가는가」를 보이는 자리다. 새 세션은 고르는 칩 둘, PAS와 이 카드는 고정된 칩 하나.
  const fixedChip = (label: string) => <span className="v3-card-handoff-chip v3-card-handoff-folder control-surface rounded-full fi-dock-chip" title={label}>
    <span>{label}</span>
  </span>;
  const target = value === "pas" ? fixedChip(pasName) : value === "card" ? (cardLabel ? fixedChip(cardLabel) : false) : undefined;
  return <div className="fi-dock" data-testid="front-dock" data-destination={value}>
    <div className="fi-dock-inner">
      <CardHandoffView
        composer={{
          text, onChangeText, onSend,
          placeholder: PLACEHOLDERS[value], inputLabel: PLACEHOLDERS[value], label: SEND_LABELS[value],
          disabled: !text.trim(), pending: false, files: [], onRemoveFile: () => undefined,
        }}
        leading={toggle} target={target}
        folderLabel={folderLabel} executionLabel={executionLabel}
        folderOpen={false} onFolderOpenChange={() => undefined}
        executionOpen={false} onExecutionOpenChange={() => undefined}
        folderPicker={null} executionPicker={null}
      />
    </div>
  </div>;
}
