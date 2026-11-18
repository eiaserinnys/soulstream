// @vitest-environment jsdom
import {renderToStaticMarkup} from "react-dom/server";
import {expect,it,vi} from "vitest";
import {CompletedCardCollection} from "./CompletedCardCollection";
import {reviewCard} from "./components-review-fixtures";
import type {CompletedBrowser} from "./use-completed-cards";

vi.mock("./CompletedCardGrid",()=>({CompletedCardGrid:()=>null}));

it("keeps the detail heading by default and offers the card home section heading",()=>{
 const browser={cards:[reviewCard],loaded:true} as CompletedBrowser;
 const element=document.createElement("div");
 element.innerHTML=renderToStaticMarkup(<CompletedCardCollection browser={browser} renderCard={()=>null}/>);
 expect(element.querySelector(".v3-detail-section-head > h3")?.textContent).toBe("완료");
 expect(element.querySelector(".v3-detail-section-head > span")?.textContent).toBe("1개 표시");
 element.innerHTML=renderToStaticMarkup(<CompletedCardCollection browser={browser} heading="section" renderCard={()=>null}/>);
 expect(element.querySelector(".v3-section-head > h2")?.textContent).toBe("완료");
 expect(element.querySelector(".v3-section-head > span")?.textContent).toBe("1개 표시");
});

it("hides the displayed count until the current query has loaded",()=>{
 const element=document.createElement("div");
 const browser={cards:[],loaded:false} as unknown as CompletedBrowser;
 for(const heading of ["detail","section"] as const){
  element.innerHTML=renderToStaticMarkup(<CompletedCardCollection browser={browser} heading={heading} renderCard={()=>null}/>);
  expect(element.textContent).not.toContain("0개 표시");
 }
});
