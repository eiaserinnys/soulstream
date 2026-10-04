import {cardExecutionPending,subscribeCardExecution} from "@seosoyoung/soul-ui/cards/card-execution";
import { useRef, useState, useSyncExternalStore } from "react";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardRow, CardStatus } from "@seosoyoung/soul-ui/cards/card-types";

/** Completion and the picker share one write lock, including within a render. */
export function usePostItStatus(card: CardRow) {
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const executing=useSyncExternalStore(subscribeCardExecution,()=>cardExecutionPending(card.id),()=>false);
  const change = async (latest: CardRow, status: CardStatus, reason?: string) => {
    if (lock.current) return;
    lock.current = true; setPending(true);
    try {
      if(status==="running")return await useCardStore.getState().execute(card.id,latest.version);
      return await useCardStore.getState().mutate(card.id, "/status", {status, expectedVersion: latest.version, ...(reason ? {reason} : {})});
    } finally {lock.current = false; setPending(false);}
  };
  return {
    pending:pending||executing, change, load: () => useCardStore.getState().loadCard(card.id),
    onComplete: () => {void change(useCardStore.getState().byId[card.id] ?? card, "done").catch(() => undefined);},
  };
}
