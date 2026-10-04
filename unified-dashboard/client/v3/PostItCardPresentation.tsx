import type {CSSProperties, HTMLAttributes, ReactNode, Ref} from 'react';
import {CARD_COLORS, type CardColor} from '@seosoyoung/soul-ui/cards/card-types';

export type PostItVariant='default'|'compact';
export type PostItActivity={kind:'instruction'|'report';text:string};
export function postItRotation(id:string):number {
 return ((id.split('').reduce((sum,char)=>sum+char.charCodeAt(0),0)%5)-2)*0.4;
}
export function postItScale(fontSize:number):CSSProperties {
 return {'--postit-scale':fontSize/17,'--postit-font-size':`${fontSize}px`} as CSSProperties;
}
export function PostItGrid({children,className='',variant='default',fontSize,...props}:HTMLAttributes<HTMLDivElement>&{variant?:PostItVariant;fontSize:number;ref?:Ref<HTMLDivElement>}) {
 return <div {...props} className={`v3-postit-grid${variant==='compact'?' v3-postit-grid--compact':''} ${className}`} style={postItScale(fontSize)}>{children}</div>;
}

/** Shared paper presentation. The owner supplies preferences, navigation and status. */
export function PostItCardView({id,title,status,color,fontSize,activity,assigneeName,avatar,statusContent,
 onOpen,error,variant='default',readOnly=false,showStatus=true,supplement,...props}:Omit<HTMLAttributes<HTMLElement>,'id'|'title'>&{
 id:string;title:string;status:string;color?:CardColor;fontSize:number;activity:PostItActivity|null;assigneeName:string;
 avatar?:ReactNode;statusContent?:ReactNode;
 onOpen?:()=>void;error?:string;variant?:PostItVariant;readOnly?:boolean;showStatus?:boolean;supplement?:string;
}) {
 const resolvedColor=color??'yellow';
 const text=<>
  <span className="v3-postit-title" title={title}>{title}</span>
  <span className={`v3-postit-body${activity?'':' v3-postit-empty'}`}>{activity?.text??'아직 지시나 보고가 없습니다'}</span>
 </>;
 return <article {...props} className={`v3-postit-card${variant==='compact'?' v3-postit-card--compact':''}`}
  data-card-id={id} data-card-size={variant} data-card-status={status} data-card-color={resolvedColor} data-card-readonly={readOnly||undefined}
  style={{...postItScale(fontSize),'--postit-paper':CARD_COLORS[resolvedColor].hex,'--postit-rotation':`${postItRotation(id)}deg`} as CSSProperties}>
  {readOnly?<div className="v3-postit-open">{text}</div>:<button type="button" className="v3-postit-open" aria-label={`카드 ${title} 열기`} onClick={onOpen}>{text}</button>}
  <div className="v3-postit-footer" onClick={readOnly?undefined:onOpen}>
   <span className="v3-postit-assignee">{readOnly?<span aria-hidden="true">·</span>:avatar}<span title={assigneeName}>{assigneeName}</span></span>
   {!readOnly&&showStatus?statusContent:null}
   {supplement?<span className="v3-postit-supplement">{supplement}</span>:null}
  </div>
  {error?<span className="v3-postit-error" role="alert">{error}</span>:null}
 </article>;
}
