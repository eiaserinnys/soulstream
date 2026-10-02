import {parse, type DefaultTreeAdapterTypes} from 'parse5';
import {marked} from 'marked';

type Activity = {body:string;format:'markdown'|'html'};
const omitted = new Set(['script','style','template','head']);
const blocks = new Set(['br','p','div','li','h1','h2','h3','h4','h5','h6','tr']);

/** Inert HTML text extraction shared by the dashboard and the bounded MCP preview. */
export function cardActivityPreview(activity:Activity, plainText=false):string {
 if(activity.format==='markdown'&&!plainText)return activity.body;
 const html=activity.format==='markdown'?marked.parse(activity.body,{async:false}):activity.body;
 const document=parse(html);
 function text(node:DefaultTreeAdapterTypes.Node):string {
  if(node.nodeName==='#text')return (node as DefaultTreeAdapterTypes.TextNode).value;
  if('tagName' in node && omitted.has(node.tagName))return '';
  const children='childNodes' in node?node.childNodes:[];
  return children.map(text).join('')+('tagName' in node&&blocks.has(node.tagName)?'\n':'');
 }
 return text(document).replace(/[^\S\n]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}
