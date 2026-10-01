import { createContext, useContext } from "react";
import type { CardStatus } from "@seosoyoung/soul-ui/cards/card-types";
export interface CardBoardTransitions {
  register(id:string,request:(status:CardStatus)=>void):()=>void;
  request(id:string,status:CardStatus):void;
}
export const CardBoardTransitionContext=createContext<CardBoardTransitions|null>(null);
export const useCardBoardTransitions=()=>useContext(CardBoardTransitionContext);
