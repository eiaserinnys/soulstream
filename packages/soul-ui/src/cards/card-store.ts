import {executeCard,resetCardExecutions,type CardExecutionResult} from "./card-execution";
import { create } from "zustand";
import { cardRequest, cardPath, cardMutationKey, confirmCardItem, fetchCards } from "./card-api";
import type { CardComment, CardDetail, CardRow } from "./card-types";
let globalLists=0;
const pendingListUpdates=new Map<string,number>();
const staleCards=new Map<string,number>();
let updateSequence=0;
let observedReplay=0;
let rowClock=0;
const rowSequences=new Map<string,number>();
let globalMembership:{ids:Set<string>;scopeRevision:number}|null=null;
const markRow=(id:string)=>{rowSequences.set(id,++rowClock);};
interface CardState {
  byId: Record<string, CardRow>; details: Record<string, CardDetail>; errors: Record<string, string>;
  pendingItemConfirmations: Record<string, Record<number, boolean>>;
  folderIds: Record<string, string[]>;
  localRevision: number;
  putCards(cards: readonly CardRow[], startedAt?: number): void;
  getRowSequence(): number;
  markLocalChange(cardId?: string): void;
  loadFolder(folderId: string): Promise<void>;
  loadCard(id: string): Promise<CardDetail>;
  mutate(id: string, suffix: string, body: object, method?: string): Promise<CardDetail>;
  execute(id:string,version:number):Promise<CardExecutionResult>;
  confirmItem(id:string,itemId:number,confirmed:boolean):Promise<CardRow>;
  addComment(id: string, body: string, idempotencyKey: string, itemId?:number, questionId?: string): Promise<CardComment>;
  create(body: object): Promise<CardRow>;
  handleCardUpdated(event: {cardId: string; folderId: string}): Promise<CardDetail | undefined>;
  registerGlobalList(): () => void;
  reconcileGlobalList(cards: readonly CardRow[], scopeRevision?: number): void;
  isCardCurrent(id: string): boolean;
  isCardInSyncedGlobalList(id: string, scopeRevision: number): boolean;
  observeReplay(revision: number): void;
  reset(): void;
}
export const useCardStore = create<CardState>((set,get) => ({
  byId: {}, details: {}, errors: {}, pendingItemConfirmations:{}, folderIds: {}, localRevision: 0,
  // 늦게 도착한 오래된 목록이 이미 최신인 행을 과거 상태로 되돌리지 않게 버전을 본다.
  putCards(cards,startedAt) { set(s=>{
    let byId=s.byId,details=s.details;
    for(const card of cards){
      const current=byId[card.id];
      if(current!==undefined&&current.version>card.version)continue;
      if(current&&startedAt!==undefined&&(rowSequences.get(card.id)??0)>startedAt&&current.version>=card.version)continue;
      if(current!==card){if(byId===s.byId)byId={...byId};byId[card.id]=card;}
      const detail=details[card.id];
      if(detail!==undefined&&detail.card.version<=card.version&&detail.card!==card)
        {if(details===s.details)details={...details};details[card.id]={...detail,card};}
    }
    return byId===s.byId&&details===s.details?s:{byId,details};
  }); },
  getRowSequence(){return rowClock;},
  markLocalChange(cardId){if(cardId)markRow(cardId);globalMembership=null;set(s=>({localRevision:s.localRevision+1}));},
  async loadFolder(folderId) {
    const cards=await fetchCards(folderId); get().putCards(cards);
    set(s=>({folderIds:{...s.folderIds,[folderId]:cards.map(c=>c.id)}}));
  },
  async loadCard(id) {
    try {
      const detail=await cardRequest<CardDetail>(cardPath(id));
      const currentCard=get().byId[id],currentDetail=get().details[id];
      if(currentCard&&currentCard.version>detail.card.version) {
        const latestDetail=currentDetail?.card===currentCard?currentDetail:{...(currentDetail??detail),card:currentCard};
        if(!currentDetail)set(s=>({details:{...s.details,[id]:latestDetail},errors:{...s.errors,[id]:""}}));
        return latestDetail;
      }
      markRow(id);
      set(s=>({byId:{...s.byId,[id]:detail.card},details:{...s.details,[id]:detail},errors:{...s.errors,[id]:""}}));
      return detail;
    } catch(error) {
      set(s=>({errors:{...s.errors,[id]:error instanceof Error ? error.message : String(error)}})); throw error;
    }
  },
  async mutate(id,suffix,body,method="POST") {
    try {
      await cardRequest(cardPath(id)+suffix,method,{...body,idempotencyKey:cardMutationKey()});
      const detail=await get().loadCard(id);
      get().markLocalChange();
      return detail;
    } catch(error) {
      set(state=>({errors:{...state.errors,[id]:error instanceof Error ? error.message : String(error)}}));
      throw error;
    }
  },
  async execute(id,version){
    const result=await executeCard(id,version,result=>set(state=>{
      if((state.byId[id]?.version??0)>result.card.version)return state;
      markRow(id);
      return {byId:{...state.byId,[id]:result.card},details:state.details[id]?{...state.details,[id]:{...state.details[id],card:result.card}}:state.details};
    }));
    get().markLocalChange();
    return result;
  },
  async confirmItem(id,itemId,confirmed) {
    set(state=>({pendingItemConfirmations:{...state.pendingItemConfirmations,[id]:{...state.pendingItemConfirmations[id],[itemId]:confirmed}},errors:{...state.errors,[id]:""}}));
    try {
      const {card}=await confirmCardItem(id,itemId,confirmed);
      set(state=>{
        const pendingForCard={...state.pendingItemConfirmations[id]};delete pendingForCard[itemId];
        const pendingItemConfirmations={...state.pendingItemConfirmations};
        if(Object.keys(pendingForCard).length)pendingItemConfirmations[id]=pendingForCard;else delete pendingItemConfirmations[id];
        const currentCard=(state.byId[id]?.version??0)>card.version?state.byId[id]:card;
        if(currentCard!==state.byId[id])markRow(id);
        return {byId:{...state.byId,[id]:currentCard},details:state.details[id]?{...state.details,[id]:{...state.details[id],card:currentCard}}:state.details,pendingItemConfirmations,errors:{...state.errors,[id]:""}};
      });
      get().markLocalChange();
      return card;
    } catch(error) {
      set(state=>{
        const pendingForCard={...state.pendingItemConfirmations[id]};delete pendingForCard[itemId];
        const pendingItemConfirmations={...state.pendingItemConfirmations};
        if(Object.keys(pendingForCard).length)pendingItemConfirmations[id]=pendingForCard;else delete pendingItemConfirmations[id];
        return {pendingItemConfirmations,errors:{...state.errors,[id]:error instanceof Error?error.message:String(error)}};
      });
      throw error;
    }
  },
  async addComment(id, body, idempotencyKey, itemId, questionId) {
    const optimistic: CardComment = {id:idempotencyKey,cardId:id,authorKind:"user",authorId:"",sessionId:null,kind:"comment",...(itemId===undefined?{}:{itemId}),...(questionId===undefined?{}:{questionId}),body,createdAt:new Date().toISOString()};
    const patch = (comment: CardComment | null) => set(state => {
      const detail = state.details[id];
      if (!detail) return {};
      const comments = (detail.comments ?? []).filter(item => item.id !== idempotencyKey && item.id !== comment?.id);
      return {details:{...state.details,[id]:{...detail,comments:comment ? [...comments,comment] : comments}}};
    });
    patch(optimistic);
    try {
      const comment = await cardRequest<CardComment>(cardPath(id)+"/comments","POST",{body,idempotencyKey,...(itemId===undefined?{}:{itemId}),...(questionId===undefined?{}:{questionId})});
      patch(comment);
      set(state => ({errors:{...state.errors,[id]:""}}));
      if(itemId!==undefined)try{await get().loadCard(id);}catch{/* loadCard keeps the saved comment and exposes its refresh error */}
      get().markLocalChange();
      return comment;
    } catch (error) {
      patch(null);
      set(state => ({errors:{...state.errors,[id]:error instanceof Error ? error.message : String(error)}}));
      throw error;
    }
  },
  async create(body) {
    const result=await cardRequest<{card:CardRow}>("/api/cards","POST",body);
    get().putCards([result.card]);
    set(s=>({folderIds:{...s.folderIds,[result.card.folderId]:[...new Set([...(s.folderIds[result.card.folderId]??[]),result.card.id])]}}));
    get().markLocalChange(result.card.id);
    return result.card;
  },
  async handleCardUpdated(event) {
    const revision=++updateSequence;
    globalMembership=null;
    staleCards.set(event.cardId,revision);
    // Only a mounted global list can reconcile every affected card. Scoped
    // lists may omit a moved, completed or otherwise out-of-scope card.
    if(globalLists>0&&get().byId[event.cardId]&&!get().details[event.cardId]){
      pendingListUpdates.set(event.cardId,revision);return;
    }
    pendingListUpdates.delete(event.cardId);
    const detail=await get().loadCard(event.cardId);
    if(staleCards.get(event.cardId)===revision)staleCards.delete(event.cardId);
    set(s=>({folderIds:Object.fromEntries(Object.entries(s.folderIds).map(([id,ids])=>[id,id===detail.card.folderId ? [...new Set([...ids,event.cardId])] : ids.filter(c=>c!==event.cardId)]))}));
    return detail;
  },
  registerGlobalList(){
    globalLists++;
    return ()=>{if(--globalLists===0){globalMembership=null;get().reconcileGlobalList([]);}};
  },
  reconcileGlobalList(cards,scopeRevision){
    const ids=new Set(cards.map(card=>card.id));
    if(scopeRevision!==undefined)globalMembership={ids,scopeRevision};
    for(const id of ids)staleCards.delete(id);
    for(const [id,revision] of pendingListUpdates){
      pendingListUpdates.delete(id);
      if(ids.has(id)){if(staleCards.get(id)===revision)staleCards.delete(id);continue;}
      void get().loadCard(id).then(()=>{
        if(staleCards.get(id)===revision)staleCards.delete(id);
      }).catch(()=>undefined);
    }
  },
  isCardCurrent(id){return !staleCards.has(id);},
  isCardInSyncedGlobalList(id,scopeRevision){return globalLists>0&&globalMembership?.scopeRevision===scopeRevision&&globalMembership.ids.has(id)&&!staleCards.has(id);},
  observeReplay(revision){
    if(revision===observedReplay)return;
    observedReplay=revision;
    for(const id of Object.keys(get().byId))staleCards.set(id,++updateSequence);
  },
  reset(){resetCardExecutions();pendingListUpdates.clear();staleCards.clear();rowSequences.clear();rowClock=0;globalMembership=null;observedReplay=0;set({byId:{},details:{},errors:{},pendingItemConfirmations:{},folderIds:{},localRevision:0});},
}));
