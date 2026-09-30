import { create } from "zustand";
import { cardRequest, cardPath, cardMutationKey, fetchCards } from "./card-api";
import type { CardDetail, CardRow } from "./card-types";
interface CardState {
  byId: Record<string, CardRow>; details: Record<string, CardDetail>; errors: Record<string, string>;
  folderIds: Record<string, string[]>;
  putCards(cards: readonly CardRow[]): void;
  loadFolder(folderId: string): Promise<void>;
  loadCard(id: string): Promise<CardDetail>;
  mutate(id: string, suffix: string, body: object, method?: string): Promise<CardDetail>;
  create(body: object): Promise<CardRow>;
  handleCardUpdated(event: {cardId: string; folderId: string}): Promise<CardDetail>;
  reset(): void;
}
export const useCardStore = create<CardState>((set,get) => ({
  byId: {}, details: {}, errors: {}, folderIds: {},
  putCards(cards) { set(s=>({byId:{...s.byId,...Object.fromEntries(cards.map(c=>[c.id,c]))}})); },
  async loadFolder(folderId) {
    const cards=await fetchCards(folderId); get().putCards(cards);
    set(s=>({folderIds:{...s.folderIds,[folderId]:cards.map(c=>c.id)}}));
  },
  async loadCard(id) {
    try {
      const detail=await cardRequest<CardDetail>(cardPath(id));
      set(s=>({byId:{...s.byId,[id]:detail.card},details:{...s.details,[id]:detail},errors:{...s.errors,[id]:""}}));
      return detail;
    } catch(error) {
      set(s=>({errors:{...s.errors,[id]:error instanceof Error ? error.message : String(error)}})); throw error;
    }
  },
  async mutate(id,suffix,body,method="POST") {
    await cardRequest(cardPath(id)+suffix,method,{...body,idempotencyKey:cardMutationKey()});
    return get().loadCard(id);
  },
  async create(body) {
    const result=await cardRequest<{card:CardRow}>("/api/cards","POST",body);
    get().putCards([result.card]);
    set(s=>({folderIds:{...s.folderIds,[result.card.folderId]:[...new Set([...(s.folderIds[result.card.folderId]??[]),result.card.id])]}}));
    return result.card;
  },
  async handleCardUpdated(event) {
    const detail=await get().loadCard(event.cardId);
    set(s=>({folderIds:Object.fromEntries(Object.entries(s.folderIds).map(([id,ids])=>[id,id===detail.card.folderId ? [...new Set([...ids,event.cardId])] : ids.filter(c=>c!==event.cardId)]))}));
    return detail;
  },
  reset(){set({byId:{},details:{},errors:{},folderIds:{}});},
}));
