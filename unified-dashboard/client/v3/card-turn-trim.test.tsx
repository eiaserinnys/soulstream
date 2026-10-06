import {renderToStaticMarkup} from "react-dom/server";
import {expect,it} from "vitest";
import {PostItCardView} from "./PostItCard";
import {CardRowView as CardRow} from "./CardRow";
import {reviewCard,reviewCardItems,reviewNow} from "./components-review-fixtures";
const card={...reviewCard,items:reviewCardItems.map(item=>({...item,display:"todo" as const})),now:{...reviewNow,turn:"user" as const,ask:"질문에 답해 주세요"}};
it("shows ask alone when the user has no results to review on both list surfaces",()=>{
 const post=renderToStaticMarkup(<PostItCardView card={card} activity={null} onOpen={()=>{}}/>);
 const row=renderToStaticMarkup(<CardRow card={card} onOpen={()=>{}}/>);
 for(const html of [post,row]){expect(html).not.toContain("볼 것 0");expect(html).toContain("질문에 답해 주세요");}
 expect(post).not.toContain("확인 0");
});
it("omits an empty user turn strip",()=>{
 const value={...card,now:{...card.now,ask:""}};
 const post=renderToStaticMarkup(<PostItCardView card={value} activity={null} onOpen={()=>{}}/>);
 const row=renderToStaticMarkup(<CardRow card={value} onOpen={()=>{}}/>);
 expect(post).not.toContain('class="v3-postit-turn"');expect(row).not.toContain('class="v3-run-card-turn"');
 expect(row).not.toContain("볼 것 0");
});
