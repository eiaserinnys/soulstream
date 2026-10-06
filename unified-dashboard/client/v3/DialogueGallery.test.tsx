/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DialogueGallery } from "./DialogueGallery";
import { DialoguesReviewPage } from "./DialoguesReviewPage";
import { dialoguesInventory } from "./dialogues-inventory";
import { webDialogueGroups } from "./dialogues-gallery-groups";

vi.mock("./ComponentsReviewLayout", () => ({ ComponentsReviewLayout: ({children}: {children: ReactNode}) => <main>{children}</main> }));
vi.mock("./WorkspacePanelHeaders", () => ({ FolderPanelHeader: ({title}: {title: string}) => <header><h1>{title}</h1></header> }));
vi.mock("./DialoguesSamples", () => ({ DialoguesSamples: ({id, onClose}: {id: string; onClose(): void}) => <div data-sample={id}><button onClick={onClose}>취소</button></div> }));
vi.mock("@seosoyoung/soul-ui", () => ({
  Button: ({children, render, ...props}: any) => render ? <a {...render.props} {...props}>{children}</a> : <button {...props}>{children}</button>,
  DashboardIconCap: ({label, children, ...props}: any) => <button aria-label={label} {...props}>{children}</button>,
  Input: (props: any) => <input {...props}/>,
  LiquidGlassProvider: ({children}: {children: ReactNode}) => <>{children}</>,
  WallpaperLayer: () => null,
  initTheme: () => {},
}));
let root: Root, container: HTMLDivElement;
let observers: { callback: IntersectionObserverCallback; target?: Element }[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observers = [];
  vi.stubGlobal("IntersectionObserver", class {
    entry: typeof observers[number];
    constructor(callback: IntersectionObserverCallback) { this.entry = {callback}; observers.push(this.entry); }
    observe(target: Element) { this.entry.target = target; }
    disconnect() {}
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

it("covers all 53 actual variants exactly once in the requested shape groups", () => {
  const ids = webDialogueGroups.flatMap(group => group.ids);
  expect(ids).toHaveLength(53);
  expect(new Set(ids).size).toBe(53);
  expect([...ids].sort()).toEqual(dialoguesInventory.map(item => item.id).sort());
});
it("mounts actual iframe documents only at the visible boundary and searches names", async () => {
  await act(async () => root.render(<DialogueGallery platform="web" description="실제 창" groups={[{id:"create", title:"생성", items:[{id:"one",title:"새 폴더",src:"/dialogues?sample=project-create"},{id:"two",title:"새 카드",src:"/dialogues?sample=card-create"}]}]}/>));
  expect(container.querySelector("iframe")).toBeNull();
  await act(async () => observers[0].callback([{isIntersecting:true} as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(container.querySelectorAll("iframe")).toHaveLength(1);
  expect(container.querySelector("iframe")?.title).toBe("새 폴더");
  await act(async () => observers[0].callback([{isIntersecting:false} as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(container.querySelector("iframe")).toBeNull();
  const input = container.querySelector("input")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "카드"); input.dispatchEvent(new Event("input", {bubbles:true})); });
  expect(container.querySelectorAll("[data-dialogue]")).toHaveLength(1);
  expect(container.textContent).toContain("새 카드");
});
it("renders one auto-open sample without recursively mounting the gallery, then reopens locally", async () => {
  window.history.replaceState(null, "", "/dialogues?sample=project-create");
  await act(async () => root.render(<DialoguesReviewPage/>));
  expect(container.querySelector('[data-sample="project-create"]')).not.toBeNull();
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.querySelector('[data-testid="dialogues-review"]')).toBeNull();
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("[data-sample]")).toBeNull();
  expect(container.textContent).toContain("다시 열기");
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("[data-sample]")).not.toBeNull();
});
it("keeps device-only descriptions folded without a dead open button", async () => {
  await act(async () => root.render(<DialogueGallery platform="ios" description="iOS" groups={[{id:"native", title:"기기 전용", items:[{id:"alert",title:"Alert",description:"기기에서 확인합니다."}]}]}/>));
  const details = container.querySelector("details");
  expect(details).not.toBeNull();
  expect(details?.open).toBe(false);
  expect(container.querySelector("summary")?.textContent).toBe("기기 전용 안내");
  expect(container.querySelector("button")).toBeNull();
});
it("adds embedded only to the preview document and keeps the original new-tab URL", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await act(async () => root.render(<DialogueGallery platform="web" description="창" groups={[{id:"create",title:"생성",items:[{id:"folder",title:"새 폴더",src:"/dialogues?sample=project-create"}]}]}/>));
  await act(async () => observers[0].callback([{isIntersecting:true} as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(container.querySelector("iframe")?.getAttribute("src")).toBe("/dialogues?sample=project-create&embedded=1");
  await act(async () => container.querySelector("button")!.click());
  expect(open).toHaveBeenCalledWith("/dialogues?sample=project-create", "_blank", "noopener,noreferrer");
  open.mockRestore();
});
