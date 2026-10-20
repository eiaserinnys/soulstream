import type { CSSProperties, ReactNode } from "react";

export function UsageShareRow({
  name,
  value,
  share,
  color,
  secondary,
  showShareColumn = true,
  onClick,
}: {
  name: string;
  value: ReactNode;
  share: number | null;
  color?: string;
  secondary?: string;
  showShareColumn?: boolean;
  onClick?: () => void;
}) {
  const style = color ? { "--usage-stats-row-color": color } as CSSProperties : undefined;
  const content = <>
    <span className="usage-stats-share-head">
      <span className="usage-stats-share-name" title={name}>{name}</span>
      <span className="usage-stats-share-value">{value}</span>
      {showShareColumn ? <span className="usage-stats-share-percent">{share === null ? "" : `${Math.round(share * 100)}%`}</span> : null}
    </span>
    {share !== null ? <span className="usage-stats-share-track" aria-hidden="true">
      <span className="usage-stats-share-fill" style={{ width: `${Math.max(0, Math.min(100, share * 100))}%` }} />
    </span> : null}
    {secondary ? <span className="usage-stats-share-secondary">{secondary}</span> : null}
  </>;

  return onClick ? (
    <button type="button" className="usage-stats-share-row usage-stats-share-row-clickable" style={style} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="usage-stats-share-row" style={style}>
      {content}
    </div>
  );
}
