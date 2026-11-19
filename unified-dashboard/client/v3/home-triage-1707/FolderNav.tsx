// 왼쪽 폴더 내비게이션. 운영 .v3-navigation 과 같은 유리 패널, 같은 행 밀도를 쓴다.
import { mockupFolders } from "./triage-data";

const STARRED = ["soulstream", "kaleidoscope", "pages"] as const;

export function FolderNav({ folder, onSelect }: { folder: string | null; onSelect(id: string | null): void }) {
  const row = (id: string, starred: boolean) => {
    const entry = mockupFolders.find(item => item.id === id);
    if (!entry) return null;
    return (
      <button
        key={id}
        type="button"
        className="v3-ht-nav-row"
        data-active={folder === id}
        aria-pressed={folder === id}
        onClick={() => onSelect(folder === id ? null : id)}
      >
        <span className="v3-ht-nav-name">{entry.name}</span>
        {starred ? <span className="v3-ht-nav-star" aria-hidden="true">★</span> : null}
        <span className="v3-ht-nav-count">{entry.count}</span>
      </button>
    );
  };

  return (
    <aside className="v3-ht-pane v3-ht-nav glass-strong glass-chrome lg-rim border border-glass-border" aria-label="폴더">
      <header className="v3-ht-nav-head">
        <h2>폴더</h2>
      </header>
      <div className="v3-ht-nav-scroll">
        <section className="v3-ht-nav-group">
          <p className="v3-ht-nav-label">날짜</p>
          <button
            type="button"
            className="v3-ht-nav-row"
            data-active={folder === null}
            aria-pressed={folder === null}
            onClick={() => onSelect(null)}
          >
            <span className="v3-ht-nav-name">전체 카드</span>
            <span className="v3-ht-nav-count">45</span>
          </button>
          <div className="v3-ht-nav-row v3-ht-nav-row--static">
            <span className="v3-ht-nav-name">오늘, 11월 19일</span>
            <span className="v3-ht-nav-count">7</span>
          </div>
          <div className="v3-ht-nav-row v3-ht-nav-row--static">
            <span className="v3-ht-nav-name">어제, 11월 18일</span>
            <span className="v3-ht-nav-count">9</span>
          </div>
        </section>
        <section className="v3-ht-nav-group">
          <p className="v3-ht-nav-label">별표 폴더</p>
          {STARRED.map(id => row(id, true))}
        </section>
        <section className="v3-ht-nav-group">
          <p className="v3-ht-nav-label">모든 폴더</p>
          {mockupFolders.map(entry => row(entry.id, false))}
        </section>
      </div>
    </aside>
  );
}
