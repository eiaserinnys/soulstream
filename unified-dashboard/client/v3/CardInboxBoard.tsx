import { useState,type ReactNode } from "react";
import { Button, FrameLoading, FrameNotice } from "@seosoyoung/soul-ui";
import { useCardMembership } from "./use-card-membership";
import { CardBoardWorkspace } from "./CardBoardWorkspace";
import { PostItCard } from "./PostItCard";
import { V3ErrorNotice } from "./V3ErrorNotice";
import type { CardCompletionOption } from "./CardCompletionFilter";
import { useCompletedCards,type CompletedBrowser } from "./use-completed-cards";

/** Membership comes from the permission-filtered list, never the today's feed. */
export function CardInboxBoard({actions,draftAction,createdIds=[],completion:controlledCompletion,completed:controlledCompleted}:{actions?:ReactNode;draftAction?:ReactNode;createdIds?:readonly string[];completion?:CardCompletionOption;completed?:CompletedBrowser}) {
  const [includeCompleted,onChange]=useState(false);
  const completion=controlledCompletion??{includeCompleted,onChange};
  const localCompleted=useCompletedCards(undefined,completion.includeCompleted&&!controlledCompleted);
  const completed=controlledCompleted??localCompleted;
  const {cards,loading,error,retry}=useCardMembership(undefined,createdIds);
  const notice=error?<V3ErrorNotice message="카드를 불러오지 못했습니다." detail={error}>
    <Button size="sm" variant="ghost" onClick={retry}>다시 불러오기</Button>
  </V3ErrorNotice>:null;
  // 보일 카드가 없는 동안에는 로더와 실패 안내가 같은 자리(프레임 가운데)에 선다.
  const noCards=cards.length===0&&completed.cards.length===0;
  if(loading&&noCards)return notice?<FrameNotice>{notice}</FrameNotice>:<FrameLoading label="카드를 불러오는 중…"/>;
  if(error&&noCards)return <FrameNotice>{notice}</FrameNotice>;
  return <>{notice}<CardBoardWorkspace title="전체 카드" actions={actions} draftAction={draftAction} cards={[...cards,...completed.cards]} completion={completion} completed={completed}
    renderCard={card=><PostItCard card={card} variant="compact"/>}/></>;
}
