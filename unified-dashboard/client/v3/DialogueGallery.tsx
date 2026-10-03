import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button, DashboardIconCap, Input } from "@seosoyoung/soul-ui";
import { Maximize2 } from "lucide-react";
import { ComponentsReviewLayout } from "./ComponentsReviewLayout";
import { FolderPanelHeader } from "./WorkspacePanelHeaders";
import "./dialogue-gallery.css";

export type DialogueGalleryItem = {
  id: string;
  title: string;
  src?: string;
  onOpen?: () => void;
  description?: string;
  mobile?: boolean;
};
export type DialogueGalleryGroup = { id: string; title: string; items: DialogueGalleryItem[] };

export function DialogueGallery({ platform, groups, description }: {
  platform: "web" | "ios";
  groups: DialogueGalleryGroup[];
  description: string;
}) {
  const [query, setQuery] = useState("");
  const filtered = groups.map(group => ({ ...group, items: group.items.filter(item =>
    `${item.title} ${item.description ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  ) })).filter(group => group.items.length > 0);
  return <ComponentsReviewLayout syncPreferences={false}>
    <article className="v3-detail-pane v3-detail-pane--inline v3-dialogue-gallery" data-testid="dialogues-review">
      <FolderPanelHeader title="다이얼로그 비교" inline backLabel="컴포넌트 검수로 돌아가기"
        onBack={() => window.location.assign("/components")} onRename={async () => {}} actions={null}/>
      <div className="v3-detail-scroll v3-dialogue-gallery-content">
        <nav className="v3-dialogue-links" aria-label="검수 화면">
          <Button variant="link" render={<a href="/dialogues" aria-current={platform === "web" ? "page" : undefined}/>}>웹</Button>
          <Button variant="link" render={<a href="/dialogues/ios" aria-current={platform === "ios" ? "page" : undefined}/>}>iOS</Button>
          <Button variant="link" render={<a href="/components"/>}>컴포넌트 검수</Button>
        </nav>
        <div className="v3-dialogue-search">
          <Input aria-label="다이얼로그 이름 검색" placeholder="다이얼로그 이름 검색" value={query}
            onChange={event => setQuery(event.target.value)}/>
          <p className="v3-components-label">{description}</p>
        </div>
        {filtered.map(group => <section className="v3-dialogue-group" key={group.id} aria-labelledby={`dialogue-group-${group.id}`}>
          <h2 id={`dialogue-group-${group.id}`}>{group.title}</h2>
          <div className="v3-dialogue-rail" data-rail={group.id}>
            {group.items.map(item => <DialoguePreview key={item.id} item={item}/>)}
          </div>
        </section>)}
        {filtered.length === 0 ? <p role="status" className="v3-components-label">검색 결과가 없습니다.</p> : null}
      </div>
    </article>
  </ComponentsReviewLayout>;
}

function DialoguePreview({ item }: { item: DialogueGalleryItem }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!item.src || !ref.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [item.src]);
  // This is viewport metadata for the actual phone branch, not a scaled UI or button size.
  const viewport = item.mobile ? { "--dialogue-viewport-width": "390px" } as CSSProperties : undefined;
  return <div ref={ref} className="v3-dialogue-cell" style={viewport} data-dialogue={item.id}>
    <div className="v3-dialogue-cell-head">
      <h3>{item.title}</h3>
      {item.src ? <DashboardIconCap label={`${item.title} 새 탭에서 확대`}
        onClick={() => window.open(item.src, "_blank", "noopener,noreferrer")}>
        <Maximize2 className="h-4 w-4" aria-hidden="true"/>
      </DashboardIconCap> : null}
    </div>
    {item.src ? <div className="v3-dialogue-preview">
      {visible ? <iframe src={item.src} title={item.title}/> : null}
    </div> : item.onOpen ? <div className="v3-dialogue-native">
      <p className="v3-components-label">{item.description}</p>
      <Button variant="outline" onClick={item.onOpen}>확인창 열기</Button>
    </div> : <details className="v3-dialogue-native">
      <summary>기기 전용 안내</summary>
      <p className="v3-components-label">{item.description}</p>
    </details>}
  </div>;
}
