import { useTranslation } from "react-i18next";
import {cardExecutionPending,subscribeCardExecution} from "@seosoyoung/soul-ui/cards/card-execution";
import { useRef, useState, useSyncExternalStore } from "react";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardColor } from "../../../packages/wire-schema/src/card_colors";
import type { CardStatus } from "../../../packages/wire-schema/generated/typescript/index";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";

export function usePostItStatus(card: CardRow) {
  const {t}=useTranslation();
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const executing=useSyncExternalStore(subscribeCardExecution,()=>cardExecutionPending(card.id),()=>false);
  const change = async (latest: CardRow, status: CardStatus, reason?: string) => {
    if (lock.current) return;
    lock.current = true; setPending(true);
    try {
      if(status==="running")return await useCardStore.getState().execute(card.id,latest.version,t);
      return await useCardStore.getState().mutate(card.id, "/status", {status, expectedVersion: latest.version, ...(reason ? {reason} : {})},"POST",t);
    } finally {lock.current = false; setPending(false);}
  };
  const changeColor = async (latest: CardRow, color: CardColor) => {
    if (lock.current) return;
    lock.current = true; setPending(true);
    try {
      return await useCardStore.getState().mutate(card.id, "", {color, expectedVersion: latest.version}, "PATCH",t);
    } finally {lock.current = false; setPending(false);}
  };
  return {
    pending:pending||executing, change, changeColor, load: () => useCardStore.getState().loadCard(card.id,t),
    onComplete: () => {void change(useCardStore.getState().byId[card.id] ?? card, "done").catch(() => undefined);},
  };
}
