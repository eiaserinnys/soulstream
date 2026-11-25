import { useState, type ComponentProps } from "react";
import { CardWorkspace } from "../CardWorkspace";
import type { MobilePlannerTab } from "../mobile-planner-state";
import { useCardSessionPanel } from "./use-card-session-panel";

/**
 * 보고 창 위에 겹치는 카드 패널. 세션 칸의 스트림과 세션 조회까지 이 덩어리가 함께 들고 있어,
 * 패널이 열릴 때만 불러오고 닫히면 선택도 함께 사라진다. 처음 열 때 지연 로드한다(대화 화면으로 돌아오는 import 고리를 피하려고).
 */
export function PasCardPanel({ cardId, folders, ownSessionId, liveSessions, mobile, onClose }: {
  cardId: string; folders: ComponentProps<typeof CardWorkspace>["folders"]; ownSessionId: string | null; liveSessions: boolean; mobile: boolean; onClose(): void;
}) {
  const [tab, setTab] = useState<MobilePlannerTab>("today");
  const session = useCardSessionPanel({ cardId, ownSessionId, enabled: liveSessions });
  const { onOpenSession, ...workspace } = session.workspaceProps;
  return <CardWorkspace cardId={cardId} folders={folders} onClose={onClose} mobileMode={mobile} mobileTab={tab} onCloseChat={() => setTab("today")} {...workspace}
    onOpenSession={(summary, selection) => { onOpenSession(summary, selection); if (selection?.source !== "automatic" && mobile) setTab("chat"); }} />;
}
