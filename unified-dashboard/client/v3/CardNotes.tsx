import { useTranslation } from "react-i18next";
import { useState } from "react";
import { MarkdownContent, ProfileAvatar } from "@seosoyoung/soul-ui";
import type { CardComment, CardLinkedSession } from "@seosoyoung/soul-ui/cards/card-types";
import { formatTime } from "./CardCheckItemRow";
import "./v3-card-check-items.css";

export function CardNotes({brief,notes,sessions=[],portraitUrl,userPortraitUrl,onImageClick}: {
 brief?:string|null;notes?:readonly CardComment[]|null;sessions?:readonly CardLinkedSession[];
 portraitUrl?:string|null;userPortraitUrl?:string|null;onImageClick?(src:string,alt:string):void;
}) {
 const {t,i18n}=useTranslation();
 const [expanded,setExpanded]=useState(false);
 const allNotes=notes??[];
 const older=allNotes.slice(0,Math.max(0,allNotes.length-5));
 const recent=allNotes.slice(-5);
 const visible=expanded?allNotes:recent;
 return <div className="v3-card-notes" data-testid="card-notes">
  <section className="v3-card-note-brief">
   <h3>{t("cards.handoffSummary")}</h3>
   <div className="v3-card-note-frame">{brief?<MarkdownContent content={brief} codeBlockLayout="document" onImageClick={onImageClick}/>:<p className="v3-detail-empty">{t("cards.noHandoffSummary")}</p>}</div>
  </section>
  <section className="v3-card-notes-list" aria-label={t("cards.notes")}>
   <div className="v3-detail-section-head"><h3>{t("cards.notes")}</h3></div>
   {older.length&&!expanded?<button type="button" className="v3-card-note-more" onClick={()=>setExpanded(true)}>{t("cards.earlierNotesCount", {count:older.length})}</button>:null}
   {allNotes.length===0?<p className="v3-detail-empty">{t("cards.noNotes")}</p>:null}
   {visible.map(note=>{
    const linked=note.sessionId?sessions.find(session=>session.sessionId===note.sessionId):undefined;
    const author=note.authorKind==="agent"?(linked?.displayName||note.authorId):note.authorId||t("cards.user");
    const agent=note.authorKind==="agent",portrait=agent?portraitUrl:userPortraitUrl;
    return <div className="v3-card-note-row v3-card-note-frame" key={note.id} data-card-note-id={note.id} data-card-note-session={note.sessionId??undefined}>
     <ProfileAvatar role={agent?"assistant":"user"} hasPortrait={Boolean(portrait)} portraitUrl={portrait} fallbackEmoji={agent?"🤖":"👤"}/>
     <div className="v3-card-note-content"><div className="v3-card-note-header"><strong>{author}</strong><time dateTime={note.createdAt}>{formatTime(note.createdAt,i18n.language)}</time></div>
      <MarkdownContent content={note.body} onImageClick={onImageClick}/></div>
    </div>;
   })}
  </section>
 </div>;
}
