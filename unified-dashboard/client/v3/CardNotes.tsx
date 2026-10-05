import { useState, type ReactNode } from "react";
import { MarkdownContent } from "@seosoyoung/soul-ui";
import { AssistantMessage } from "@seosoyoung/soul-ui/components/chat/AssistantMessage";
import { UserMessage } from "@seosoyoung/soul-ui/components/chat/UserMessage";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";
import type { CardComment, CardLinkedSession } from "@seosoyoung/soul-ui/cards/card-types";
import "./v3-card-check-items.css";

export function CardNotes({brief,notes,sessions=[],portraitUrl,userPortraitUrl,onImageClick}: {
 brief?:string|null;notes?:readonly CardComment[]|null;sessions?:readonly CardLinkedSession[];
 portraitUrl?:string|null;userPortraitUrl?:string|null;onImageClick?(src:string,alt:string):void;
}) {
 const [expanded,setExpanded]=useState(false);
 const allNotes=notes??[];
 const older=allNotes.slice(0,Math.max(0,allNotes.length-5));
 const recent=allNotes.slice(-5);
 const visible=expanded?allNotes:recent;
 return <div className="v3-card-notes" data-testid="card-notes">
  <section className="v3-card-note-brief">
   <h3>인계 요약</h3>
   {brief?<MarkdownContent content={brief} codeBlockLayout="document" onImageClick={onImageClick}/>:<p className="v3-detail-empty">인계 요약이 없습니다.</p>}
  </section>
  <section className="v3-card-notes-list" aria-label="노트">
   <div className="v3-detail-section-head"><h3>노트</h3><span>{allNotes.length}건</span></div>
   {older.length&&!expanded?<button type="button" className="v3-card-note-more" onClick={()=>setExpanded(true)}>앞선 노트 {older.length}건</button>:null}
   {allNotes.length===0?<p className="v3-detail-empty">아직 노트가 없습니다.</p>:null}
   {visible.map(note=>{
    const linked=note.sessionId?sessions.find(session=>session.sessionId===note.sessionId):undefined;
    const author=note.authorKind==="agent"?(linked?.displayName||note.authorId):note.authorId||"사용자";
    const role=note.authorKind==="agent"?"assistant":"user";
    const message:ChatMessage={id:note.id,treeNodeId:note.id,treeNodeType:"card",role,content:""};
    const header:ReactNode=<div className="v3-card-note-header"><strong>{author}</strong><time dateTime={note.createdAt}>{formatTime(note.createdAt)}</time></div>;
    const content=<MarkdownContent content={note.body} onImageClick={onImageClick}/>;
    return <div key={note.id} data-card-note-id={note.id} data-card-note-session={note.sessionId??undefined}>
     {note.authorKind==="agent"?<AssistantMessage msg={message} header={header} portraitUrl={portraitUrl}>{content}</AssistantMessage>
      :<UserMessage msg={message} header={header} portraitUrl={userPortraitUrl}>{content}</UserMessage>}
    </div>;
   })}
  </section>
 </div>;
}

function formatTime(value:string) {
 const date=new Date(value);
 return Number.isNaN(date.getTime())?"":date.toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"});
}
