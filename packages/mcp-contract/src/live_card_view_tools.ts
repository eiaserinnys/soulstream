import { z } from "zod";
import { previewSchema } from "../../soul-ui/src/cards/card-preview-schema.js";
import type { McpToolDefinition } from "./tool_definitions.js";
export const LIVE_CARD_RESOURCE = "ui://soulstream/live-cards-v4.html";
export type LiveCardQuery = { folder_id?: string; limit: number };
export const liveCardOutputSchema=z.object({
 cards:z.array(z.object({id:z.string(),title:z.string(),status:z.enum(["todo","queued","blocked","running","review","done","cancelled","unknown"]),assignee:z.string(),updatedAt:z.string().datetime().nullable(),preview:previewSchema.optional()}).strict()).max(100).optional(),
 total:z.number().int().nonnegative().optional(),
 truncated:z.boolean().optional(),
 sync:z.object({folderId:z.string().nullable(),limit:z.number().int().min(1).max(100),refreshSeconds:z.literal(30),fetchedAt:z.string().datetime()}).strict().optional(),
 syncError:z.object({authorization:z.boolean()}).strict().optional()
}).strict().superRefine((value,ctx)=>{
 const successFields=["cards","total","truncated","sync"] as const;
 const valid=value.syncError!==undefined?successFields.every(key=>value[key]===undefined):successFields.every(key=>value[key]!==undefined);
 if(!valid)ctx.addIssue({code:"custom",message:"Expected a complete success result or an exclusive syncError result"});
}).meta({anyOf:[{required:["cards","total","truncated","sync"],not:{required:["syncError"]}},{required:["syncError"],not:{anyOf:["cards","total","truncated","sync"].map(key=>({required:[key]}))}}]});

const inputSchema={folder_id:z.string().min(1).max(256).optional(),limit:z.number().int().min(1).max(100).default(100)};
const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
export const liveCardTools = {
  show_live_card_view: { name: "show_live_card_view", audience: "all", config: {title:"Soulstream 실시간 카드 보기",description:"현재 접근 가능한 실제 카드를 조회하고 동기화되는 읽기 전용 카드 화면을 연다. folder_id가 있으면 해당 폴더만 조회한다. 입력 카드 배열은 필요 없다.",inputSchema,outputSchema:liveCardOutputSchema,annotations,_meta:{ui:{resourceUri:LIVE_CARD_RESOURCE},"openai/outputTemplate":LIVE_CARD_RESOURCE}} },
  list_live_cards: { name: "list_live_cards", audience: "all", config: {title:"Soulstream 카드 새로고침",description:"현재 요청의 기존 Soulstream 권한으로 실제 카드를 다시 조회한다. 카드 화면의 읽기 전용 새로고침용이며 UI를 새로 열지 않는다.",inputSchema,outputSchema:liveCardOutputSchema,annotations,_meta:{ui:{visibility:["app","model"]},"openai/widgetAccessible":true}} },
} as const satisfies Record<string, McpToolDefinition>;
