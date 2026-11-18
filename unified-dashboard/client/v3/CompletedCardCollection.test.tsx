// @vitest-environment jsdom
import {renderToStaticMarkup} from "react-dom/server";
import {expect,it,vi} from "vitest";
import {CompletedCardCollection} from "./CompletedCardCollection";
import {reviewCard} from "./components-review-fixtures";
import type {CompletedBrowser} from "./use-completed-cards";

vi.mock("./CompletedCardGrid",()=>({CompletedCardGrid:()=>null}));

it("keeps the detail heading by default and offers the card home section heading",()=>{
 const browser={cards:[reviewCard]} as CompletedBrowser;
 const element=document.createElement("div");
 element.innerHTML=renderToStaticMarkup(<CompletedCardCollection browser={browser} renderCard={()=>null}/>);
 expect(element.querySelector(".v3-detail-section-head > h3")?.textContent).toBe("완료");
 expect(element.querySelector(".v3-detail-section-head > span")?.textContent).toBe("1개 표시");
 element.innerHTML=renderToStaticMarkup(<CompletedCardCollection browser={browser} heading="section" renderCard={()=>null}/>);
 expect(element.querySelector(".v3-section-head > h2")?.textContent).toBe("완료");
 expect(element.querySelector(".v3-section-head > span")?.textContent).toBe("1개 표시");
});
