import { type ReactNode } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { useCardMembership } from "./use-card-membership";
import { CardBoardWorkspace } from "./CardBoardWorkspace";
import { PostItCard } from "./PostItCard";
import { V3ErrorNotice } from "./V3ErrorNotice";

/** Membership comes from the permission-filtered list, never the today's feed. */
export function CardInboxBoard({actions,draftAction,createdIds=[]}:{actions?:ReactNode;draftAction?:ReactNode;createdIds?:readonly string[]}) {
  const {cards,loading,error,retry}=useCardMembership(undefined,createdIds);
  const notice=error?<V3ErrorNotice message="카드를 불러오지 못했습니다." detail={error}>
    <Button size="sm" variant="ghost" onClick={retry}>다시 불러오기</Button>
  </V3ErrorNotice>:null;
  if(loading)return notice??<p className="v3-card-board-empty" role="status">카드를 불러오는 중…</p>;
  return <>{notice}<CardBoardWorkspace title="전체 카드" actions={actions} draftAction={draftAction} cards={cards}
    renderCard={(card,handle,preview)=><PostItCard card={card} handle={handle} preview={preview} variant="compact"/>}/></>;
}
